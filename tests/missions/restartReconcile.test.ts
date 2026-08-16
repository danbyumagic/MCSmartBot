import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBus, type Bus } from "../../src/bus/index.js";
import { createConstructionManager } from "../../src/construction/manager.js";
import { getConstructionJob, upsertBlueprint } from "../../src/construction/store.js";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { createMissionService } from "../../src/missions/service.js";
import { getMissionRun, transitionMissionRun } from "../../src/missions/store.js";
import { setPlayerRole } from "../../src/permissions/roles.js";
import { createSkillRegistry } from "../../src/skills/registry.js";
import { defineSkill } from "../../src/skills/types.js";
import type { TaskEngine } from "../../src/tasks/engine.js";
import {
  cancelTaskPlan,
  failTaskStep,
  pauseTaskPlan,
  resumeTaskPlan,
} from "../../src/tasks/store.js";
import { createLogger } from "../../src/util/logger.js";

let directory: string;
let db: DB;

const builder = { username: "Builder", role: "operator" as const, source: "desktop" as const };

const prepare = defineSkill({
  name: "prepareBlueprintMaterials",
  description: "prepare a build",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "internal" },
  params: z.object({ jobId: z.number().int().positive() }),
  run: async () => ({ ok: true, summary: "prepared" }),
});

const build = defineSkill({
  name: "buildBlueprint",
  description: "build a blueprint",
  policy: { minimumRole: "operator", effect: "world-change", reversible: true, mission: "internal" },
  params: z.object({ jobId: z.number().int().positive() }),
  run: async () => ({ ok: true, summary: "built" }),
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "smbmc-mission-restart-"));
  db = openDatabase(join(directory, "memory.sqlite"));
  setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function freshServices() {
  const bus: Bus = createBus();
  const tasks = {
    wake: vi.fn(),
    pause: (planId: number) => pauseTaskPlan(db, planId),
    resume: (planId: number) => resumeTaskPlan(db, planId),
    cancel: (planId: number) => cancelTaskPlan(db, planId),
  } as Pick<TaskEngine, "wake" | "pause" | "resume" | "cancel">;
  const construction = createConstructionManager({
    db,
    bus,
    log: createLogger({ level: "error", pretty: false }),
    tasks: tasks as TaskEngine,
    ownerUsername: "Owner",
    configuredVersion: "1.21.11",
    getLiveVersion: () => "1.21.11",
  });
  const missions = createMissionService({
    db,
    bus,
    log: createLogger({ level: "error", pretty: false }),
    registry: createSkillRegistry([prepare, build]),
    tasks,
    construction,
    ownerUsername: "Owner",
    registryForVersion: (version) => version === "1.21.11"
      ? { version, blocksByName: { stone: {} }, itemsByName: { stone: {} } }
      : undefined,
    getLiveDimension: () => "overworld",
  });
  return { construction, missions };
}

describe("MissionService restart reconciliation", () => {
  it("terminalizes a running build job when a failed persisted mission plan is recovered", () => {
    upsertBlueprint(db, {
      name: "restart-tower",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const beforeCrash = freshServices();
    const created = beforeCrash.missions.run({
      definition: {
        schema: "smartbot.mission/v1",
        name: "restart-reconcile",
        limits: {
          maxLogicalSteps: 1,
          maxExpandedSteps: 8,
          maxWorldChanges: 32,
          maxRuntimeMinutes: 30,
        },
        steps: [{
          id: "build",
          op: "build",
          blueprintName: "restart-tower",
          origin: [0, 64, 0],
        }],
      },
      actor: builder,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const { plan, run, constructionJobIds } = created.value;
    const jobId = constructionJobIds[0]!;
    // Persist the failure without delivering a taskPlanFailed event: this is
    // the exact state a process crash can leave behind.
    failTaskStep(db, plan.steps[0]!.id, {
      ok: false,
      summary: "simulated persisted plan failure",
      code: "UNKNOWN",
      recoverable: false,
    }, null);
    // Model the narrow crash window after the mission status was persisted
    // but before its construction listener repaired the linked job. The run
    // is terminal, so active-run pagination alone must not be relied upon.
    transitionMissionRun(db, run.id, "failed", {
      error: "simulated persisted plan failure",
    });
    expect(getConstructionJob(db, jobId)).toMatchObject({ status: "running" });

    // Closing and reopening the database proves the fresh services derive
    // state from durable rows rather than a prior in-memory trigger listener.
    db.close();
    db = openDatabase(join(directory, "memory.sqlite"));
    const afterCrash = freshServices();
    afterCrash.construction.start();
    afterCrash.missions.start();

    expect(getMissionRun(db, run.id)).toMatchObject({
      status: "failed",
      lastError: "simulated persisted plan failure",
    });
    expect(getConstructionJob(db, jobId)).toMatchObject({
      status: "failed",
      lastError: "simulated persisted plan failure",
      lastPlanId: plan.id,
    });
    afterCrash.missions.stop();
    afterCrash.construction.stop();
  });
});
