import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { systemActor } from "../../src/permissions/executionActor.js";
import {
  attachMissionRunTaskPlan,
  appendMissionStepLinks,
  createMissionRun,
  getMissionDefinition,
  getMissionRun,
  getMissionRunByTaskPlan,
  listMissionDefinitions,
  listMissionRuns,
  MissionStoreError,
  saveMissionDefinition,
  setMissionDefinitionEnabled,
  transitionMissionRun,
} from "../../src/missions/store.js";
import { createTaskPlan } from "../../src/tasks/store.js";
import {
  createConstructionJob,
  fingerprintBlueprintExecution,
  markConstructionPlan,
  registerCompiledBlueprint,
  upsertBlueprint,
  type BlueprintRow,
} from "../../src/construction/store.js";
import {
  canonicalizeBuildSource,
  hashBuildSource,
} from "../../src/construction/buildOps/compiler.js";
import { parseBuildSource } from "../../src/construction/buildOps/schema.js";
import {
  MISSION_EXPANDED_TASKS_METADATA_KEY,
  MISSION_NAMED_BLUEPRINT_FINGERPRINT_METADATA_KEY,
} from "../../src/missions/types.js";

let tmp: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-missions-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function mission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "smartbot.mission/v1",
    name: "tower-repair",
    limits: {
      maxLogicalSteps: 2,
      maxExpandedSteps: 4,
      maxWorldChanges: 128,
      maxRuntimeMinutes: 10,
    },
    steps: [
      { id: "survey", op: "skill", skill: "surveyArea", params: { radius: 8 }, maxAttempts: 2 },
      { id: "remove", op: "clear", from: [0, 64, 0], to: [1, 65, 1] },
    ],
    ...overrides,
  };
}

function buildMission(): Record<string, unknown> {
  return {
    schema: "smartbot.mission/v1",
    name: "build-tower",
    limits: {
      maxLogicalSteps: 1,
      maxExpandedSteps: 2,
      maxWorldChanges: 8,
      maxRuntimeMinutes: 10,
    },
    steps: [{
      id: "build", op: "build", blueprintName: "tower", origin: [0, 64, 0],
    }],
  };
}

function inlineBuildSource(name = "inline-tower"): Record<string, unknown> {
  return {
    schema: "smartbot.build/v1",
    name,
    targetVersion: "1.21.4",
    ops: [{ op: "put", at: [0, 0, 0], block: "stone" }],
  };
}

function inlineBuildMission(definition = inlineBuildSource()): Record<string, unknown> {
  return {
    schema: "smartbot.mission/v1",
    name: "inline-build",
    limits: {
      maxLogicalSteps: 1,
      maxExpandedSteps: 2,
      maxWorldChanges: 8,
      maxRuntimeMinutes: 10,
    },
    steps: [{ id: "build", op: "build", definition, origin: [0, 64, 0] }],
  };
}

const owner = systemActor("Owner", "recovery");

function resolvedTask(
  skill: string,
  params: Record<string, unknown>,
  maxAttempts = 3,
): Record<string, unknown> {
  return { skill, params, maxAttempts };
}

function resolvedExpansion(...tasks: Record<string, unknown>[]): Record<string, unknown> {
  return { [MISSION_EXPANDED_TASKS_METADATA_KEY]: tasks };
}

function namedBuildExpansion(
  blueprint: BlueprintRow,
  jobId: number,
): Record<string, unknown> {
  return {
    ...resolvedExpansion(
      resolvedTask("prepareBlueprintMaterials", { jobId }),
      resolvedTask("buildBlueprint", { jobId }),
    ),
    [MISSION_NAMED_BLUEPRINT_FINGERPRINT_METADATA_KEY]: fingerprintBlueprintExecution(blueprint, null),
  };
}

const surveyExpansion = resolvedExpansion(resolvedTask("surveyArea", { radius: 8 }, 2));
const clearExpansion = resolvedExpansion(resolvedTask("clearRegion", {
  from: { x: 0, y: 64, z: 0 },
  to: { x: 1, y: 65, z: 1 },
  includeContainers: false,
}, 3));

