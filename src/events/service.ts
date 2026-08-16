import type { AgentTrigger, Bus, WorldEvent } from "../bus/index.js";
import type { DB } from "../memory/db.js";
import type { Logger } from "../util/logger.js";
import {
  markEventNotified,
  recordEvent,
  shouldNotify,
} from "./store.js";

export interface EventService {
  start(): void;
  stop(): void;
}

export function createEventService(deps: {
  db: DB;
  bus: Bus;
  log: Logger;
  notifyOwner: (message: string) => void;
}): EventService {
  let started = false;

  const handleEvent = (event: WorldEvent): void => {
    const row = recordEvent(deps.db, event);
    if (!shouldNotify(deps.db, event)) return;
    try {
      deps.notifyOwner(`[${event.severity}] ${event.summary}`);
      markEventNotified(deps.db, row.id);
    } catch (err) {
      deps.log.warn({ err, eventType: event.type }, "event notification failed");
    }
  };

  const handleTrigger = (trigger: AgentTrigger): void => {
    const event = eventFromTrigger(trigger);
    if (event) handleEvent(event);
  };

  function start(): void {
    if (started) return;
    started = true;
    deps.bus.on("world.event", handleEvent);
    deps.bus.on("agent.trigger", handleTrigger);
  }

  function stop(): void {
    if (!started) return;
    started = false;
    deps.bus.off("world.event", handleEvent);
    deps.bus.off("agent.trigger", handleTrigger);
  }

  return { start, stop };
}

function eventFromTrigger(trigger: AgentTrigger): WorldEvent | undefined {
  switch (trigger.kind) {
    case "botDeath":
      return { type: "bot_death", severity: "critical", summary: "bot died" };
    case "botRespawn":
      return { type: "bot_respawn", severity: "info", summary: "bot respawned" };
    case "taskPlanFailed":
      return {
        type: "task_failed",
        severity: "warning",
        summary: `task ${trigger.planId} '${trigger.title}' failed: ${trigger.error}`,
        details: { planId: trigger.planId, title: trigger.title, error: trigger.error },
      };
    case "taskPlanDone":
      return {
        type: "task_completed",
        severity: "info",
        summary: `task ${trigger.planId} '${trigger.title}' completed`,
        details: { planId: trigger.planId, title: trigger.title },
      };
    case "skillFailed":
      return {
        type: "skill_failed",
        severity: "warning",
        summary: `${trigger.skill} failed: ${trigger.error}`,
        details: {
          skill: trigger.skill,
          code: trigger.code,
          recoverable: trigger.recoverable,
          ...trigger.details,
        },
      };
    case "reflexAlert":
      return {
        type: "reflex_alert",
        severity: "warning",
        summary: trigger.summary,
      };
    default:
      return undefined;
  }
}
