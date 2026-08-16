import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { createBus } from "../../src/bus/index.js";
import { createSupplyScheduler } from "../../src/supply/scheduler.js";
import { createLogger } from "../../src/util/logger.js";
import { createTaskPlan } from "../../src/tasks/store.js";

const schedulerActor = {
  username: "owner",
  role: "owner" as const,
  source: "scheduler" as const,
};

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

describe("supply scheduler", () => {
  it("turns a standing goal into a durable supplyContainer plan", () => {
    const tasks = {
      create: vi.fn(({ title, steps, actor }) => createTaskPlan(db, { title, steps, actor })),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as any;
    const scheduler = createSupplyScheduler({
      db,
      bus: createBus(),
      log: createLogger({ level: "error" }),
      tasks,
      ownerUsername: "owner",
      now: () => 1_000,
    });
    const goal = scheduler.create({
      containerName: "base",
      item: "iron_ingot",
      targetQuantity: 64,
      intervalMinutes: 15,
    });
    expect(tasks.create).toHaveBeenCalledWith({
      title: "supply base with 64 iron_ingot",
      steps: [{
        skill: "supplyContainer",
        params: {
          chestName: "base", item: "iron_ingot", quantity: 64, searchRadius: 64,
        },
        maxAttempts: 3,
      }],
      actor: schedulerActor,
    });
    expect(scheduler.get(goal.id)?.lastPlanId).toBeGreaterThan(0);
  });

  it("records task failure and schedules an earlier retry", () => {
    let clock = 1_000;
    const bus = createBus();
    let createdPlanId = 0;
    const tasks = {
      create: vi.fn(({ title, steps, actor }) => {
        const plan = createTaskPlan(db, { title, steps, actor });
        createdPlanId = plan.id;
        return plan;
      }),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as any;
    const scheduler = createSupplyScheduler({
      db,
      bus,
      log: createLogger({ level: "error" }),
      tasks,
      ownerUsername: "owner",
      now: () => clock,
      pollMs: 60_000,
    });
    scheduler.start();
    const goal = scheduler.create({
      containerName: "base", item: "iron_ingot", targetQuantity: 64,
      intervalMinutes: 15,
    });
    clock = 2_000;
    bus.emit("agent.trigger", {
      kind: "taskPlanFailed", planId: createdPlanId, title: "supply", error: "no iron",
    });
    expect(scheduler.get(goal.id)).toMatchObject({
      lastError: "no iron",
      nextCheckAt: 302_000,
    });
    scheduler.stop();
  });
});
