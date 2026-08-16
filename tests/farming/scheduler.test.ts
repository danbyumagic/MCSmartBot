import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { createBus } from "../../src/bus/index.js";
import { createFarmScheduler } from "../../src/farming/scheduler.js";
import { createTaskPlan } from "../../src/tasks/store.js";
import { createLogger } from "../../src/util/logger.js";

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

describe("farm scheduler", () => {
  it("creates a durable harvest plan for a due farm", () => {
    const tasks = {
      create: vi.fn(({ title, steps, actor }) => createTaskPlan(db, { title, steps, actor })),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as any;
    const scheduler = createFarmScheduler({
      db,
      bus: createBus(),
      log: createLogger({ level: "error" }),
      tasks,
      ownerUsername: "owner",
      now: () => 1_000,
    });
    const farm = scheduler.register({
      name: "wheat", minX: 0, minY: 65, minZ: 0,
      maxX: 3, maxY: 65, maxZ: 3, crop: "wheat",
    });
    expect(tasks.create).toHaveBeenCalledWith({
      title: "maintain farm wheat",
      steps: [{
        skill: "harvestFarm",
        params: { farmName: "wheat" },
        maxAttempts: 3,
      }],
      actor: schedulerActor,
    });
    expect(scheduler.get(farm.id)?.lastPlanId).toBeGreaterThan(0);
  });
});
