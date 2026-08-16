import { z } from "zod";
import { defineSkill, type SkillContext } from "../types.js";

function normalizeItemName(item: string): string {
  return item.trim().toLowerCase();
}

function inventoryItems(bot: SkillContext["bot"]) {
  return bot.inventory?.items?.() ?? [];
}

function carriedItemCount(
  bot: SkillContext["bot"],
  item: string,
): number {
  return inventoryItems(bot)
    .filter((candidate) => normalizeItemName(candidate.name) === item)
    .reduce((total, candidate) => total + Math.max(0, candidate.count), 0);
}

/**
 * `undefined` means the active registry does not expose food metadata, so the
 * action must rely on Mineflayer plus its post-action verification instead.
 */
function registryFoodStatus(
  bot: SkillContext["bot"],
  item: string,
): boolean | undefined {
  const registry = bot.registry;
  const hasFoodMetadata = registry?.foodsByName !== undefined || registry?.foods !== undefined;
  if (!hasFoodMetadata) return undefined;
  const itemData = registry?.itemsByName?.[item];
  return Boolean(
    registry?.foodsByName?.[item] ??
    (typeof itemData?.id === "number" ? registry.foods?.[itemData.id] : undefined),
  );
}

function finiteFood(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const consumeItem = defineSkill({
  name: "consumeItem",
  policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
  description:
    "Consume one exact carried food item. When registry food metadata is available, rejects non-food items; " +
    "equips the selected item and verifies an item or food-state change before reporting success.",
  params: z.object({
    item: z.string().min(1).max(64).describe("Exact Minecraft consumable item name, such as apple or bread."),
  }),
  async run({ item }, ctx) {
    const normalized = normalizeItemName(item);
    if (!normalized) {
      return {
        ok: false,
        summary: "item name cannot be blank",
        code: "INVALID_PARAMS",
        recoverable: false,
      };
    }

    const carried = inventoryItems(ctx.bot);
    const selected = carried.find((candidate) => normalizeItemName(candidate.name) === normalized);
    const before = carriedItemCount(ctx.bot, normalized);
    if (!selected || before < 1) {
      return {
        ok: false,
        summary: `cannot consume ${normalized}: item is not in carried inventory`,
        code: "NO_MATERIAL",
        recoverable: true,
        details: { item: normalized, available: before },
      };
    }

    const foodStatus = registryFoodStatus(ctx.bot, normalized);
    if (foodStatus === false) {
      return {
        ok: false,
        summary: `${normalized} is not a consumable item in the active Minecraft registry`,
        code: "INVALID_PARAMS",
        recoverable: false,
        details: { item: normalized },
      };
    }
    if (ctx.signal.aborted) return cancelled(normalized);

    const foodBefore = finiteFood(ctx.bot.food);
    try {
      await ctx.bot.equip(selected, "hand");
      if (ctx.signal.aborted) return cancelled(normalized);
      await ctx.bot.consume();
    } catch (error) {
      if (ctx.signal.aborted) return cancelled(normalized);
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: `failed to consume ${normalized}: ${message}`,
        code: "SERVER_REJECTED",
        recoverable: true,
        details: { item: normalized, message },
      };
    }

    const after = carriedItemCount(ctx.bot, normalized);
    const consumed = before - after;
    const foodAfter = finiteFood(ctx.bot.food);
    const foodChanged = foodBefore !== undefined && foodAfter !== undefined && foodAfter !== foodBefore;
    const itemDeltaVerified = consumed === 1;
    if (!itemDeltaVerified && !foodChanged) {
      const details: Record<string, unknown> = { item: normalized, before, after, consumed };
      if (foodBefore !== undefined) details.foodBefore = foodBefore;
      if (foodAfter !== undefined) details.foodAfter = foodAfter;
      return {
        ok: false,
        summary: `consumption of ${normalized} could not be verified from inventory or food state`,
        code: "STALE_STATE",
        recoverable: false,
        details,
      };
    }

    const data: Record<string, unknown> = { item: normalized, consumed, before, after };
    if (foodBefore !== undefined) data.foodBefore = foodBefore;
    if (foodAfter !== undefined) data.foodAfter = foodAfter;
    return {
      ok: true,
      summary: `consumed ${normalized}`,
      data,
    };
  },
});

function cancelled(item: string) {
  return {
    ok: false,
    summary: `consumeItem cancelled before consuming ${item}`,
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: { item },
  };
}
