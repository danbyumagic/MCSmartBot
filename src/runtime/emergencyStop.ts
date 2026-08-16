import type { Logger } from "../util/logger.js";
import type { EmergencyStopResult } from "./state.js";

export interface EmergencyStopDependencies {
  source?: string;
  activeSkill: () => string | null;
  clearTriggers: () => number;
  cancelAgent: () => boolean;
  cancelPreempt: () => void;
  cancelSkills: () => void;
  pauseActivePlan: () => { planId: number; paused: boolean } | undefined;
  bot?: {
    pathfinder?: { setGoal: (goal: null) => void };
    clearControlStates?: () => void;
  };
  log: Logger;
}

export function runEmergencyStop(
  deps: EmergencyStopDependencies,
): EmergencyStopResult {
  const failures: string[] = [];
  let activeSkill: string | null = null;
  let discardedTriggers = 0;
  let agentCancelled = false;
  let pausedPlanId: number | null = null;

  try {
    activeSkill = deps.activeSkill();
  } catch (error) {
    failures.push(errorMessage(error));
  }
  try {
    discardedTriggers = deps.clearTriggers();
  } catch (error) {
    failures.push(errorMessage(error));
  }
  try {
    agentCancelled = deps.cancelAgent();
  } catch (error) {
    failures.push(errorMessage(error));
  }
  try {
    deps.cancelPreempt();
  } catch (error) {
    failures.push(errorMessage(error));
  }
  try {
    deps.cancelSkills();
  } catch (error) {
    failures.push(errorMessage(error));
  }
  try {
    const plan = deps.pauseActivePlan();
    pausedPlanId = plan?.paused ? plan.planId : null;
  } catch (error) {
    failures.push(errorMessage(error));
  }
  try {
    deps.bot?.pathfinder?.setGoal(null);
  } catch (error) {
    failures.push(errorMessage(error));
  }
  try {
    deps.bot?.clearControlStates?.();
  } catch (error) {
    failures.push(errorMessage(error));
  }

  const result: EmergencyStopResult = {
    activeSkill,
    discardedTriggers,
    agentCancelled,
    pausedPlanId,
  };
  try {
    deps.log.warn(
      {
        source: deps.source ?? "unknown",
        ...result,
        failures: failures.length,
      },
      "owner emergency stop",
    );
  } catch {
    // The safety primitive must still return even if logging is unavailable.
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
