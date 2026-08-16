import type { Bot } from "mineflayer";

export interface Reflex {
  name: string;
  /** Higher fires first when multiple reflexes' check() passes the same tick. */
  priority: number;
  /** Cheap predicate; called every physicsTick. Must not throw. */
  check(bot: Bot): boolean;
  /** Action to take when the reflex fires. Receives an AbortSignal for the 10s timeout. */
  run(bot: Bot, signal: AbortSignal): Promise<void>;
}
