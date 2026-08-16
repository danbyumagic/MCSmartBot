import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBus, type Bus } from "../../src/bus/index.js";
import { createConstructionManager, type ConstructionManager } from "../../src/construction/manager.js";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { compileMissionDefinition } from "../../src/missions/compiler.js";
import { createMissionService } from "../../src/missions/service.js";
import { removePlayerRole, setPlayerRole } from "../../src/permissions/roles.js";
import { createSkillRegistry } from "../../src/skills/registry.js";
import { defineSkill } from "../../src/skills/types.js";
import { createTaskEngine, type TaskEngine } from "../../src/tasks/engine.js";
import { getTaskPlan, pauseTaskPlan, resumeTaskPlan, cancelTaskPlan } from "../../src/tasks/store.js";
import { createLogger } from "../../src/util/logger.js";

let directory: string;
let db: DB;
let bus: Bus;
let wake: ReturnType<typeof vi.fn>;
let manager: ConstructionManager;

const builder = { username: "Builder", role: "operator" as const, source: "desktop" as const };

const survey = defineSkill({
  name: "surveyArea",
  description: "bounded survey",
  policy: { minimumRole: "operator", effect: "read", reversible: false, mission: "public" },
  params: z.object({ label: z.string().default("survey") }),
  run: async () => ({ ok: true, summary: "surveyed" }),
});

const prepareBlueprintMaterials = defineSkill({
  name: "prepareBlueprintMaterials",
  description: "internal preparation",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "internal" },
  params: z.object({ jobId: z.number().int().positive() }),
  run: async () => ({ ok: true, summary: "prepared" }),
});

const buildBlueprint = defineSkill({
  name: "buildBlueprint",
  description: "internal construction",
  policy: { minimumRole: "operator", effect: "world-change", reversible: true, mission: "internal" },
  params: z.object({ jobId: z.number().int().positive() }),
  run: async () => ({ ok: true, summary: "built" }),
});

function registry() {
  return createSkillRegistry([survey, prepareBlueprintMaterials, buildBlueprint]);
}

