import type { EquipmentDestination } from "mineflayer";
import { z } from "zod";
import { defineSkill } from "../types.js";

const destinations = [
  "hand",
  "off-hand",
  "head",
  "torso",
  "legs",
  "feet",
] as const satisfies readonly EquipmentDestination[];

export const equipItem = defineSkill({
  name: "equipItem",
  policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
  description:
    "Equip a specific carried item by exact Minecraft name into the hand, offhand, or an " +
    "equipment slot. Use for shields, maps, food, tools, armor, and other explicit inventory control.",
  params: z.object({
    item: z.string().min(1).max(64).describe(
      "Exact Minecraft item name, such as shield, torch, diamond_pickaxe, or iron_helmet.",
    ),
    destination: z.enum(destinations).default("hand"),
  }),
  async run({ item, destination }, ctx) {
    const normalized = item.trim().toLowerCase();
    const carried = ctx.bot.inventory?.items?.() ?? [];
    const selected = carried.find((candidate) =>
      candidate.name.toLowerCase() === normalized);
    if (!selected) {
      const available = carried
        .map((candidate) => candidate.name)
        .filter((name, index, all) => all.indexOf(name) === index)
        .slice(0, 12);
      return {
        ok: false,
        summary: `cannot equip ${normalized}: item is not in carried inventory`,
        code: "NO_MATERIAL",
        recoverable: true,
        details: { item: normalized, destination, available },
      };
    }

    try {
      await ctx.bot.equip(selected, destination);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `failed to equip ${normalized} in ${destination}: ${message}`,
        code: "UNKNOWN",
        recoverable: true,
        details: {
          item: normalized,
          destination,
          slot: selected.slot,
          message,
        },
      };
    }

    const remaining = selected.maxDurability > 0
      ? Math.max(0, selected.maxDurability - selected.durabilityUsed)
      : null;
    return {
      ok: true,
      summary:
        `equipped ${selected.name} in ${destination}` +
        (remaining === null
          ? ""
          : ` (${remaining}/${selected.maxDurability} durability)`),
      data: {
        item: selected.name,
        destination,
        slot: selected.slot,
        durabilityRemaining: remaining,
        durabilityMaximum: selected.maxDurability || null,
      },
    };
  },
});
