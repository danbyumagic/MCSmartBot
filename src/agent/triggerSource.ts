import type { AgentTrigger } from "../bus/index.js";
import type { FactSource } from "../memory/facts.js";

export interface TriggerSourceState {
  current: FactSource;
}

/** Initial state. Defaults to "observation" so any fact written before a trigger
 * lands (effectively impossible in normal flow, but defensive) is tagged
 * conservatively as observation, not chat. */
export function createTriggerSourceState(): TriggerSourceState {
  return { current: "observation" };
}

export function sourceFromTrigger(trigger: AgentTrigger): FactSource {
  switch (trigger.kind) {
    case "chat":
      return "chat";
    case "cli":
      return "cli";
    case "skillDone":
    case "skillFailed":
    case "reflexAlert":
    case "taskPlanDone":
    case "taskPlanFailed":
    case "botDeath":
    case "botRespawn":
    case "idleTick":
      return "observation";
  }
}