function taskFacade(): Pick<TaskEngine, "wake" | "pause" | "resume" | "cancel"> {
  return {
    wake,
    pause: (planId) => pauseTaskPlan(db, planId),
    resume: (planId) => resumeTaskPlan(db, planId),
    cancel: (planId) => cancelTaskPlan(db, planId),
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "smbmc-task13-edges-"));
  db = openDatabase(join(directory, "memory.sqlite"));
  bus = createBus();
  wake = vi.fn();
  setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
  manager = createConstructionManager({
    db,
    bus,
    log: createLogger({ level: "error", pretty: false }),
    tasks: taskFacade() as TaskEngine,
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
  return createMissionService({
    db,
    bus,
    log: createLogger({ level: "error", pretty: false }),
    registry: registry(),
    tasks: taskFacade(),
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
    name: "task13-edge-cases",
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

function inlineBuild(name: string, cells = 1) {
  return {
    schema: "smartbot.build/v1",
    name,
    targetVersion: "1.21.11",
    ops: Array.from({ length: cells }, (_, x) => ({ op: "put", at: [x, 0, 0], block: "stone" })),
  };
}

function tableCounts() {
  return db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM mission_runs) AS runs,
       (SELECT COUNT(*) FROM task_plans) AS plans,
       (SELECT COUNT(*) FROM construction_jobs) AS jobs,
       (SELECT COUNT(*) FROM blueprints) AS blueprints,
       (SELECT COUNT(*) FROM blueprint_sources) AS sources`,
  ).get() as { runs: number; plans: number; jobs: number; blueprints: number; sources: number };
}

async function eventually(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Task 13 mission edge cases", () => {
  it("rejects a build whose compiled world cells exceed the mission mutation budget", () => {
    const result = compileMissionDefinition(mission([
      {
        id: "two-cell-build",
        op: "build",
        definition: inlineBuild("two-cell-build", 2),
        origin: [0, 64, 0],
      },
    ], { maxWorldChanges: 1 }), {
      registry: registry(),
      actor: builder,
      registryForVersion: (version) => version === "1.21.11"
        ? { version, blocksByName: { stone: {} }, itemsByName: { stone: {} } }
        : undefined,
      db,
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({
        stepId: "two-cell-build",
        code: "WORLD_CHANGE_LIMIT",
        details: { attemptedWorldChanges: 2, maximum: 1 },
      })],
    });
    expect(tableCounts()).toEqual({ runs: 0, plans: 0, jobs: 0, blueprints: 0, sources: 0 });
  });

  it("rolls back inline blueprint persistence when a later construction job cannot materialize", () => {
    const createPendingBuild = manager.createPendingBuild.bind(manager);
    let calls = 0;
    const failingConstruction: Pick<ConstructionManager,
      "createPendingBuild" | "linkPendingBuildsToPlan" | "getBuildsByPlan" |
      "pauseBuildsByPlan" | "resumeBuildsByPlan" | "cancelBuildsByPlan"
    > = {
      createPendingBuild: (input) => {
        calls++;
        if (calls === 2) throw new Error("injected later job materialization failure");
        return createPendingBuild(input);
      },
      linkPendingBuildsToPlan: manager.linkPendingBuildsToPlan.bind(manager),
      getBuildsByPlan: manager.getBuildsByPlan.bind(manager),
      pauseBuildsByPlan: manager.pauseBuildsByPlan.bind(manager),
      resumeBuildsByPlan: manager.resumeBuildsByPlan.bind(manager),
      cancelBuildsByPlan: manager.cancelBuildsByPlan.bind(manager),
    };
    const api = service({ construction: failingConstruction });

    const result = api.run({
      definition: mission([
        { id: "first", op: "build", definition: inlineBuild("first-inline"), origin: [1, 64, 1] },
        { id: "second", op: "build", definition: inlineBuild("second-inline"), origin: [8, 64, 8] },
      ]),
      actor: builder,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "MATERIALIZATION_FAILED" } });
    expect(calls).toBe(2);
    // Both trusted inline-source rows were registered before the injected
    // second-job fault, so these counts prove the outer mission transaction
    // rolls them back alongside the run, first job, and any task-plan state.
    expect(tableCounts()).toEqual({ runs: 0, plans: 0, jobs: 0, blueprints: 0, sources: 0 });
    expect(wake).not.toHaveBeenCalled();
  });

  it("fails the durable mission run when its actor loses access between mission steps", async () => {
    const skillRegistry = registry();
    const runner = {
      run: vi.fn().mockImplementation(async () => {
        removePlayerRole(db, "Builder");
        return { ok: true, summary: "first survey completed" };
      }),
      cancel: vi.fn(),
      restart: vi.fn(),
      activeName: vi.fn().mockReturnValue(null),
    };
    const engine = createTaskEngine({
      db,
      bus,
      log: createLogger({ level: "error", pretty: false }),
      registry: skillRegistry,
      runner,
      ownerUsername: "Owner",
    });
    const api = service({ registry: skillRegistry, tasks: engine });
    engine.start();
    api.start();
    try {
      const started = api.run({
        definition: mission([
          { id: "first", op: "skill", skill: "surveyArea", params: { label: "first" } },
          { id: "second", op: "skill", skill: "surveyArea", params: { label: "second" } },
        ]),
        actor: builder,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await eventually(() => api.getRun(started.value.run.id)?.status === "failed");
      const plan = getTaskPlan(db, started.value.plan.id);
      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(plan).toMatchObject({
        status: "failed",
        steps: [
          { status: "completed" },
          { status: "failed", lastErrorCode: "PERMISSION_DENIED" },
        ],
      });
      expect(api.getRun(started.value.run.id)).toMatchObject({
        status: "failed",
        taskPlanId: started.value.plan.id,
      });
    } finally {
      api.stop();
      engine.stop();
    }
  });
});
