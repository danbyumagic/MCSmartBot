import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import {
  attachMissionRunTaskPlan,
  createMissionRun,
  transitionMissionRun,
} from "../../src/missions/store.js";
import {
  cancelTaskPlan,
  claimNextTaskStep,
  completeTaskStep,
  createTaskPlan,
  failTaskStep,
  getTaskPlan,
  pauseTaskPlan,
  reconcileInterruptedTasks,
  resumeTaskPlan,
} from "../../src/tasks/store.js";
import { snapshotExecutionActor } from "../../src/permissions/executionActor.js";

const actor = snapshotExecutionActor({
  username: "Builder",
  role: "operator",
  source: "minecraft-chat",
});

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("task store", () => {
  it("executes steps strictly in order and completes the plan", () => {
    const plan = createTaskPlan(db, {
      title: "prepare",
      steps: [
        { skill: "retrieveItem", params: { item: "coal" } },
        { skill: "smeltItem", params: { input: "raw_iron" } },
      ],
      actor,
    });
    const first = claimNextTaskStep(db, 100)!;
    expect(first.position).toBe(0);
    expect(first.attempts).toBe(1);
    expect(claimNextTaskStep(db, 100)).toBeUndefined();
    completeTaskStep(db, first.id, { ok: true, summary: "done" });
    const second = claimNextTaskStep(db, 100)!;
    expect(second.position).toBe(1);
    completeTaskStep(db, second.id, { ok: true, summary: "done" });
    expect(getTaskPlan(db, plan.id)?.status).toBe("completed");
  });

  it("persists retry metadata and stops at max attempts", () => {
    const plan = createTaskPlan(db, {
      title: "retry",
      steps: [{ skill: "x", params: {}, maxAttempts: 2 }],
      actor,
    });
    const first = claimNextTaskStep(db, 100)!;
    failTaskStep(db, first.id, {
      ok: false, summary: "not yet", code: "NO_MATERIAL", recoverable: true,
    }, 200);
    expect(getTaskPlan(db, plan.id)?.steps[0]).toMatchObject({
      status: "retry_wait", attempts: 1, nextAttemptAt: 200,
    });
    expect(claimNextTaskStep(db, 199)).toBeUndefined();
    const second = claimNextTaskStep(db, 200)!;
    failTaskStep(db, second.id, {
      ok: false, summary: "still no", code: "NO_MATERIAL", recoverable: true,
    }, 300);
    expect(getTaskPlan(db, plan.id)).toMatchObject({
      status: "failed",
      steps: [{ status: "failed", attempts: 2 }],
    });
  });

  it("supports pause resume and cancellation", () => {
    const plan = createTaskPlan(db, {
      title: "managed",
      steps: [{ skill: "x", params: {} }],
      actor,
    });
    expect(pauseTaskPlan(db, plan.id)).toBe(true);
    expect(getTaskPlan(db, plan.id)?.status).toBe("paused");
    expect(claimNextTaskStep(db)).toBeUndefined();
    expect(resumeTaskPlan(db, plan.id)).toBe(true);
    expect(getTaskPlan(db, plan.id)?.status).toBe("pending");
    expect(cancelTaskPlan(db, plan.id)).toBe(true);
    expect(getTaskPlan(db, plan.id)).toMatchObject({
      status: "cancelled",
      steps: [{ status: "cancelled" }],
    });
  });

  it("never claims a linked task plan while its mission is pending or paused", () => {
    const plan = createTaskPlan(db, {
      title: "held mission work",
      steps: [{ skill: "x", params: {} }],
      actor,
    });
    const run = createMissionRun(db, {
      definition: {
        schema: "smartbot.mission/v1",
        name: "held-mission",
        limits: {
          maxLogicalSteps: 1,
          maxExpandedSteps: 1,
          maxWorldChanges: 1,
          maxRuntimeMinutes: 1,
        },
        steps: [{ id: "step", op: "skill", skill: "x", params: {} }],
      },
      actor,
    });
    attachMissionRunTaskPlan(db, run.id, plan.id);

    // The task plan is independently runnable (`pending`), so these assertions
    // exercise the mission-state clause in claimNextTaskStep rather than the
    // ordinary plan pause gate.
    expect(claimNextTaskStep(db)).toBeUndefined();
    expect(transitionMissionRun(db, run.id, "paused")).toMatchObject({ status: "paused" });
    expect(getTaskPlan(db, plan.id)).toMatchObject({
      status: "pending",
      steps: [{ status: "pending", attempts: 0 }],
    });
    expect(claimNextTaskStep(db)).toBeUndefined();
  });

  it("reconciles work left running by a process exit", () => {
    const plan = createTaskPlan(db, {
      title: "restart",
      steps: [{ skill: "x", params: {} }],
      actor,
    });
    claimNextTaskStep(db);
    expect(reconcileInterruptedTasks(db)).toBe(1);
    expect(getTaskPlan(db, plan.id)).toMatchObject({
      status: "pending",
      steps: [{ status: "pending", attempts: 1 }],
    });
  });

  it("persists an immutable actor in the same plan record", () => {
    const plan = createTaskPlan(db, {
      title: "attributed",
      steps: [{ skill: "x", params: {} }],
      actor,
    });

    expect(plan.actor).toEqual(actor);
    expect(plan.actorAuthorizedAt).toEqual(expect.any(Number));
    expect(Object.isFrozen(plan.actor)).toBe(true);
  });
});
