import { z } from "zod";
import { Vec3 } from "vec3";
import pathfinderPkg from "mineflayer-pathfinder";
import { defineSkill, type SkillDefinition } from "../types.js";
import { pathfindTo } from "../pathfinder.js";
import { getLocation } from "../../memory/locations.js";
import type { DB } from "../../memory/db.js";

const { goals } = pathfinderPkg;

const params = z.object({
  chestName: z.string().min(1).max(64).describe("Named location of the chest (e.g., 'main', 'storage')"),
  itemFilter: z
    .string()
    .max(64)
    .default("")
    .describe("Substring filter for item names (empty = deposit everything that fits)"),
  keepCount: z.number().int().min(0).max(256).default(0).describe(
    "Minimum total count of matching items to retain in bot inventory",
  ),
});

export function chestDeposit(db: DB): SkillDefinition<z.infer<typeof params>> {
  return defineSkill({
    name: "chestDeposit",
    policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
    description:
      "Deposit items into a remembered chest location. Pathfinds to the chest, opens it, and " +
      "deposits items whose name contains `itemFilter` (or everything if no filter). The chest " +
      "must have been remembered via `rememberLocation` first. Use when the owner says " +
      "'stash this', 'put it in the main chest', 'deposit my iron'.",
    params,
    async run({ chestName, itemFilter, keepCount }, ctx) {
      const loc = getLocation(db, chestName);
      if (!loc) {
        return {
          ok: false,
          summary: `no location named '${chestName}'. ask the owner to remember the chest location first.`,
          code: "NOT_CONFIGURED",
          recoverable: true,
          details: { requiredLocation: chestName },
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bot = ctx.bot as any;
      const goal = new goals.GoalNear(loc.x, loc.y, loc.z, 2);
      try {
        await pathfindTo(ctx.bot, goal, ctx.signal);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg === "aborted") {
          return { ok: false, summary: `chestDeposit cancelled.`, code: "INTERRUPTED", recoverable: true };
        }
        return {
          ok: false, summary: `chestDeposit failed to reach chest: ${msg}`,
          code: "NO_PATH", recoverable: true, details: { chestName, message: msg },
        };
      }

      // Open the chest at the location.
      // bot.blockAt needs a real Vec3 (it calls .floored() internally), not a plain object.
      const blockAtPos = bot.blockAt(new Vec3(loc.x, loc.y, loc.z));
      if (!blockAtPos || !/chest|barrel|shulker_box/.test(blockAtPos.name ?? "")) {
        return {
          ok: false,
          summary: `no chest at ${loc.x},${loc.y},${loc.z} (found '${blockAtPos?.name ?? "nothing"}')`,
          code: "TARGET_UNAVAILABLE",
          recoverable: true,
          details: { chestName, x: loc.x, y: loc.y, z: loc.z, found: blockAtPos?.name ?? null },
        };
      }
      let container;
      try {
        container = await bot.openContainer(blockAtPos);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        return {
          ok: false, summary: `failed to open chest: ${message}`,
          code: "TARGET_UNAVAILABLE", recoverable: true, details: { chestName, message },
        };
      }

      const filterLower = itemFilter.trim().toLowerCase();
      const items = (bot.inventory.items?.() ?? []) as Array<{ name?: string; count?: number; type?: number; slot?: number }>;
      let deposited = 0;
      let reserveRemaining = keepCount;
      try {
        for (const item of items) {
          if (ctx.signal.aborted) break;
          if (!item || !item.name || typeof item.count !== "number") continue;
          if (filterLower && !item.name.toLowerCase().includes(filterLower)) continue;
          const retained = Math.min(reserveRemaining, item.count);
          reserveRemaining -= retained;
          const depositCount = item.count - retained;
          if (depositCount <= 0) continue;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await container.deposit((item as any).type, null, depositCount);
            deposited += depositCount;
          } catch (err) {
            ctx.log.debug({ err: (err as Error).message, item: item.name }, "deposit failed (chest full?)");
            // Chest probably full — stop trying.
            break;
          }
        }
      } finally {
        try {
          await container.close();
        } catch {
          // ignore
        }
      }
      return {
        ok: true,
        summary: deposited > 0
          ? `deposited ${deposited} items into '${chestName}'`
          : `nothing to deposit into '${chestName}'`,
        data: { deposited, chestName },
      };
    },
  });
}
