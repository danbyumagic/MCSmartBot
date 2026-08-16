import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { createBus } from "../../src/bus/index.js";
import { createTaskEngine } from "../../src/tasks/engine.js";
import { createSkillRegistry } from "../../src/skills/registry.js";
import { defineSkill } from "../../src/skills/types.js";
import { createLogger } from "../../src/util/logger.js";
import { removePlayerRole, setPlayerRole } from "../../src/permissions/roles.js";
import {
  systemActor,
  snapshotExecutionActor,
} from "../../src/permissions/executionActor.js";
import { TaskPlanAuthorizationError } from "../../src/tasks/engine.js";
import { createClearRegionSkill } from "../../src/skills/world/clearRegion.js";
import { tossItem } from "../../src/skills/items/tossItem.js";
import { attackPlayer } from "../../src/skills/combat/attackPlayer.js";
import { clickWindowSlot } from "../../src/skills/interaction/clickWindowSlot.js";
import {
  attachMissionRunTaskPlan,
  createMissionRun,
} from "../../src/missions/store.js";

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

const skill = defineSkill({
  name: "demo",
  description: "demo",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  params: z.object({ value: z.number() }),
  run: async ({ value }) => ({ ok: true, summary: `value=${value}` }),
});

const ownerActor = systemActor("Owner", "recovery");
const operatorActor = snapshotExecutionActor({
  username: "Builder",
  role: "operator",
  source: "minecraft-chat",
});

function createEngine(options: {
  runner: Parameters<typeof createTaskEngine>[0]["runner"];
  registry?: ReturnType<typeof createSkillRegistry>;
  bus?: ReturnType<typeof createBus>;
  now?: () => number;
}): ReturnType<typeof createTaskEngine> {
  return createTaskEngine({
    db,
    log: createLogger({ level: "error" }),
    bus: options.bus ?? createBus(),
    registry: options.registry ?? createSkillRegistry([skill]),
    runner: options.runner,
    ownerUsername: "Owner",
    now: options.now,
  });
}

function missionDefinition(name: string, maxWorldChanges = 12): Record<string, unknown> {
  return {
    schema: "smartbot.mission/v1",
    name,
    limits: {
      maxLogicalSteps: 1,
      maxExpandedSteps: 1,
      maxWorldChanges,
      maxRuntimeMinutes: 1,
    },
    steps: [{ id: "demo-step", op: "skill", skill: "demo", params: { value: 7 } }],
  };
}

