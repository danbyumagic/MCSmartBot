import type { EquipmentDestination } from "mineflayer";
import type { Item } from "prismarine-item";
import { z } from "zod";
import { defineSkill } from "../types.js";

const armorDestinations = ["head", "torso", "legs", "feet"] as const;
type ArmorDestination = Extract<
  EquipmentDestination,
  (typeof armorDestinations)[number]
>;

const slotSuffix: Record<ArmorDestination, string> = {
  head: "_helmet",
  torso: "_chestplate",
  legs: "_leggings",
  feet: "_boots",
};

const materialRank: Record<string, number> = {
  leather: 1,
  golden: 2,
  chainmail: 3,
  iron: 4,
  turtle: 5,
  diamond: 6,
  netherite: 7,
};

const armorPoints: Record<string, Partial<Record<ArmorDestination, number>>> = {
  leather: { head: 1, torso: 3, legs: 2, feet: 1 },
  golden: { head: 2, torso: 5, legs: 3, feet: 1 },
  chainmail: { head: 2, torso: 5, legs: 4, feet: 1 },
  iron: { head: 2, torso: 6, legs: 5, feet: 2 },
  turtle: { head: 2 },
  diamond: { head: 3, torso: 8, legs: 6, feet: 3 },
  netherite: { head: 3, torso: 8, legs: 6, feet: 3 },
};

const armorToughness: Record<string, number> = {
  diamond: 2,
  netherite: 3,
};

export const equipArmor = defineSkill({
  name: "equipArmor",
  policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
  description:
    "Equip the strongest armor currently carried by the bot. By default checks all four " +
    "armor slots; use a specific slot when requested. Never replaces stronger worn armor.",
  params: z.object({
    slot: z
      .enum(["all", ...armorDestinations])
      .default("all")
      .describe("Armor slot to equip, or 'all' to equip the best available full set."),
  }),
  async run({ slot }, ctx) {
    const requested = slot === "all"
      ? [...armorDestinations]
      : [slot as ArmorDestination];
    const carried = ctx.bot.inventory.items();
    const equipped: string[] = [];
    const retained: string[] = [];
    const missing: ArmorDestination[] = [];

    for (const destination of requested) {
      const destinationSlot = ctx.bot.getEquipmentDestSlot(destination);
      const current = ctx.bot.inventory.slots[destinationSlot] ?? null;
      const candidates = carried.filter((item) =>
        armorDestination(item.name) === destination);
      const best = [current, ...candidates]
        .filter((item): item is Item => item !== null)
        .filter((item) => armorDestination(item.name) === destination)
        .sort((a, b) => armorScore(b, destination) - armorScore(a, destination))[0];

      if (!best) {
        missing.push(destination);
        continue;
      }
      if (best === current) {
        retained.push(`${destination}:${best.name}`);
        continue;
      }

      try {
        await ctx.bot.equip(best, destination);
        equipped.push(`${destination}:${best.name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          summary: `failed to equip ${best.name} as ${destination}: ${message}`,
          code: "UNKNOWN",
          recoverable: true,
          details: { destination, item: best.name, message, equipped },
        };
      }
    }

    if (equipped.length === 0 && retained.length === 0) {
      return {
        ok: false,
        summary: `no equippable armor found for ${requested.join(", ")}`,
        code: "NO_MATERIAL",
        recoverable: true,
        details: { missing },
      };
    }

    const parts = [];
    if (equipped.length > 0) parts.push(`equipped ${equipped.join(", ")}`);
    if (retained.length > 0) parts.push(`kept ${retained.join(", ")}`);
    if (missing.length > 0) parts.push(`no armor for ${missing.join(", ")}`);
    return {
      ok: true,
      summary: parts.join("; "),
      data: { equipped, retained, missing },
    };
  },
});

function armorDestination(name: string): ArmorDestination | undefined {
  if (name === "turtle_helmet") return "head";
  return armorDestinations.find((destination) =>
    name.endsWith(slotSuffix[destination]));
}

function armorScore(item: Item, destination: ArmorDestination): number {
  const material = item.name === "turtle_helmet"
    ? "turtle"
    : item.name.slice(0, item.name.indexOf("_"));
  const protection = armorPoints[material]?.[destination] ?? 0;
  const toughness = armorToughness[material] ?? 0;
  return protection * 100 + toughness * 10 + (materialRank[material] ?? 0);
}
