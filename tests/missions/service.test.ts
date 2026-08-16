import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBus, type Bus } from "../../src/bus/index.js";
import { createConstructionManager, type ConstructionManager } from "../../src/construction/manager.js";
import {
  getBlueprintByName,
  getConstructionJob,
  listConstructionJobsByPlan,
  setConstructionStatus,
  upsertBlueprint,
} from "../../src/construction/store.js";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { createMissionService } from "../../src/missions/service.js";
import { createMissionRun, getMissionRun, transitionMissionRun } from "../../src/missions/store.js";
import { systemActor } from "../../src/permissions/executionActor.js";
import { setPlayerRole } from "../../src/permissions/roles.js";
import { createSkillRegistry } from "../../src/skills/registry.js";
import { defineSkill } from "../../src/skills/types.js";
import { cancelTaskPlan, getTaskPlan, pauseTaskPlan, resumeTaskPlan } from "../../src/tasks/store.js";
import type { TaskEngine } from "../../src/tasks/engine.js";
import { createLogger } from "../../src/util/logger.js";

let directory: string;
let db: DB;
let bus: Bus;
let wake: ReturnType<typeof vi.fn>;
let manager: ConstructionManager;

const owner = systemActor("Owner", "recovery");
const builder = { username: "Builder", role: "operator" as const, source: "desktop" as const };
const viewer = { username: "Viewer", role: "viewer" as const, source: "desktop" as const };

const survey = defineSkill({
  name: "surveyArea",
  description: "bounded survey",
  policy: { minimumRole: "operator", effect: "read", reversible: false, mission: "public" },
  params: z.object({ radius: z.number().int().min(1).max(64).default(16) }),
  run: async () => ({ ok: true, summary: "surveyed" }),
});
const clear = defineSkill({
  name: "clearRegion",
  description: "bounded owner clear",
  policy: { minimumRole: "owner", effect: "destructive", reversible: true, mission: "public" },
  params: z.object({
    from: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
    to: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
    includeContainers: z.boolean().default(false),
    preserve: z.array(z.string()).default([]),
    collectDrops: z.boolean().default(true),
    label: z.string().optional(),
  }),
  run: async () => ({ ok: true, summary: "cleared" }),
});
const prepare = defineSkill({
  name: "prepareBlueprintMaterials",
  description: "prepare build",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "internal" },
  params: z.object({ jobId: z.number().int().positive() }),
  run: async () => ({ ok: true, summary: "prepared" }),
});
const build = defineSkill({
  name: "buildBlueprint",
  description: "build blueprint",
  policy: { minimumRole: "operator", effect: "world-change", reversible: true, mission: "internal" },
  params: z.object({ jobId: z.number().int().positive() }),
  run: async () => ({ ok: true, summary: "built" }),
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "smbmc-mission-service-"));
  db = openDatabase(join(directory, "memory.sqlite"));
  bus = createBus();
  wake = vi.fn();
  setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
  setPlayerRole(db, { username: "Viewer", role: "viewer", grantedBy: "Owner" });
  const taskFacade = {
    wake,
    pause: (planId: number) => pauseTaskPlan(db, planId),
    resume: (planId: number) => resumeTaskPlan(db, planId),
    cancel: (planId: number) => cancelTaskPlan(db, planId),
  } as Pick<TaskEngine, "wake" | "pause" | "resume" | "cancel">;
  manager = createConstructionManager({
    db,
    bus,
    log: createLogger({ level: "error", pretty: false }),
    tasks: taskFacade as TaskEngine,
    ownerUsername: "Owner",
    configuredVersion: "1.21.11",
    getLiveVersion: () => "1.21.11",
  });
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function service(overrides: Partial<Parameters<typeof createMissionService>[0]> = {}) {
  const taskFacade = {
    wake,
    pause: (planId: number) => pauseTaskPlan(db, planId),
    resume: (planId: number) => resumeTaskPlan(db, planId),
    cancel: (planId: number) => cancelTaskPlan(db, planId),
  } as Pick<TaskEngine, "wake" | "pause" | "resume" | "cancel">;
  return createMissionService({
    db,
    bus,
    log: createLogger({ level: "error", pretty: false }),
    registry: createSkillRegistry([survey, clear, prepare, build]),
    tasks: taskFacade,
    construction: manager,
    ownerUsername: "Owner",
    registryForVersion: (version) => version === "1.21.11"
      ? { version, blocksByName: { stone: {} }, itemsByName: { stone: {} } }
      : undefined,
    getLiveDimension: () => "overworld",
    ...overrides,
  });
}

