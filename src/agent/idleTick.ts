import type { DB } from "../memory/db.js";
import type { Bus } from "../bus/index.js";
import type { Logger } from "../util/logger.js";
import type { SkillRunner } from "../skills/runner.js";
import { getOpenGoal } from "../memory/goals.js";

export interface IdleTickerDeps {
  db: DB;
  bus: Bus;
  log: Logger;
  runner: SkillRunner;
  intervalMinutes: number;
  /** Shared state object; the controller mutates `.value` so consumers can update it. */
  lastActivityAt: { value: number };
  /**
   * Time source for tests. Defaults to Date.now. Used for both "current time"
   * comparisons and for the new last-activity bump after firing.
   */
  now?: () => number;
}

export function bumpActivity(state: { value: number }, now: () => number = Date.now): void {
  state.value = now();
}

export function startIdleTicker(deps: IdleTickerDeps): { stop: () => void } {
  const intervalMs = Math.max(60_000, deps.intervalMinutes * 60_000);
  const now = deps.now ?? Date.now;
  // Poll once per minute; the actual idle threshold is intervalMs.
  const pollMs = Math.min(intervalMs, 60_000);
  const handle = setInterval(() => {
    if (deps.runner.activeName()) return;
    const idleFor = now() - deps.lastActivityAt.value;
    if (idleFor < intervalMs) return;
    const open = getOpenGoal(deps.db);
    if (!open) return;
    deps.log.debug({ goal: open.text }, "idleTick fire");
    deps.bus.emit("agent.trigger", { kind: "idleTick" });
    bumpActivity(deps.lastActivityAt, now);
  }, pollMs);
  return { stop: () => clearInterval(handle) };
}