describe("mission store", () => {
  it("validates, canonically saves, and explicitly replaces named definitions", () => {
    const saved = saveMissionDefinition(db, { definition: mission(), creator: owner }, 100);
    expect(saved).toMatchObject({
      name: "tower-repair",
      schema: "smartbot.mission/v1",
      creator: { username: "Owner", source: "recovery" },
      enabled: true,
    });
    expect(saved.sourceJson).toContain("maxLogicalSteps");
    expect(saved.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.definition.steps).toHaveLength(2);

    expect(() => saveMissionDefinition(db, {
      definition: mission(), creator: owner,
    }, 101)).toThrow(expect.objectContaining({ code: "NAME_CONFLICT" }));
    expect(() => saveMissionDefinition(db, {
      definition: mission(), creator: owner, replace: "yes" as never,
    }, 101)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const changed = mission({
      steps: [{ id: "survey", op: "skill", skill: "surveyArea", params: { radius: 16 } }],
      limits: { maxLogicalSteps: 1, maxExpandedSteps: 1, maxWorldChanges: 1, maxRuntimeMinutes: 1 },
    });
    const replaced = saveMissionDefinition(db, {
      definition: changed, creator: owner, replace: true, enabled: false,
    }, 102);
    expect(replaced.id).toBe(saved.id);
    expect(replaced.tsCreated).toBe(100);
    expect(replaced.tsUpdated).toBe(102);
    expect(replaced.sourceHash).not.toBe(saved.sourceHash);
    expect(replaced.enabled).toBe(false);
    expect(getMissionDefinition(db, saved.id)?.definition.steps).toHaveLength(1);
  });

  it("captures a named definition immutably for a run even after replacement", () => {
    const saved = saveMissionDefinition(db, { definition: mission(), creator: owner }, 100);
    const run = createMissionRun(db, {
      definitionId: saved.id,
      actor: { username: "Builder", role: "operator", source: "minecraft-chat" },
      compileReport: { logicalStepCount: 2, warnings: [] },
      transactionCorrelation: { request: "abc" },
    }, 1_000);
    expect(run).toMatchObject({
      definitionId: saved.id,
      actor: { username: "Builder", role: "operator", source: "minecraft-chat" },
      status: "pending",
      transactionScope: `mission:${run.id}`,
      transactionCorrelation: { request: "abc" },
      deadlineAt: 601_000,
    });
    expect(run.sourceHash).toBe(saved.sourceHash);

    const replacement = mission({
      steps: [{ id: "changed", op: "skill", skill: "surveyArea", params: {} }],
      limits: { maxLogicalSteps: 1, maxExpandedSteps: 1, maxWorldChanges: 1, maxRuntimeMinutes: 1 },
    });
    saveMissionDefinition(db, { definition: replacement, creator: owner, replace: true }, 2_000);

    const reread = getMissionRun(db, run.id)!;
    expect(reread.sourceJson).toBe(run.sourceJson);
    expect(reread.sourceHash).toBe(run.sourceHash);
    expect(JSON.parse(reread.sourceJson).steps[0].id).toBe("survey");
  });

  it("refuses disabled or mismatched saved sources and permits independent ad-hoc runs", () => {
    const saved = saveMissionDefinition(db, { definition: mission(), creator: owner, enabled: false }, 100);
    expect(() => createMissionRun(db, { definitionId: saved.id, actor: owner }, 200))
      .toThrow(expect.objectContaining({ code: "IMMUTABLE" }));
    setMissionDefinitionEnabled(db, saved.id, true, 201);

    expect(() => createMissionRun(db, {
      definitionId: saved.id,
      definition: mission({ name: "different" }),
      actor: owner,
    }, 202)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const adHoc = createMissionRun(db, {
      definition: mission({ name: "temporary" }),
      actor: owner,
      deadlineAt: 500,
    }, 300);
    expect(adHoc).toMatchObject({ definitionId: null, transactionScope: `mission:${adHoc.id}` });
    expect(() => createMissionRun(db, {
      definition: mission({ name: "too-long" }), actor: owner, deadlineAt: 600_301,
    }, 300)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("records a complete ordered logical-to-expanded mapping exactly once", () => {
    const definition = saveMissionDefinition(db, { definition: mission(), creator: owner }, 100);
    const run = createMissionRun(db, { definitionId: definition.id, actor: owner }, 200);
    const linked = appendMissionStepLinks(db, run.id, [
      {
        logicalStepId: "survey", logicalPosition: 0,
        expandedStartPosition: 0, expandedStepCount: 1,
        compileMetadata: surveyExpansion,
      },
      {
        logicalStepId: "remove", logicalPosition: 1,
        expandedStartPosition: 1, expandedStepCount: 1,
        compileMetadata: { ...clearExpansion, estimatedWorldChanges: 8 },
      },
    ], 300);
    expect(linked.stepLinks).toEqual([
      expect.objectContaining({ logicalStepId: "survey", logicalPosition: 0, expandedStartPosition: 0 }),
      expect.objectContaining({ logicalStepId: "remove", logicalPosition: 1, expandedStartPosition: 1 }),
    ]);
    expect(linked.stepLinks[0]?.compileMetadata).toEqual(surveyExpansion);

    expect(() => appendMissionStepLinks(db, run.id, [
      {
        logicalStepId: "survey", logicalPosition: 0,
        expandedStartPosition: 0, expandedStepCount: 1, compileMetadata: surveyExpansion,
      },
      {
        logicalStepId: "remove", logicalPosition: 1,
        expandedStartPosition: 1, expandedStepCount: 1, compileMetadata: clearExpansion,
      },
    ])).toThrow(expect.objectContaining({ code: "IMMUTABLE" }));
  });

  it("rejects out-of-order, incomplete, overlapping, and over-limit link mappings", () => {
    const definition = saveMissionDefinition(db, { definition: mission(), creator: owner }, 100);
    const makeRun = () => createMissionRun(db, { definitionId: definition.id, actor: owner }, Date.now());
    expect(() => appendMissionStepLinks(db, makeRun().id, [
      {
        logicalStepId: "remove", logicalPosition: 0,
        expandedStartPosition: 0, expandedStepCount: 1, compileMetadata: clearExpansion,
      },
      {
        logicalStepId: "survey", logicalPosition: 1,
        expandedStartPosition: 1, expandedStepCount: 1, compileMetadata: surveyExpansion,
      },
    ])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => appendMissionStepLinks(db, makeRun().id, [
      {
        logicalStepId: "survey", logicalPosition: 0,
        expandedStartPosition: 1, expandedStepCount: 1, compileMetadata: surveyExpansion,
      },
      {
        logicalStepId: "remove", logicalPosition: 1,
        expandedStartPosition: 2, expandedStepCount: 1, compileMetadata: clearExpansion,
      },
    ])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => appendMissionStepLinks(db, makeRun().id, [
      {
        logicalStepId: "survey", logicalPosition: 0,
        expandedStartPosition: 0, expandedStepCount: 4, compileMetadata: surveyExpansion,
      },
      {
        logicalStepId: "remove", logicalPosition: 1,
        expandedStartPosition: 4, expandedStepCount: 1, compileMetadata: clearExpansion,
      },
    ])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("allows only explicit directed run status transitions", () => {
    const run = createMissionRun(db, { definition: mission(), actor: owner }, 100);
    expect(() => transitionMissionRun(db, run.id, "running", {}, 105))
      .toThrow(expect.objectContaining({ code: "IMMUTABLE" }));
    expect(transitionMissionRun(db, run.id, "paused", {}, 110)).toMatchObject({ status: "paused" });
    expect(transitionMissionRun(db, run.id, "pending", {}, 120)).toMatchObject({ status: "pending" });
    const plan = createTaskPlan(db, {
      title: "materialized mission",
      steps: [
        { skill: "surveyArea", params: { radius: 8 }, maxAttempts: 2 },
        {
          skill: "clearRegion",
          params: {
            from: { x: 0, y: 64, z: 0 },
            to: { x: 1, y: 65, z: 1 },
            includeContainers: false,
          },
          maxAttempts: 3,
        },
      ],
      actor: owner,
    });
    attachMissionRunTaskPlan(db, run.id, plan.id, 125);
    appendMissionStepLinks(db, run.id, [
      {
        logicalStepId: "survey", logicalPosition: 0,
        expandedStartPosition: 0, expandedStepCount: 1, compileMetadata: surveyExpansion,
      },
      {
        logicalStepId: "remove", logicalPosition: 1,
        expandedStartPosition: 1, expandedStepCount: 1, compileMetadata: clearExpansion,
      },
    ], 126);
    const running = transitionMissionRun(db, run.id, "running", {}, 130)!;
    expect(running.tsStarted).toBe(130);
    const done = transitionMissionRun(db, run.id, "completed", {}, 140)!;
    expect(done).toMatchObject({ status: "completed", tsStarted: 130, tsFinished: 140, lastError: null });
    expect(() => transitionMissionRun(db, run.id, "running", {}, 150))
      .toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));

    const failedEarly = createMissionRun(db, { definition: mission(), actor: owner }, 200);
    expect(transitionMissionRun(db, failedEarly.id, "failed", { error: "invalid site" }, 210))
      .toMatchObject({ status: "failed", tsStarted: null, tsFinished: 210, lastError: "invalid site" });
  });

  it("links one pending run to one task plan exactly once before it can start", () => {
    const definition = saveMissionDefinition(db, { definition: mission(), creator: owner }, 100);
    const first = createMissionRun(db, { definitionId: definition.id, actor: owner }, 110);
    const second = createMissionRun(db, { definitionId: definition.id, actor: owner }, 120);
    const plan = createTaskPlan(db, {
      title: "one mission plan", steps: [{ skill: "surveyArea", params: {} }], actor: owner,
    });
    const linked = attachMissionRunTaskPlan(db, first.id, plan.id, 130)!;
    expect(linked.taskPlanId).toBe(plan.id);
    expect(getMissionRunByTaskPlan(db, plan.id)?.id).toBe(first.id);
    expect(() => attachMissionRunTaskPlan(db, first.id, plan.id, 131))
      .toThrow(expect.objectContaining({ code: "IMMUTABLE" }));
    expect(() => attachMissionRunTaskPlan(db, second.id, plan.id, 132))
      .toThrow(expect.objectContaining({ code: "PERSISTENCE_FAILED" }));
    expect(() => attachMissionRunTaskPlan(db, second.id, 999, 133))
      .toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("requires each build link to own one durable construction job and validates it against the plan", () => {
    const definition = saveMissionDefinition(db, { definition: buildMission(), creator: owner }, 100);
    const missing = createMissionRun(db, { definitionId: definition.id, actor: owner }, 110);
    expect(() => appendMissionStepLinks(db, missing.id, [{
      logicalStepId: "build", logicalPosition: 0, expandedStartPosition: 0, expandedStepCount: 2,
      compileMetadata: resolvedExpansion(
        resolvedTask("prepareBlueprintMaterials", { jobId: 1 }),
        resolvedTask("buildBlueprint", { jobId: 1 }),
      ),
    }])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const blueprint = upsertBlueprint(db, {
      name: "tower", blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id, originX: 0, originY: 64, originZ: 0,
    });
    const run = createMissionRun(db, { definitionId: definition.id, actor: owner }, 120);
    appendMissionStepLinks(db, run.id, [{
      logicalStepId: "build", logicalPosition: 0, expandedStartPosition: 0, expandedStepCount: 2,
      constructionJobId: job.id,
      compileMetadata: namedBuildExpansion(blueprint, job.id),
    }], 121);
    const plan = createTaskPlan(db, {
      title: "build tower mission",
      steps: [
        { skill: "prepareBlueprintMaterials", params: { jobId: job.id } },
        { skill: "buildBlueprint", params: { jobId: job.id } },
      ],
      actor: owner,
    });
    attachMissionRunTaskPlan(db, run.id, plan.id, 122);
    expect(() => transitionMissionRun(db, run.id, "running", {}, 123))
      .toThrow(expect.objectContaining({ code: "PERSISTENCE_FAILED" }));
    expect(markConstructionPlan(db, job.id, plan.id, 124)).toBe(true);
    expect(transitionMissionRun(db, run.id, "running", {}, 125)).toMatchObject({ status: "running" });

    const retryJob = createConstructionJob(db, {
      blueprintId: blueprint.id, originX: 0, originY: 64, originZ: 0,
    });
    const retryRun = createMissionRun(db, { definitionId: definition.id, actor: owner }, 126);
    appendMissionStepLinks(db, retryRun.id, [{
      logicalStepId: "build", logicalPosition: 0, expandedStartPosition: 0, expandedStepCount: 2,
      constructionJobId: retryJob.id,
      compileMetadata: namedBuildExpansion(blueprint, retryJob.id),
    }], 127);
    const excessiveRetries = createTaskPlan(db, {
      title: "invalid build retries",
      steps: [
        { skill: "prepareBlueprintMaterials", params: { jobId: retryJob.id }, maxAttempts: 9 },
        { skill: "buildBlueprint", params: { jobId: retryJob.id }, maxAttempts: 9 },
      ],
      actor: owner,
    });
    attachMissionRunTaskPlan(db, retryRun.id, excessiveRetries.id, 128);
    expect(markConstructionPlan(db, retryJob.id, excessiveRetries.id, 129)).toBe(true);
    expect(() => transitionMissionRun(db, retryRun.id, "running", {}, 130))
      .toThrow(expect.objectContaining({ code: "PERSISTENCE_FAILED" }));

    const ordinary = createMissionRun(db, { definition: mission({ name: "ordinary" }), actor: owner }, 131);
    expect(() => appendMissionStepLinks(db, ordinary.id, [
      {
        logicalStepId: "survey", logicalPosition: 0, expandedStartPosition: 0,
        expandedStepCount: 1, constructionJobId: job.id, compileMetadata: surveyExpansion,
      },
      {
        logicalStepId: "remove", logicalPosition: 1,
        expandedStartPosition: 1, expandedStepCount: 1, compileMetadata: clearExpansion,
      },
    ])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("fails closed when a construction job does not represent the immutable build source", () => {
    const namedDefinition = saveMissionDefinition(db, { definition: buildMission(), creator: owner }, 100);
    const wrongBlueprint = upsertBlueprint(db, {
      name: "not-tower", blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const wrongJob = createConstructionJob(db, {
      blueprintId: wrongBlueprint.id, originX: 999, originY: 64, originZ: 999, rotation: 90,
    });
    const namedRun = createMissionRun(db, { definitionId: namedDefinition.id, actor: owner }, 110);
    expect(() => appendMissionStepLinks(db, namedRun.id, [{
      logicalStepId: "build", logicalPosition: 0, expandedStartPosition: 0, expandedStepCount: 2,
      constructionJobId: wrongJob.id,
      compileMetadata: resolvedExpansion(
        resolvedTask("prepareBlueprintMaterials", { jobId: wrongJob.id }),
        resolvedTask("buildBlueprint", { jobId: wrongJob.id }),
      ),
    }])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const inlineSource = parseBuildSource(inlineBuildSource());
    const compiled = registerCompiledBlueprint(db, {
      name: "inline-tower",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
      sourceSchema: inlineSource.schema,
      targetVersion: inlineSource.targetVersion,
      sourceJson: canonicalizeBuildSource(inlineSource),
      sourceHash: hashBuildSource(inlineSource),
      compileReportJson: "{}",
      creator: owner,
    });
    const matchingJob = createConstructionJob(db, {
      blueprintId: compiled.id, originX: 0, originY: 64, originZ: 0,
    });
    const inlineRun = createMissionRun(db, {
      definition: inlineBuildMission(inlineSource), actor: owner,
    }, 120);
    expect(appendMissionStepLinks(db, inlineRun.id, [{
      logicalStepId: "build", logicalPosition: 0, expandedStartPosition: 0, expandedStepCount: 2,
      constructionJobId: matchingJob.id,
      compileMetadata: resolvedExpansion(
        resolvedTask("prepareBlueprintMaterials", { jobId: matchingJob.id }),
        resolvedTask("buildBlueprint", { jobId: matchingJob.id }),
      ),
    }])).toHaveProperty("stepLinks.length", 1);

    const tampered = registerCompiledBlueprint(db, {
      name: "tampered-inline",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
      sourceSchema: inlineSource.schema,
      targetVersion: inlineSource.targetVersion,
      sourceJson: canonicalizeBuildSource(inlineSource),
      sourceHash: "0".repeat(64),
      compileReportJson: "{}",
      creator: owner,
    });
    const tamperedJob = createConstructionJob(db, {
      blueprintId: tampered.id, originX: 0, originY: 64, originZ: 0,
    });
    const tamperedRun = createMissionRun(db, {
      definition: inlineBuildMission(inlineSource), actor: owner,
    }, 130);
    expect(() => appendMissionStepLinks(db, tamperedRun.id, [{
      logicalStepId: "build", logicalPosition: 0, expandedStartPosition: 0, expandedStepCount: 2,
      constructionJobId: tamperedJob.id,
      compileMetadata: resolvedExpansion(
        resolvedTask("prepareBlueprintMaterials", { jobId: tamperedJob.id }),
        resolvedTask("buildBlueprint", { jobId: tamperedJob.id }),
      ),
    }])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("uses immutable compiler-resolved task metadata so skill defaults cannot change a run mapping", () => {
    const definition = saveMissionDefinition(db, {
      definition: mission({
        name: "defaulted-survey",
        limits: { maxLogicalSteps: 1, maxExpandedSteps: 1, maxWorldChanges: 1, maxRuntimeMinutes: 10 },
        steps: [{
          id: "survey", op: "skill", skill: "surveyArea",
          params: { centerX: 1, centerY: 64, centerZ: 1 }, maxAttempts: 2,
        }],
      }),
      creator: owner,
    }, 100);
    const run = createMissionRun(db, { definitionId: definition.id, actor: owner }, 110);
    const resolved = resolvedExpansion(resolvedTask("surveyArea", {
      centerX: 1, centerY: 64, centerZ: 1, dimension: "overworld", radius: 16,
    }, 2));
    appendMissionStepLinks(db, run.id, [{
      logicalStepId: "survey", logicalPosition: 0, expandedStartPosition: 0, expandedStepCount: 1,
      compileMetadata: resolved,
    }], 111);
    const plan = createTaskPlan(db, {
      title: "defaulted survey mission",
      steps: [{
        skill: "surveyArea",
        params: { centerX: 1, centerY: 64, centerZ: 1, dimension: "overworld", radius: 16 },
        maxAttempts: 2,
      }],
      actor: owner,
    });
    attachMissionRunTaskPlan(db, run.id, plan.id, 112);
    expect(transitionMissionRun(db, run.id, "running", {}, 113)).toMatchObject({ status: "running" });
  });

  it("fails closed when an expanded task plan does not match the immutable logical source", () => {
    const definition = saveMissionDefinition(db, { definition: mission({ name: "mapping-check" }), creator: owner }, 100);
    const run = createMissionRun(db, { definitionId: definition.id, actor: owner }, 110);
    appendMissionStepLinks(db, run.id, [
      {
        logicalStepId: "survey", logicalPosition: 0,
        expandedStartPosition: 0, expandedStepCount: 1, compileMetadata: surveyExpansion,
      },
      {
        logicalStepId: "remove", logicalPosition: 1,
        expandedStartPosition: 1, expandedStepCount: 1, compileMetadata: clearExpansion,
      },
    ]);
    const mismatched = createTaskPlan(db, {
      title: "wrong mission tasks",
      steps: [
        {
          skill: "clearRegion",
          params: {
            from: { x: 0, y: 64, z: 0 },
            to: { x: 1, y: 65, z: 1 },
            includeContainers: false,
          },
          maxAttempts: 2,
        },
        { skill: "surveyArea", params: { radius: 8 }, maxAttempts: 3 },
      ],
      actor: owner,
    });
    attachMissionRunTaskPlan(db, run.id, mismatched.id, 120);
    expect(() => transitionMissionRun(db, run.id, "running", {}, 121))
      .toThrow(expect.objectContaining({ code: "PERSISTENCE_FAILED" }));
  });

  it("returns bounded source-free lists and fails closed on corrupt persisted source", () => {
    const first = saveMissionDefinition(db, { definition: mission({ name: "zeta" }), creator: owner }, 10);
    saveMissionDefinition(db, { definition: mission({ name: "alpha" }), creator: owner }, 20);
    const definitions = listMissionDefinitions(db, { limit: 2 });
    expect(definitions.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
    expect(definitions[0]).not.toHaveProperty("sourceJson");
    expect(() => listMissionDefinitions(db, { limit: 101 })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const run = createMissionRun(db, { definitionId: first.id, actor: owner }, 100);
    const listed = listMissionRuns(db, { definitionId: first.id });
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("sourceJson");

    db.prepare("UPDATE mission_definitions SET source_json = ? WHERE id = ?")
      .run("{bad", first.id);
    expect(() => getMissionDefinition(db, first.id)).toThrow();
    expect(getMissionRun(db, run.id)?.sourceHash).toBe(run.sourceHash);
  });

  it("keeps immutable run source when definition rows are deleted by a foreign key action", () => {
    const definition = saveMissionDefinition(db, { definition: mission(), creator: owner }, 100);
    const run = createMissionRun(db, { definitionId: definition.id, actor: owner }, 200);
    db.prepare("DELETE FROM mission_definitions WHERE id = ?").run(definition.id);
    const reread = getMissionRun(db, run.id)!;
    expect(reread.definitionId).toBeNull();
    expect(reread.sourceJson).toBe(run.sourceJson);
    expect(reread.sourceHash).toBe(run.sourceHash);
  });

  it("uses typed store errors rather than accepting arbitrary JSON and IDs", () => {
    expect(() => createMissionRun(db, {
      definition: mission(), actor: owner, compileReport: { bad: Number.POSITIVE_INFINITY },
    })).toThrow(MissionStoreError);
    expect(() => getMissionRun(db, 0)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});
