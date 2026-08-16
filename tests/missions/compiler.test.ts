import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openDatabase, type DB } from "../../src/memory/db.js";
import {
  canonicalizeBuildSource,
  compileBuildDefinitionForVersion,
  hashBuildSource,
} from "../../src/construction/buildOps/compiler.js";
import { parseBuildSource } from "../../src/construction/buildOps/schema.js";
import type { BuildBlockRegistry } from "../../src/construction/buildOps/types.js";
import { registerCompiledBlueprint } from "../../src/construction/store.js";
import {
  bindMissionConstructionJobs,
  compileMissionDefinition,
  MISSION_RESERVED_SKILLS,
  MISSION_SKILL_SAFETY_DENYLIST,
} from "../../src/missions/compiler.js";
import { MISSION_EXPANDED_TASKS_METADATA_KEY } from "../../src/missions/types.js";
import { systemActor } from "../../src/permissions/executionActor.js";
import { createSkillRegistry } from "../../src/skills/registry.js";
import { defineSkill } from "../../src/skills/types.js";

let temporaryDirectory: string;
let db: DB;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "smbmc-mission-compiler-"));
  db = openDatabase(join(temporaryDirectory, "memory.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

const publicSkill = defineSkill({
  name: "publicSkill",
  description: "public test skill",
  policy: { minimumRole: "operator", effect: "read", reversible: false, mission: "public" },
  params: z.object({ radius: z.number().int().min(1).max(32).default(8) }),
  run: async () => ({ ok: true, summary: "ok" }),
});

const ownerSkill = defineSkill({
  name: "ownerSkill",
  description: "owner test skill",
  policy: { minimumRole: "owner", effect: "destructive", reversible: false, mission: "public" },
  params: z.object({}),
  run: async () => ({ ok: true, summary: "ok" }),
});

const unsafePublicSkill = defineSkill({
  name: "mineUntil",
  description: "legacy unjournaled gather skill",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  params: z.object({ target: z.string() }),
  run: async () => ({ ok: true, summary: "ok" }),
});

const unsafeSupplyContainer = defineSkill({
  name: "supplyContainer",
  description: "legacy supply path that can mine inputs",
  policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
  params: z.object({ chestName: z.string(), item: z.string(), quantity: z.number().int().positive() }),
  run: async () => ({ ok: true, summary: "ok" }),
});

const unsafeActivateBlock = defineSkill({
  name: "activateBlock",
  description: "raw block activation can trigger unjournaled world effects",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  params: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  run: async () => ({ ok: true, summary: "ok" }),
});

const internalSkill = defineSkill({
  name: "internalOnly",
  description: "internal test skill",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "internal" },
  params: z.object({}),
  run: async () => ({ ok: true, summary: "ok" }),
});

const clearRegion = defineSkill({
  name: "clearRegion",
  description: "clear test region",
  policy: { minimumRole: "owner", effect: "destructive", reversible: true, mission: "public" },
  params: z.object({
    from: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
    to: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
    includeContainers: z.boolean().default(false),
    preserve: z.array(z.string()).default([]),
    collectDrops: z.boolean().default(true),
    label: z.string().optional(),
  }),
  run: async () => ({ ok: true, summary: "ok" }),
});

const prepareBlueprintMaterials = defineSkill({
  name: "prepareBlueprintMaterials",
  description: "internal preparation",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "internal" },
  params: z.object({ jobId: z.number().int().positive() }),
  run: async () => ({ ok: true, summary: "ok" }),
});

const buildBlueprint = defineSkill({
  name: "buildBlueprint",
  description: "internal construction",
  policy: { minimumRole: "operator", effect: "world-change", reversible: true, mission: "internal" },
  params: z.object({ jobId: z.number().int().positive() }),
  run: async () => ({ ok: true, summary: "ok" }),
});

const blockRegistry: BuildBlockRegistry = {
  version: "1.21.11",
  blocksByName: { stone: {}, tnt: {} },
  itemsByName: { stone: {}, tnt: {} },
};

function registry(...skills: Parameters<typeof createSkillRegistry>[0]) {
  return createSkillRegistry([
    publicSkill,
    clearRegion,
    prepareBlueprintMaterials,
    buildBlueprint,
    ...skills,
  ]);
}

function deps(options: {
  readonly actor?: { readonly username: string; readonly role: "owner" | "operator" | "viewer"; readonly source: "desktop" | "minecraft-chat" };
  readonly skills?: Parameters<typeof createSkillRegistry>[0];
  readonly database?: DB;
} = {}) {
  return {
    registry: registry(...(options.skills ?? [])),
    actor: options.actor ?? { username: "Builder", role: "operator" as const, source: "desktop" as const },
    registryForVersion: (version: string) => version === blockRegistry.version ? blockRegistry : undefined,
    ...(options.database ? { db: options.database } : {}),
  };
}

