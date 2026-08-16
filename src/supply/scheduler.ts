import type { AgentTrigger, Bus } from "../bus/index.js";
import type { DB } from "../memory/db.js";
import type { TaskEngine } from "../tasks/engine.js";
import type { Logger } from "../util/logger.js";
import { systemActor } from "../permissions/executionActor.js";
import {
  createSupplyGoal,
  finishSupplyGoalPlan,
  getSupplyGoal,
  listDueSupplyGoals,
  markSupplyGoalPlan,
  setSupplyGoalStatus,
  type SupplyGoalInput,
  type SupplyGoalRow,
  type SupplyGoalStatus,
} from "./store.js";

export interface SupplyScheduler {
  start(): void;
  stop(): void;
  wake(): void;
  create(input: SupplyGoalInput): SupplyGoalRow;
  get(id: number): SupplyGoalRow | undefined;
  setStatus(id: number, status: SupplyGoalStatus): boolean;
}

export function createSupplyScheduler(deps: {
  db: DB;
  bus: Bus;
  log: Logger;
  tasks: TaskEngine;
  ownerUsername: string;
  now?: () => number;
  pollMs?: number;
}): SupplyScheduler {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  function tick(): void {
    if (ticking) return;
    ticking = true;
    try {
      for (const goal of listDueSupplyGoals(deps.db, now())) {
        try {
          const plan = deps.tasks.create({
            title: `supply ${goal.containerName} with ${goal.targetQuantity} ${goal.item}`,
            steps: [{
              skill: "supplyContainer",
              params: {
                chestName: goal.containerName,
                item: goal.item,
                quantity: goal.targetQuantity,
                searchRadius: goal.searchRadius,
              },
              maxAttempts: 3,
            }],
            actor: systemActor(deps.ownerUsername, "scheduler"),
          });
          markSupplyGoalPlan(deps.db, goal.id, plan.id, now());
          deps.log.info({ goalId: goal.id, planId: plan.id }, "standing supply check scheduled");
        } catch (err) {
          deps.log.error({ err, goalId: goal.id }, "could not schedule standing supply check");
        }
      }
    } finally {
      ticking = false;
    }
  }

  const onTrigger = (trigger: AgentTrigger) => {
    if (trigger.kind === "taskPlanDone") {
      finishSupplyGoalPlan(deps.db, trigger.planId, {}, now());
    } else if (trigger.kind === "taskPlanFailed") {
      finishSupplyGoalPlan(deps.db, trigger.planId, { error: trigger.error }, now());
    }
  };

  function start(): void {
    if (timer) return;
    deps.bus.on("agent.trigger", onTrigger);
    timer = setInterval(tick, pollMs);
    tick();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    deps.bus.off("agent.trigger", onTrigger);
  }

  function create(input: SupplyGoalInput): SupplyGoalRow {
    const goal = createSupplyGoal(deps.db, input, now());
    tick();
    return goal;
  }

  function setStatus(id: number, status: SupplyGoalStatus): boolean {
    const existing = getSupplyGoal(deps.db, id);
    const changed = setSupplyGoalStatus(deps.db, id, status, now());
    if (!changed) return false;
    if (existing?.lastPlanId) {
      if (status === "paused") deps.tasks.pause(existing.lastPlanId);
      else if (status === "cancelled") deps.tasks.cancel(existing.lastPlanId);
      else if (status === "active" && deps.tasks.resume(existing.lastPlanId)) {
        markSupplyGoalPlan(deps.db, id, existing.lastPlanId, now());
        return true;
      }
    }
    if (status === "active") tick();
    return changed;
  }

  return {
    start,
    stop,
    wake: tick,
    create,
    get: (id) => getSupplyGoal(deps.db, id),
    setStatus,
  };
}
