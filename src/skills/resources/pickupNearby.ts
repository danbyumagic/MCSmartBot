import { z } from "zod";
import pathfinderPkg from "mineflayer-pathfinder";
import { defineSkill } from "../types.js";
import { pathfindTo } from "../pathfinder.js";

const { goals } = pathfinderPkg;

interface ItemDrop {
  id: number;
  position: { x: number; y: number; z: number };
  name: string;
  dist: number;
}

function findDrops(bot: import("mineflayer").Bot, radius: number, filter?: string): ItemDrop[] {
  if (!bot.entity) return [];
  const me = bot.entity.position;
  const drops: ItemDrop[] = [];
  for (const [idStr, e] of Object.entries(bot.entities)) {
    if (!e || !e.position) continue;
    if (e.name !== "item") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itemMeta = (e as any).metadata?.find?.((m: any) => m && m.itemId !== undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itemName: string | undefined = (e as any).objectName ?? (e as any).itemName ?? itemMeta?.name;
    if (filter && (!itemName || !itemName.toLowerCase().includes(filter.toLowerCase()))) continue;
    const dx = me.x - e.position.x, dy = me.y - e.position.y, dz = me.z - e.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > radius) continue;
    drops.push({
      id: Number(idStr),
      position: { x: e.position.x, y: e.position.y, z: e.position.z },
      name: itemName ?? "item",
      dist,
    });
  }
  drops.sort((a, b) => a.dist - b.dist);
  return drops;
}

export const pickupNearby = defineSkill({
  name: "pickupNearby",
  policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
  description:
    "Pick up dropped items within `radius` blocks. Mineflayer auto-collects items the bot " +
    "steps onto. Optional `filter` substring restricts to items whose name contains it " +
    "(e.g., filter='iron' picks up iron ingots, iron ore, raw iron, etc.). Use when the " +
    "owner says 'grab my stuff' / 'pick up the drops' / 'collect the items'.",
  params: z.object({
    radius: z.number().int().min(2).max(64).default(16),
    filter: z.string().min(1).max(32).optional(),
  }),
  async run({ radius, filter }, ctx) {
    const drops = findDrops(ctx.bot, radius, filter);
    if (drops.length === 0) {
      const desc = filter ? `'${filter}' drops` : "drops";
      return { ok: true, summary: `no ${desc} within ${radius}` };
    }
    let picked = 0;
    for (const drop of drops) {
      if (ctx.signal.aborted) {
        return {
          ok: false, summary: `pickupNearby cancelled after ${picked}/${drops.length}`,
          code: "INTERRUPTED", recoverable: true,
          details: { picked, target: drops.length, filter: filter ?? null },
        };
      }
      const goal = new goals.GoalNear(
        Math.floor(drop.position.x),
        Math.floor(drop.position.y),
        Math.floor(drop.position.z),
        1,
      );
      try {
        await pathfindTo(ctx.bot, goal, ctx.signal);
        picked++;
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg === "aborted") {
          return {
            ok: false, summary: `pickupNearby cancelled after ${picked}/${drops.length}`,
            code: "INTERRUPTED", recoverable: true,
            details: { picked, target: drops.length, filter: filter ?? null },
          };
        }
        // Best-effort: one unreachable drop doesn't fail the whole skill.
        ctx.log.debug({ err: msg, drop: drop.name }, "could not reach drop, continuing");
      }
    }
    return { ok: true, summary: `walked over ${picked}/${drops.length} drops`, data: { picked } };
  },
});
