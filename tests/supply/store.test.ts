import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import {
  createSupplyGoal,
  finishSupplyGoalPlan,
  getSupplyGoal,
  listDueSupplyGoals,
  markSupplyGoalPlan,
  setSupplyGoalStatus,
} from "../../src/supply/store.js";
import { createTaskPlan } from "../../src/tasks/store.js";
import { systemActor } from "../../src/permissions/executionActor.js";

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

describe("supply goal store", () => {
  it("creates an immediately due standing goal", () => {
    const goal = createSupplyGoal(db, {
      containerName: "base",
      item: "iron_ingot",
      targetQuantity: 64,
      intervalMinutes: 15,
    }, 1_000);
    expect(goal).toMatchObject({
      status: "active", nextCheckAt: 1_000, targetQuantity: 64,
    });
    expect(listDueSupplyGoals(db, 1_000)).toHaveLength(1);
  });

  it("tracks its current plan and schedules the next successful check", () => {
    const goal = createSupplyGoal(db, {
      containerName: "base", item: "iron_ingot", targetQuantity: 64,
      intervalMinutes: 10,
    }, 1_000);
    const plan = createTaskPlan(db, {
      title: "supply",
      steps: [{ skill: "supplyContainer", params: {} }],
      actor: systemActor("owner", "scheduler"),
    });
    markSupplyGoalPlan(db, goal.id, plan.id, 2_000);
    expect(getSupplyGoal(db, goal.id)?.lastPlanId).toBe(plan.id);
    finishSupplyGoalPlan(db, plan.id, {}, 3_000);
    expect(getSupplyGoal(db, goal.id)?.nextCheckAt).toBe(603_000);
  });

  it("supports pause resume and cancellation", () => {
    const goal = createSupplyGoal(db, {
      containerName: "base", item: "iron_ingot", targetQuantity: 64,
    }, 1_000);
    expect(setSupplyGoalStatus(db, goal.id, "paused", 2_000)).toBe(true);
    expect(getSupplyGoal(db, goal.id)?.status).toBe("paused");
    expect(setSupplyGoalStatus(db, goal.id, "active", 3_000)).toBe(true);
    expect(getSupplyGoal(db, goal.id)?.nextCheckAt).toBe(3_000);
    expect(setSupplyGoalStatus(db, goal.id, "cancelled", 4_000)).toBe(true);
    expect(setSupplyGoalStatus(db, goal.id, "active", 5_000)).toBe(false);
  });
});
