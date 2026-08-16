import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { Reflex } from "../types.js";

const FOOD_NAME_TOKENS = [
  "bread", "apple", "carrot", "potato", "beetroot", "melon",
  "cookie", "cake", "stew", "soup", "porkchop", "beef", "chicken",
  "mutton", "rabbit", "salmon", "cod", "kelp", "berries", "berry",
  "mushroom_stew", "pumpkin_pie", "honey_bottle", "chorus_fruit",
  "tropical_fish", "spider_eye", // (spider_eye is poisonous; emergency only)
];

export function isEdible(item: Item | null): boolean {
  if (!item) return false;
  const name = (item.name ?? "").toLowerCase();
  return FOOD_NAME_TOKENS.some((t) => name.includes(t));
}

export function findEdible(bot: Bot): Item | null {
  for (const slot of bot.inventory.items()) {
    if (isEdible(slot)) return slot;
  }
  return null;
}

export interface AutoEatDeps {
  foodThreshold: number;
}

export function autoEat(deps: AutoEatDeps): Reflex {
  return {
    name: "autoEat",
    priority: 10,
    check: (bot) => {
      if (typeof bot.food !== "number") return false;
      if (bot.food >= deps.foodThreshold) return false;
      return findEdible(bot) !== null;
    },
    async run(bot, signal) {
      const food = findEdible(bot);
      if (!food) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prevHeld = (bot.inventory as any).selectedItem ?? null;
      try {
        await bot.equip(food, "hand");
        if (signal.aborted) return;
        await bot.consume();
      } catch {
        // ignore equip/consume failures; reflex will retry next tick
      } finally {
        try {
          if (prevHeld && prevHeld !== food) {
            await bot.equip(prevHeld, "hand");
          }
        } catch {
          // not critical
        }
      }
    },
  };
}