function mission(steps: unknown[], limits: Record<string, number> = {}) {
  return {
    schema: "smartbot.mission/v1",
    name: "mission-service-test",
    limits: {
      maxLogicalSteps: Math.max(1, steps.length),
      maxExpandedSteps: 64,
      maxWorldChanges: 4_096,
      maxRuntimeMinutes: 30,
      ...limits,
    },
    steps,
  };
}

function addBlueprint(name: string) {
  return upsertBlueprint(db, { name, blocks: [{ x: 0, y: 0, z: 0, block: "stone" }] });
}

describe("MissionService", () => {
  it("enforces operator access at the service write boundary", () => {
    const api = service();
    const definition = mission([{ id: "survey", op: "skill", skill: "surveyArea", params: {} }]);
    expect(api.save({ definition, actor: viewer })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(api.run({ definition, actor: viewer })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mission_definitions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mission_runs").get()).toEqual({ count: 0 });
  });

  it("prevalidates every logical step and writes nothing for an invalid mission", () => {
    const api = service();
    const result = api.run({
      definition: mission([
        { id: "ok", op: "skill", skill: "surveyArea", params: {} },
        { id: "bad", op: "skill", skill: "notRegistered", params: {} },
      ]),
      actor: builder,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "MISSION_INVALID" } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mission_runs").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_plans").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM construction_jobs").get()).toEqual({ count: 0 });
    expect(wake).not.toHaveBeenCalled();
  });

  it("rejects a raw hazardous blueprint before it can create a mission run or construction job", () => {
    upsertBlueprint(db, {
      name: "raw-tnt",
      blocks: [{ x: 0, y: 0, z: 0, block: "tnt" }],
    });
    const api = service();
    const result = api.run({
      definition: mission([
        { id: "unsafe", op: "build", blueprintName: "raw-tnt", origin: [0, 64, 0] },
      ]),
      actor: builder,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "MISSION_INVALID" } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mission_runs").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_plans").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM construction_jobs").get()).toEqual({ count: 0 });
  });

  it("atomically creates one plan for multiple construction jobs and exact durable links", () => {
    addBlueprint("tower-a");
    addBlueprint("tower-b");
    const api = service();
    const result = api.run({
      definition: mission([
        { id: "survey", op: "skill", skill: "surveyArea", params: {} },
        { id: "first", op: "build", blueprintName: "tower-a", origin: [1, 64, 1], rotation: 0 },
        { id: "second", op: "build", blueprintName: "tower-b", origin: [8, 64, 8], rotation: 90 },
      ]),
      actor: builder,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.run.status).toBe("running");
    expect(result.value.plan.steps).toHaveLength(5);
    expect(result.value.run.stepLinks).toHaveLength(3);
    expect(result.value.constructionJobIds).toHaveLength(2);
    expect(listConstructionJobsByPlan(db, result.value.plan.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: result.value.constructionJobIds[0], status: "running" }),
      expect.objectContaining({ id: result.value.constructionJobIds[1], status: "running" }),
    ]));
    expect(new Set(listConstructionJobsByPlan(db, result.value.plan.id).map((job) => job.lastPlanId))).toEqual(
      new Set([result.value.plan.id]),
    );
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("rolls back a run plan and earlier pending job when later job materialization fails", () => {
    addBlueprint("tower-a");
    addBlueprint("tower-b");
    const create = manager.createPendingBuild.bind(manager);
    let calls = 0;
    const failingConstruction = {
      ...manager,
      createPendingBuild: ((input: Parameters<typeof manager.createPendingBuild>[0]) => {
        calls++;
        if (calls === 2) throw new Error("injected second job failure");
        return create(input);
      }) as ConstructionManager["createPendingBuild"],
    };
    const api = service({ construction: failingConstruction });
    const result = api.run({
      definition: mission([
        { id: "first", op: "build", blueprintName: "tower-a", origin: [1, 64, 1] },
        { id: "second", op: "build", blueprintName: "tower-b", origin: [8, 64, 8] },
      ]),
      actor: builder,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "MATERIALIZATION_FAILED" } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mission_runs").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_plans").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM construction_jobs").get()).toEqual({ count: 0 });
    expect(wake).not.toHaveBeenCalled();
  });

  it("rolls back when a named blueprint changes after compilation during materialization", () => {
    addBlueprint("snapshot-tower");
    const create = manager.createPendingBuild.bind(manager);
    let swapped = false;
    const swappingConstruction = {
      ...manager,
      createPendingBuild: ((input: Parameters<typeof manager.createPendingBuild>[0]) => {
        // This simulates a re-entrant/admin write after the compiler's
        // read-only snapshot but before durable mission links are written.
        // It is inside MissionService's transaction, so failure must leave
        // neither a changed blueprint nor a partial mission behind.
        if (!swapped) {
          swapped = true;
          upsertBlueprint(db, {
            name: "snapshot-tower",
            blocks: [{ x: 0, y: 0, z: 0, block: "tnt" }],
          });
        }
        return create(input);
      }) as ConstructionManager["createPendingBuild"],
    };
    const api = service({ construction: swappingConstruction });
    const result = api.run({
      definition: mission([
        { id: "build", op: "build", blueprintName: "snapshot-tower", origin: [1, 64, 1] },
      ]),
      actor: builder,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "MATERIALIZATION_FAILED" } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mission_runs").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_plans").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM construction_jobs").get()).toEqual({ count: 0 });
    expect(getBlueprintByName(db, "snapshot-tower")?.blocks).toEqual([
      { x: 0, y: 0, z: 0, block: "stone" },
    ]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("maps plan events and coordinates pause resume cancel with all linked jobs", () => {
    addBlueprint("tower");
    const api = service();
    api.start();
    const started = api.run({
      definition: mission([{ id: "build", op: "build", blueprintName: "tower", origin: [1, 64, 1] }]),
      actor: builder,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const runId = started.value.run.id;
    const planId = started.value.plan.id;

    const paused = api.manageRun({ runId, action: "pause", actor: builder });
    expect(paused).toMatchObject({ ok: true, value: { status: "paused" } });
    expect(getTaskPlan(db, planId)?.status).toBe("paused");
    expect(listConstructionJobsByPlan(db, planId).every((job) => job.status === "paused")).toBe(true);

    const resumed = api.manageRun({ runId, action: "resume", actor: builder });
    expect(resumed).toMatchObject({ ok: true, value: { status: "running" } });
    expect(listConstructionJobsByPlan(db, planId).every((job) => job.status === "running")).toBe(true);

    const jobId = started.value.constructionJobIds[0]!;
    expect(setConstructionStatus(db, jobId, "completed")).toBe(true);
    bus.emit("agent.trigger", { kind: "taskPlanDone", planId, title: "mission plan" });
    expect(getMissionRun(db, runId)?.status).toBe("completed");

    const again = api.run({
      definition: mission([{ id: "survey", op: "skill", skill: "surveyArea", params: {} }]),
      actor: builder,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const cancelled = api.manageRun({ runId: again.value.run.id, action: "cancel", actor: builder });
    expect(cancelled).toMatchObject({ ok: true, value: { status: "cancelled" } });
    api.stop();
  });

  it("compensates a failed resume by leaving the mission plan and jobs paused", () => {
    addBlueprint("tower");
    const tasks = {
      wake,
      pause: vi.fn((planId: number) => pauseTaskPlan(db, planId)),
      // Simulates a plan that cannot be restored after construction has
      // already been resumed. MissionService must put every substrate back
      // into a non-runnable state before returning the failure.
      resume: vi.fn((_planId: number) => false),
      cancel: vi.fn((planId: number) => cancelTaskPlan(db, planId)),
    } as Pick<TaskEngine, "wake" | "pause" | "resume" | "cancel">;
    const api = service({ tasks });
    const started = api.run({
      definition: mission([{ id: "build", op: "build", blueprintName: "tower", origin: [1, 64, 1] }]),
      actor: builder,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { run, plan } = started.value;

    expect(api.manageRun({ runId: run.id, action: "pause", actor: builder }))
      .toMatchObject({ ok: true, value: { status: "paused" } });
    wake.mockClear();

    const resumed = api.manageRun({ runId: run.id, action: "resume", actor: builder });
    expect(resumed).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
    expect(tasks.resume).toHaveBeenCalledWith(plan.id);
    // The first call pauses normally; the second is compensation after the
    // failed task-plan resume. It is intentionally attempted even if already
    // paused, to preserve fail-closed behavior under partial store failure.
    expect(tasks.pause).toHaveBeenCalledTimes(2);
    expect(getMissionRun(db, run.id)).toMatchObject({
      status: "paused",
      lastError: expect.stringContaining("mission resume did not complete"),
    });
    expect(getTaskPlan(db, plan.id)?.status).toBe("paused");
    expect(getTaskPlan(db, plan.id)?.steps.every((step) => step.status === "pending")).toBe(true);
    expect(listConstructionJobsByPlan(db, plan.id)).toEqual([
      expect.objectContaining({ status: "paused" }),
    ]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("requires a live dimension before it materializes any build row", () => {
    addBlueprint("tower");
    const api = service({ getLiveDimension: () => undefined });
    const result = api.run({
      definition: mission([{ id: "build", op: "build", blueprintName: "tower", origin: [1, 64, 1] }]),
      actor: builder,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "WORLD_UNAVAILABLE" } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mission_runs").get()).toEqual({ count: 0 });
  });

  it("keeps preview structural while disconnected and bounds live site inspection without writes", () => {
    upsertBlueprint(db, {
      name: "preview-many-blocked",
      blocks: Array.from({ length: 40 }, (_, x) => ({ x, y: 0, z: 0, block: "stone" })),
    });
    const definition = mission([
      { id: "build", op: "build", blueprintName: "preview-many-blocked", origin: [10, 64, 10] },
    ]);
    const snapshot = () => db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM mission_runs) AS runs,
        (SELECT COUNT(*) FROM task_plans) AS plans,
        (SELECT COUNT(*) FROM task_steps) AS steps,
        (SELECT COUNT(*) FROM construction_jobs) AS jobs,
        (SELECT COUNT(*) FROM mission_step_links) AS links`,
    ).get();
    const before = snapshot();

    const disconnected = service({ getLiveBot: () => undefined }).preview({
      definition,
      actor: builder,
    });
    expect(disconnected).toMatchObject({
      ok: true,
      value: {
        compilation: { report: { logicalStepCount: 1, expandedStepCount: 2 } },
        buildSites: [{
          stepId: "build",
          available: false,
          reason: expect.stringContaining("not connected"),
        }],
      },
    });
    expect(snapshot()).toEqual(before);

    const blockAt = vi.fn(() => ({
      // Every requested target is occupied by a non-replaceable wrong block,
      // making the site report exercise its bounded issue sample.
      name: "dirt",
      boundingBox: "block",
      getProperties: () => ({}),
    }));
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      game: { dimension: "overworld" },
      blockAt,
    };
    const live = service({ getLiveBot: () => bot as never }).preview({ definition, actor: builder });
    expect(live).toMatchObject({
      ok: true,
      value: {
        buildSites: [{
          stepId: "build",
          available: true,
          safe: false,
          correctWorldCells: 0,
          pendingWorldCells: 0,
          issueCounts: { blocked: 40, unloaded: 0, unsupported: 0 },
        }],
      },
    });
    if (!live.ok) return;
    expect(live.value.buildSites[0]?.issues).toHaveLength(32);
    expect(blockAt).toHaveBeenCalledTimes(40);
    expect(snapshot()).toEqual(before);
  });

  it("keeps structural preview available when a live block lookup throws", () => {
    addBlueprint("preview-throws");
    const before = db.prepare(
      "SELECT (SELECT COUNT(*) FROM mission_runs) AS runs, (SELECT COUNT(*) FROM task_plans) AS plans, (SELECT COUNT(*) FROM construction_jobs) AS jobs",
    ).get();
    const api = service({
      getLiveBot: () => ({
        entity: { position: { x: 0, y: 64, z: 0 } },
        game: { dimension: "overworld" },
        blockAt: () => { throw new Error("chunk lookup failed"); },
      }) as never,
    });
    const result = api.preview({
      definition: mission([{ id: "build", op: "build", blueprintName: "preview-throws", origin: [0, 64, 0] }]),
      actor: builder,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        buildSites: [expect.objectContaining({ available: false, reason: expect.stringContaining("chunk lookup failed") })],
      },
    });
    expect(db.prepare(
      "SELECT (SELECT COUNT(*) FROM mission_runs) AS runs, (SELECT COUNT(*) FROM task_plans) AS plans, (SELECT COUNT(*) FROM construction_jobs) AS jobs",
    ).get()).toEqual(before);
  });

  it("reconciles an older active run even when more than one list page of newer runs is terminal", () => {
    const api = service();
    const started = api.run({
      definition: mission([{ id: "survey", op: "skill", skill: "surveyArea", params: {} }]),
      actor: builder,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // These rows model a busy history. They are terminal and must not hide the
    // oldest active mission from startup reconciliation's user-list cap.
    for (let index = 0; index < 101; index++) {
      const historical = createMissionRun(db, {
        definition: mission([{ id: "survey", op: "skill", skill: "surveyArea", params: {} }]),
        actor: builder,
      }, 10_000 + index);
      transitionMissionRun(db, historical.id, "cancelled", {}, 20_000 + index);
    }
    expect(cancelTaskPlan(db, started.value.plan.id)).toBe(true);

    api.reconcile();
    expect(getMissionRun(db, started.value.run.id)?.status).toBe("cancelled");
  });
});
