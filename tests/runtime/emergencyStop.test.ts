import { describe, expect, it, vi } from "vitest";
import { runEmergencyStop } from "../../src/runtime/emergencyStop.js";
import { createLogger } from "../../src/util/logger.js";

describe("runEmergencyStop", () => {
  it("cancels every safety surface and returns a summary", () => {
    const order: string[] = [];
    const log = createLogger({ level: "error", pretty: false });
    const result = runEmergencyStop({
      source: "alice",
      activeSkill: () => { order.push("active"); return "mineUntil"; },
      clearTriggers: () => { order.push("triggers"); return 3; },
      cancelAgent: () => { order.push("agent"); return true; },
      cancelPreempt: () => { order.push("preempt"); },
      cancelSkills: () => { order.push("skill"); },
      pauseActivePlan: () => { order.push("plan"); return { planId: 42, paused: true }; },
      bot: {
        pathfinder: { setGoal: () => { order.push("goal"); } },
        clearControlStates: () => { order.push("controls"); },
      },
      log,
    });

    expect(result).toEqual({
      activeSkill: "mineUntil",
      discardedTriggers: 3,
      agentCancelled: true,
      pausedPlanId: 42,
    });
    expect(order).toEqual([
      "active", "triggers", "agent", "preempt", "skill", "plan", "goal", "controls",
    ]);
  });

  it("continues after partial or throwing APIs", () => {
    const clearControlStates = vi.fn();
    const result = runEmergencyStop({
      activeSkill: () => { throw new Error("partial skill"); },
      clearTriggers: () => { throw new Error("queue unavailable"); },
      cancelAgent: () => false,
      cancelPreempt: () => { throw new Error("preempt unavailable"); },
      cancelSkills: () => { throw new Error("runner unavailable"); },
      pauseActivePlan: () => { throw new Error("plan unavailable"); },
      bot: {
        pathfinder: { setGoal: () => { throw new Error("pathfinder unavailable"); } },
        clearControlStates,
      },
      log: createLogger({ level: "error", pretty: false }),
    });
    expect(result).toEqual({
      activeSkill: null,
      discardedTriggers: 0,
      agentCancelled: false,
      pausedPlanId: null,
    });
    expect(clearControlStates).toHaveBeenCalledOnce();
  });
});
