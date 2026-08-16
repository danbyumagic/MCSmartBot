import type { AgentTrigger, Bus } from "../bus/index.js";
import type { DB } from "../memory/db.js";
import type { TaskEngine } from "../tasks/engine.js";
import type { Logger } from "../util/logger.js";
import { systemActor } from "../permissions/executionActor.js";
import {
  finishFarmPlan,
  getFarm,
  listDueFarms,
  markFarmPlan,
  setFarmStatus,
  upsertFarm,
  type FarmInput,
  type FarmRow,
  type FarmStatus,
} from "./store.js";

export interface FarmScheduler {
  start(): void;
  stop(): void;
  wake(): void;
  register(input: FarmInput): FarmRow;
  get(id: number): FarmRow | undefined;
  setStatus(id: number, status: FarmStatus): boolean;
}

export function createFarmScheduler(deps: {
  db: DB;
  bus: Bus;
  log: Logger;
  tasks: TaskEngine;
  ownerUsername: string;
  now?: () => number;
  pollMs?: number;
}): FarmScheduler {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  function tick(): void {
    if (ticking) return;
    ticking = true;
    try {
      for (const farm of listDueFarms(deps.db, now())) {
        try {
          const plan = deps.tasks.create({
            title: `maintain farm ${farm.name}`,
            steps: [{
              skill: "harvestFarm",
              params: { farmName: farm.name },
              maxAttempts: 3,
            }],
            actor: systemActor(deps.ownerUsername, "scheduler"),
          });
          markFarmPlan(deps.db, farm.id, plan.id, now());
          deps.log.info({ farmId: farm.id, planId: plan.id }, "farm maintenance scheduled");
        } catch (err) {
          deps.log.error({ err, farmId: farm.id }, "could not schedule farm maintenance");
        }
      }
    } finally {
      ticking = false;
    }
  }

  const onTrigger = (trigger: AgentTrigger) => {
    if (trigger.kind === "taskPlanDone") {
      finishFarmPlan(deps.db, trigger.planId, undefined, now());
    } else if (trigger.kind === "taskPlanFailed") {
      finishFarmPlan(deps.db, trigger.planId, trigger.error, now());
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

  function register(input: FarmInput): FarmRow {
    const farm = upsertFarm(deps.db, input, now());
    tick();
    return farm;
  }

  function setStatus(id: number, status: FarmStatus): boolean {
    const existing = getFarm(deps.db, id);
    const changed = setFarmStatus(deps.db, id, status, now());
    if (!changed) return false;
    if (existing?.lastPlanId) {
      if (status === "paused") deps.tasks.pause(existing.lastPlanId);
      else if (status === "cancelled") deps.tasks.cancel(existing.lastPlanId);
      else if (status === "active" && deps.tasks.resume(existing.lastPlanId)) {
        markFarmPlan(deps.db, id, existing.lastPlanId, now());
        return true;
      }
    }
    if (status === "active") tick();
    return true;
  }

  return {
    start,
    stop,
    wake: tick,
    register,
    get: (id) => getFarm(deps.db, id),
    setStatus,
  };
}
