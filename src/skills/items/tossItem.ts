import { z } from "zod";
import { defineSkill, type SkillContext } from "../types.js";

function normalizeItemName(item: string): string {
  return item.trim().toLowerCase();
}

function carriedItemCount(
  bot: SkillContext["bot"],
  item: string,
): number {
  return inventoryItems(bot)
    .filter((candidate) => normalizeItemName(candidate.name) === item)
    .reduce((total, candidate) => total + Math.max(0, candidate.count), 0);
}

function inventoryItems(bot: SkillContext["bot"]) {
  return bot.inventory?.items?.() ?? [];
}

export const tossItem = defineSkill({
  name: "tossItem",
  policy: { minimumRole: "owner", effect: "destructive", reversible: false, mission: "public" },
  description:
    "Discard an exact count of one carried Minecraft item. This is destructive and cannot be undone; " +
    "it succeeds only after the named inventory count decreases by exactly the requested amount.",
  params: z.object({
    item: z.string().min(1).max(64).describe("Exact Minecraft item name, such as cobblestone or iron_ingot."),
    count: z.number().int().min(1).max(256).describe("Exact number of the named item to discard."),
  }),
  async run({ item, count }, ctx) {
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
    if (!selected || before < count) {
      return {
        ok: false,
        summary: `cannot toss ${count} ${normalized}: only ${before} are carried`,
        code: "NO_MATERIAL",
        recoverable: true,
        details: { item: normalized, available: before, requested: count },
      };
    }
    if (ctx.signal.aborted) {
      return cancelled(normalized, count);
    }

    try {
      await ctx.bot.toss(selected.type, null, count);
    } catch (error) {
      if (ctx.signal.aborted) return cancelled(normalized, count);
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: `failed to toss ${count} ${normalized}: ${message}`,
        code: "SERVER_REJECTED",
        recoverable: true,
        details: { item: normalized, requested: count, message },
      };
    }

    const after = carriedItemCount(ctx.bot, normalized);
    const tossed = before - after;
    if (tossed !== count) {
      return {
        ok: false,
        summary:
          `toss of ${normalized} could not be verified: expected ${count} removed, ` +
          `but inventory changed by ${tossed}`,
        code: "STALE_STATE",
        recoverable: false,
        details: { item: normalized, requested: count, before, after, tossed },
      };
    }

    return {
      ok: true,
      summary: `tossed ${tossed} ${normalized}`,
      data: { item: normalized, tossed, before, after },
    };
  },
});

function cancelled(item: string, count: number) {
  return {
    ok: false,
    summary: `tossItem cancelled before tossing ${count} ${item}`,
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: { item, requested: count },
  };
}