function mission(steps: unknown[], limits: Record<string, number> = {}) {
  return {
    schema: "smartbot.mission/v1",
    name: "compiler-test",
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

function inlineBuild(name = "inline-stone") {
  return {
    schema: "smartbot.build/v1",
    name,
    targetVersion: "1.21.11",
    ops: [{ op: "put", at: [0, 0, 0], block: "stone" }],
  };
}

describe("MissionScript compiler", () => {
  it("validates public params, resolves defaults, and emits Task 12-compatible link metadata", () => {
    const result = compileMissionDefinition(mission([
      { id: "inspect", op: "skill", skill: "publicSkill", params: {}, maxAttempts: 2 },
      { id: "clear", op: "clear", from: [0, 64, 0], to: [1, 64, 1], includeContainers: false },
    ]), deps({ actor: systemActor("Owner", "recovery") }));

    expect(result).toMatchObject({
      ok: true,
      value: {
        report: { logicalStepCount: 2, expandedStepCount: 2, estimatedWorldChanges: 4, requiredRole: "owner" },
      },
    });
    if (!result.ok) return;

    const bound = bindMissionConstructionJobs(result.value, {});
    expect(bound.taskSteps).toEqual([
      { skill: "publicSkill", params: { radius: 8 }, maxAttempts: 2 },
      {
        skill: "clearRegion",
        params: {
          from: { x: 0, y: 64, z: 0 },
          to: { x: 1, y: 64, z: 1 },
          includeContainers: false,
          preserve: [],
          collectDrops: true,
        },
        maxAttempts: 3,
      },
    ]);
    expect(bound.stepLinks.map((link) => link.compileMetadata[MISSION_EXPANDED_TASKS_METADATA_KEY])).toEqual([
      [{ skill: "publicSkill", params: { radius: 8 }, maxAttempts: 2 }],
      [expect.objectContaining({ skill: "clearRegion", maxAttempts: 3 })],
    ]);
  });

  it("collects logical-step diagnostics for unknown, internal, invalid, unsafe, and unauthorized skills", () => {
    expect(MISSION_SKILL_SAFETY_DENYLIST).toContain("mineUntil");
    expect(MISSION_SKILL_SAFETY_DENYLIST).toContain("supplyContainer");
    expect(MISSION_SKILL_SAFETY_DENYLIST).toContain("activateBlock");
    expect(MISSION_RESERVED_SKILLS).toContain("clearRegion");
    const result = compileMissionDefinition(mission([
      { id: "unknown", op: "skill", skill: "notRegistered", params: {} },
      { id: "internal", op: "skill", skill: "internalOnly", params: {} },
      { id: "bad", op: "skill", skill: "publicSkill", params: { radius: "eight" } },
      { id: "unsafe", op: "skill", skill: "mineUntil", params: { target: "stone" } },
      { id: "unsafe-supply", op: "skill", skill: "supplyContainer", params: { chestName: "main", item: "glass", quantity: 1 } },
      { id: "unsafe-activation", op: "skill", skill: "activateBlock", params: { x: 1, y: 64, z: 1 } },
      { id: "owner", op: "skill", skill: "ownerSkill", params: {} },
      {
        id: "clear-as-skill", op: "skill", skill: "clearRegion",
        params: { from: { x: 0, y: 64, z: 0 }, to: { x: 0, y: 64, z: 0 } },
      },
    ]), deps({ skills: [internalSkill, unsafePublicSkill, unsafeSupplyContainer, unsafeActivateBlock, ownerSkill] }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "unknown", code: "SKILL_NOT_FOUND" }),
      expect.objectContaining({ stepId: "internal", code: "SKILL_NOT_PUBLIC" }),
      expect.objectContaining({ stepId: "bad", code: "SKILL_PARAMS_INVALID" }),
      expect.objectContaining({ stepId: "unsafe", code: "SKILL_UNSAFE_FOR_MISSION" }),
      expect.objectContaining({ stepId: "unsafe-supply", code: "SKILL_UNSAFE_FOR_MISSION" }),
      expect.objectContaining({ stepId: "unsafe-activation", code: "SKILL_UNSAFE_FOR_MISSION" }),
      expect.objectContaining({ stepId: "owner", code: "ROLE_DENIED" }),
      expect.objectContaining({ stepId: "clear-as-skill", code: "SKILL_RESERVED_FOR_MISSION_OP" }),
    ]));
  });

  it("uses exact clear volume and combined change budget before any materialization", () => {
    const tooLarge = compileMissionDefinition(mission([
      { id: "wide", op: "clear", from: [0, 64, 0], to: [16, 79, 16] },
    ]), deps({ actor: systemActor("Owner", "recovery") }));
    expect(tooLarge).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ stepId: "wide", code: "CLEAR_VOLUME_LIMIT" })],
    });

    const combined = compileMissionDefinition(mission([
      { id: "first", op: "clear", from: [0, 64, 0], to: [1, 64, 0] },
      { id: "second", op: "clear", from: [2, 64, 0], to: [3, 64, 0] },
    ], { maxWorldChanges: 3 }), deps({ actor: systemActor("Owner", "recovery") }));
    expect(combined).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ stepId: "second", code: "WORLD_CHANGE_LIMIT" })],
    });
  });

  it("compiles inline BuildOps against the exact target registry and binds two internal tasks to one job", () => {
    const result = compileMissionDefinition(mission([
      {
        id: "build", op: "build", definition: inlineBuild(), origin: [10, 64, 10], rotation: 90, maxAttempts: 4,
      },
    ]), deps());
    expect(result).toMatchObject({
      ok: true,
      value: {
        report: { expandedStepCount: 2, estimatedWorldChanges: 1 },
        logicalSteps: [expect.objectContaining({
          expandedStepCount: 2,
          build: expect.objectContaining({ kind: "inline", origin: [10, 64, 10], rotation: 90 }),
        })],
      },
    });
    if (!result.ok) return;

    const bound = bindMissionConstructionJobs(result.value, new Map([["build", 42]]));
    expect(bound.taskSteps).toEqual([
      { skill: "prepareBlueprintMaterials", params: { jobId: 42 }, maxAttempts: 4 },
      { skill: "buildBlueprint", params: { jobId: 42 }, maxAttempts: 4 },
    ]);
    expect(bound.stepLinks[0]).toMatchObject({
      constructionJobId: 42,
      compileMetadata: {
        [MISSION_EXPANDED_TASKS_METADATA_KEY]: [
          { skill: "prepareBlueprintMaterials", params: { jobId: 42 }, maxAttempts: 4 },
          { skill: "buildBlueprint", params: { jobId: 42 }, maxAttempts: 4 },
        ],
      },
    });
  });

  it("validates generated internal construction params before any job can be materialized", () => {
    const invalidPrepare = defineSkill({
      name: "prepareBlueprintMaterials",
      description: "internal schema changed incompatibly",
      policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "internal" },
      params: z.object({ jobId: z.number().int().positive(), requiredFutureField: z.string() }),
      run: async () => ({ ok: true, summary: "ok" }),
    });
    const result = compileMissionDefinition(mission([
      { id: "build", op: "build", definition: inlineBuild(), origin: [0, 64, 0] },
    ]), {
      registry: createSkillRegistry([publicSkill, clearRegion, invalidPrepare, buildBlueprint]),
      actor: { username: "Builder", role: "operator", source: "desktop" },
      registryForVersion: (version) => version === blockRegistry.version ? blockRegistry : undefined,
    });
    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ stepId: "build", code: "INTERNAL_SKILL_INVALID" })],
    });
  });

  it("recompiles a named source-backed blueprint through read-only store APIs without writing runs, jobs, or plans", () => {
    const source = parseBuildSource(inlineBuild("saved-stone"));
    const compiled = compileBuildDefinitionForVersion(source, {
      registryForVersion: (version) => version === blockRegistry.version ? blockRegistry : undefined,
    });
    if (!compiled.ok) throw new Error("fixture BuildOps source should compile");
    const blueprint = registerCompiledBlueprint(db, {
      name: "saved-stone",
      blocks: compiled.value.placements.map((placement) => ({ ...placement })),
      sourceSchema: source.schema,
      targetVersion: source.targetVersion,
      sourceJson: canonicalizeBuildSource(source),
      sourceHash: hashBuildSource(source),
      compileReportJson: JSON.stringify(compiled.value.report),
      creator: systemActor("Owner", "recovery"),
    });
    const before = db.prepare(
      "SELECT (SELECT COUNT(*) FROM mission_runs) AS runs, (SELECT COUNT(*) FROM task_plans) AS plans, (SELECT COUNT(*) FROM construction_jobs) AS jobs",
    ).get() as { runs: number; plans: number; jobs: number };

    const result = compileMissionDefinition(mission([
      { id: "named", op: "build", blueprintName: blueprint.name, origin: [0, 64, 0] },
    ]), deps({ database: db }));
    expect(result).toMatchObject({
      ok: true,
      value: { logicalSteps: [expect.objectContaining({ build: expect.objectContaining({ kind: "named" }) })] },
    });
    expect(db.prepare(
      "SELECT (SELECT COUNT(*) FROM mission_runs) AS runs, (SELECT COUNT(*) FROM task_plans) AS plans, (SELECT COUNT(*) FROM construction_jobs) AS jobs",
    ).get()).toEqual(before);
  });
});