async function eventually(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("task engine", () => {
  it("runs a durable plan and emits completion", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ ok: true, summary: "done" }),
      cancel: vi.fn(), restart: vi.fn(), activeName: vi.fn().mockReturnValue(null),
    };
    const bus = createBus();
    const events: Array<{ kind: string; planId?: number }> = [];
    bus.on("agent.trigger", (event) => events.push(event));
    const engine = createEngine({ runner, bus });
    engine.start();
    const plan = engine.create({
      title: "demo plan",
      steps: [{ skill: "demo", params: { value: 7 } }],
      actor: ownerActor,
    });
    await eventually(() => engine.get(plan.id)?.status === "completed");
    expect(runner.run).toHaveBeenCalledWith(
      skill,
      { value: 7 },
      {
        waitForCompletion: true,
        emitTrigger: false,
        execution: expect.objectContaining({
          actor: expect.objectContaining({ username: "Owner", role: "owner" }),
          planId: plan.id,
        }),
      },
    );
    expect(events).toContainEqual(expect.objectContaining({
      kind: "taskPlanDone", planId: plan.id,
    }));
    engine.stop();
  });

  it("fails immediately for a non-recoverable result", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: false, summary: "bad input", code: "INVALID_PARAMS", recoverable: false,
      }),
      cancel: vi.fn(), restart: vi.fn(), activeName: vi.fn().mockReturnValue(null),
    };
    const bus = createBus();
    const engine = createEngine({ runner, bus });
    engine.start();
    const plan = engine.create({
      title: "bad plan",
      steps: [{ skill: "demo", params: { value: 7 } }],
      actor: ownerActor,
    });
    await eventually(() => engine.get(plan.id)?.status === "failed");
    expect(engine.get(plan.id)?.steps[0]).toMatchObject({
      status: "failed", attempts: 1, lastErrorCode: "INVALID_PARAMS",
    });
    engine.stop();
  });

  it("does not claim durable work while suspended and resumes afterward", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ ok: true, summary: "done" }),
      cancel: vi.fn(), restart: vi.fn(), activeName: vi.fn().mockReturnValue(null),
    };
    const engine = createEngine({ runner });
    engine.start();
    engine.suspend();
    const plan = engine.create({
      title: "wait for world",
      steps: [{ skill: "demo", params: { value: 1 } }],
      actor: ownerActor,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.run).not.toHaveBeenCalled();
    expect(engine.get(plan.id)?.status).toBe("pending");
    engine.resumeExecution();
    await eventually(() => engine.get(plan.id)?.status === "completed");
    expect(runner.run).toHaveBeenCalledOnce();
    engine.stop();
  });

  it("reuses an identical active plan instead of scheduling duplicate work", () => {
    const runner = {
      run: vi.fn(),
      cancel: vi.fn(),
      restart: vi.fn(),
      activeName: vi.fn().mockReturnValue(null),
    };
    const engine = createEngine({ runner });
    engine.start();
    engine.suspend();
    const input = {
      title: "same mission",
      steps: [{ skill: "demo", params: { value: 3 } }],
      actor: ownerActor,
    };

    const first = engine.create(input);
    const duplicate = engine.create(input);

    expect(duplicate.id).toBe(first.id);
    const count = db.prepare(
      "SELECT COUNT(*) AS count FROM task_plans WHERE title = ?",
    ).get(input.title) as { count: number };
    expect(count.count).toBe(1);
    engine.stop();
  });

  it("pauses an active step, cancels its runner, and resumes it once", async () => {
    let finishFirst!: (result: {
      ok: boolean;
      summary: string;
      code?: "INTERRUPTED";
      recoverable?: boolean;
    }) => void;
    const firstRun = new Promise<{
      ok: boolean;
      summary: string;
      code?: "INTERRUPTED";
      recoverable?: boolean;
    }>((resolve) => {
      finishFirst = resolve;
    });
    const runner = {
      run: vi.fn()
        .mockImplementationOnce(() => firstRun)
        .mockResolvedValueOnce({ ok: true, summary: "resumed and done" }),
      cancel: vi.fn(),
      restart: vi.fn(),
      activeName: vi.fn().mockReturnValue("demo"),
    };
    const engine = createEngine({ runner });
    engine.start();
    const plan = engine.create({
      title: "pauseable mission",
      steps: [{ skill: "demo", params: { value: 9 } }],
      actor: ownerActor,
    });
    await eventually(() => engine.activePlanId() === plan.id);

    expect(engine.pause(plan.id)).toBe(true);
    expect(runner.cancel).toHaveBeenCalledOnce();
    expect(engine.get(plan.id)).toMatchObject({
      status: "paused",
      steps: [{ status: "pending", attempts: 1 }],
    });
    finishFirst({
      ok: false,
      summary: "cancelled for pause",
      code: "INTERRUPTED",
      recoverable: true,
    });
    await eventually(() => engine.activePlanId() === null);

    expect(engine.resume(plan.id)).toBe(true);
    await eventually(() => engine.get(plan.id)?.status === "completed");
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(engine.get(plan.id)?.steps[0]?.attempts).toBe(2);
    engine.stop();
  });

  it("rejects an owner-only task at enqueue time with the first unauthorized step", () => {
    setPlayerRole(db, {
      username: "Builder",
      role: "operator",
      grantedBy: "Owner",
    });
    const ownerOnly = defineSkill({
      name: "ownerOnly",
      description: "owner only",
      policy: {
        minimumRole: "owner",
        effect: "administrative",
        reversible: false,
        mission: "forbidden",
      },
      params: z.object({}),
      run: async () => ({ ok: true, summary: "should not run" }),
    });
    const runner = {
      run: vi.fn(),
      cancel: vi.fn(), restart: vi.fn(), activeName: vi.fn().mockReturnValue(null),
    };
    const engine = createEngine({
      runner,
      registry: createSkillRegistry([skill, ownerOnly]),
    });

    expect(() => engine.create({
      title: "mixed privilege",
      actor: operatorActor,
      steps: [
        { skill: "demo", params: { value: 1 } },
        { skill: "ownerOnly", params: {} },
      ],
    })).toThrow(TaskPlanAuthorizationError);
    try {
      engine.create({
        title: "mixed privilege",
        actor: operatorActor,
        steps: [
          { skill: "demo", params: { value: 1 } },
          { skill: "ownerOnly", params: {} },
        ],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(TaskPlanAuthorizationError);
      expect((error as TaskPlanAuthorizationError).details).toMatchObject({
        stepIndex: 1,
        skill: "ownerOnly",
        minimumRole: "owner",
      });
    }
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("does not let an operator route real owner-only skills through a durable plan", () => {
    setPlayerRole(db, {
      username: "Builder",
      role: "operator",
      grantedBy: "Owner",
    });
    const runner = {
      run: vi.fn(),
      cancel: vi.fn(), restart: vi.fn(), activeName: vi.fn().mockReturnValue(null),
    };
    const clearRegion = createClearRegionSkill({ transactions: {} as never, serverKey: "test:25565" });
    const engine = createEngine({
      runner,
      registry: createSkillRegistry([skill, clearRegion, tossItem, attackPlayer, clickWindowSlot]),
    });

    for (const step of [
      {
        skill: "clearRegion",
        params: {
          from: { x: 0, y: 64, z: 0 }, to: { x: 0, y: 64, z: 0 },
          includeContainers: false, preserve: [], collectDrops: false,
        },
      },
      { skill: "tossItem", params: { item: "stone", count: 1 } },
      {
        skill: "attackPlayer",
        params: { selector: { username: "Target" }, mode: "once", maxHits: 1, maxSeconds: 1, maxRange: 2 },
      },
      { skill: "clickWindowSlot", params: { slot: 0, mouseButton: 0, mode: "click" } },
    ]) {
      expect(() => engine.create({ title: `denied ${step.skill}`, actor: operatorActor, steps: [step] }))
        .toThrow(TaskPlanAuthorizationError);
    }
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("reauthorizes immediately before each durable step and denies a revoked actor", async () => {
    setPlayerRole(db, {
      username: "Builder",
      role: "operator",
      grantedBy: "Owner",
    });
    const runner = {
      run: vi.fn().mockImplementation(async () => {
        removePlayerRole(db, "Builder");
        return { ok: true, summary: "first step done" };
      }),
      cancel: vi.fn(), restart: vi.fn(), activeName: vi.fn().mockReturnValue(null),
    };
    const engine = createEngine({ runner });
    engine.start();
    const plan = engine.create({
      title: "revocable work",
      actor: operatorActor,
      steps: [
        { skill: "demo", params: { value: 1 } },
        { skill: "demo", params: { value: 2 } },
      ],
    });

    await eventually(() => engine.get(plan.id)?.status === "failed");
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(engine.get(plan.id)?.steps).toMatchObject([
      { status: "completed" },
      { status: "failed", lastErrorCode: "PERMISSION_DENIED" },
    ]);
    engine.stop();
  });

  it("attaches deterministic recovery provenance to a legacy plan before execution", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ ok: true, summary: "recovered" }),
      cancel: vi.fn(), restart: vi.fn(), activeName: vi.fn().mockReturnValue(null),
    };
    const now = Date.now();
    const inserted = db.prepare(
      `INSERT INTO task_plans (ts_created, ts_updated, title, status)
       VALUES (?, ?, ?, 'pending')`,
    ).run(now, now, "legacy plan");
    const planId = Number(inserted.lastInsertRowid);
    db.prepare(
      `INSERT INTO task_steps
        (plan_id, position, skill, params_json, status, max_attempts)
       VALUES (?, 0, 'demo', ?, 'pending', 3)`,
    ).run(planId, JSON.stringify({ value: 4 }));

    const engine = createEngine({ runner });
    engine.start();
    await eventually(() => engine.get(planId)?.status === "completed");

    expect(engine.get(planId)?.actor).toMatchObject({
      username: "Owner",
      role: "owner",
      source: "recovery",
    });
    expect(runner.run).toHaveBeenCalledWith(
      skill,
      { value: 4 },
      expect.objectContaining({
        execution: expect.objectContaining({
          actor: expect.objectContaining({ source: "recovery" }),
        }),
      }),
    );
    engine.stop();
  });

  it("passes immutable linked mission limits into the skill execution context", async () => {
    let clock = 1_000;
    const runner = {
      run: vi.fn().mockResolvedValue({ ok: true, summary: "done" }),
      cancel: vi.fn(), restart: vi.fn(), activeName: vi.fn().mockReturnValue(null),
    };
    const engine = createEngine({ runner, now: () => clock });
    engine.start();
    engine.suspend();
    const plan = engine.create({
      title: "linked mission plan",
      steps: [{ skill: "demo", params: { value: 7 } }],
      actor: ownerActor,
    });
    const run = createMissionRun(db, {
      definition: missionDefinition("linked-mission", 17),
      actor: ownerActor,
      transactionCorrelation: { request: "mission-request" },
      deadlineAt: clock + 30_000,
    }, clock);
    attachMissionRunTaskPlan(db, run.id, plan.id, clock);
    // This engine-focused fixture does not materialize compiler link metadata.
    // The mission service/store tests cover that boundary; here we model the
    // committed runnable state that TaskEngine is allowed to claim.
    db.prepare("UPDATE mission_runs SET status = 'running', ts_started = ? WHERE id = ?").run(clock, run.id);

    engine.resumeExecution();
    await eventually(() => engine.get(plan.id)?.status === "completed");

    expect(runner.run).toHaveBeenCalledWith(
      skill,
      { value: 7 },
      {
        waitForCompletion: true,
        emitTrigger: false,
        execution: expect.objectContaining({
          actor: ownerActor,
          planId: plan.id,
          missionRunId: run.id,
          deadlineAt: run.deadlineAt,
          maxWorldChanges: 17,
          transactionScope: `mission:${run.id}`,
          transactionCorrelation: { request: "mission-request" },
        }),
      },
    );
    engine.stop();
  });

  it("fails an expired linked mission before invoking its skill", async () => {
    let clock = 1_000;
    const runner = {
      run: vi.fn(),
      cancel: vi.fn(), restart: vi.fn(), activeName: vi.fn().mockReturnValue(null),
    };
    const engine = createEngine({ runner, now: () => clock });
    engine.start();
    engine.suspend();
    const plan = engine.create({
      title: "expired mission plan",
      steps: [{ skill: "demo", params: { value: 7 } }],
      actor: ownerActor,
    });
    const run = createMissionRun(db, {
      definition: missionDefinition("expired-mission"),
      actor: ownerActor,
      deadlineAt: clock + 1,
    }, clock);
    attachMissionRunTaskPlan(db, run.id, plan.id, clock);
    db.prepare("UPDATE mission_runs SET status = 'running', ts_started = ? WHERE id = ?").run(clock, run.id);
    clock += 1;

    engine.resumeExecution();
    await eventually(() => engine.get(plan.id)?.status === "failed");

    expect(runner.run).not.toHaveBeenCalled();
    expect(engine.get(plan.id)?.steps[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      lastErrorCode: "TIMED_OUT",
    });
    engine.stop();
  });

  it("does not claim a linked plan until its mission run is durably running", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ ok: true, summary: "should not run" }),
      cancel: vi.fn(), restart: vi.fn(), activeName: vi.fn().mockReturnValue(null),
    };
    const engine = createEngine({ runner });
    engine.start();
    engine.suspend();
    const plan = engine.create({
      title: "held mission plan",
      steps: [{ skill: "demo", params: { value: 7 } }],
      actor: ownerActor,
    });
    const run = createMissionRun(db, {
      definition: missionDefinition("held-mission"),
      actor: ownerActor,
    });
    attachMissionRunTaskPlan(db, run.id, plan.id);

    engine.resumeExecution();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runner.run).not.toHaveBeenCalled();
    expect(engine.get(plan.id)).toMatchObject({ status: "pending", steps: [{ status: "pending" }] });
    engine.stop();
  });
});
