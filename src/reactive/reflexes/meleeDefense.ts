import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Reflex } from "../types.js";

const HOSTILE_TYPES = new Set([
  "zombie", "skeleton", "spider", "creeper", "enderman", "witch",
  "husk", "stray", "drowned", "phantom", "pillager", "vindicator",
  "vex", "warden", "wither_skeleton", "blaze", "ghast", "magma_cube",
  "slime", "silverfish", "guardian", "elder_guardian", "evoker",
  "ravager", "piglin", "zoglin", "hoglin", "shulker", "endermite",
  "cave_spider",
]);

export function nearestHostile(bot: Bot, maxDist: number): { entity: Entity; dist: number } | null {
  if (!bot.entity) return null;
  const me = bot.entity.position;
  let best: { entity: Entity; dist: number } | null = null;
  for (const e of Object.values(bot.entities)) {
    if (!e.position) continue;
    const name = (e.name ?? "").toLowerCase();
    if (!HOSTILE_TYPES.has(name)) continue;
    const d = me.distanceTo(e.position);
    if (d > maxDist) continue;
    if (!best || d < best.dist) best = { entity: e, dist: d };
  }
  return best;
}

export const meleeDefense: Reflex = {
  name: "meleeDefense",
  priority: 100,
  check: (bot) => nearestHostile(bot, 2) !== null,
  async run(bot, signal) {
    while (!signal.aborted) {
      const target = nearestHostile(bot, 4);
      if (!target) return;
      try {
        await bot.lookAt(target.entity.position.offset(0, target.entity.height ?? 1, 0));
        if (signal.aborted) return;
        bot.attack(target.entity);
      } catch {
        // single-tick failures are fine; loop tries again
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  },
};
