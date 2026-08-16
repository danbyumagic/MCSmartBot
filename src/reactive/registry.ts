import type { Bot } from "mineflayer";
import type { Reflex } from "./types.js";

export interface ReflexRegistry {
  all(): readonly Reflex[];
  /** Returns the highest-priority reflex whose check() passes, or null. */
  findFiring(bot: Bot): Reflex | null;
}

export function createReflexRegistry(reflexes: Reflex[]): ReflexRegistry {
  const seen = new Set<string>();
  for (const r of reflexes) {
    if (seen.has(r.name)) throw new Error(`duplicate reflex name: ${r.name}`);
    seen.add(r.name);
  }
  const ordered = [...reflexes].sort((a, b) => b.priority - a.priority);
  return {
    all: () => ordered,
    findFiring: (bot) => ordered.find((r) => r.check(bot)) ?? null,
  };
}
