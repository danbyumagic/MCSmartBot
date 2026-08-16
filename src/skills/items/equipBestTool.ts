import { z } from "zod";
import { defineSkill } from "../types.js";
import { findNearestBlockByName } from "../helpers.js";
import { ensurePathfinder } from "../pathfinder.js";

export const equipBestTool = defineSkill({
  name: "equipBestTool",
  policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
  description:
    "Equip the best carried tool for mining a visible block type. " +
    "Use before mining when tool suitability or speed matters.",
  params: z.object({
    block: z.string().min(1).max(64).describe("Vanilla block name such as 'stone' or 'iron_ore'"),
    searchRadius: z.number().int().min(2).max(64).default(16),
  }),
  async run({ block, searchRadius }, ctx) {
    if (!ctx.bot.registry?.blocksByName?.[block]) {
      return {
        ok: false, summary: `unknown block name: ${block}`,
        code: "INVALID_PARAMS", recoverable: false, details: { block },
      };
    }
    const found = findNearestBlockByName(ctx.bot, block, searchRadius);
    if (!found) {
      return {
        ok: false, summary: `no ${block} within ${searchRadius} blocks`,
        code: "NO_BLOCK_FOUND", recoverable: true, details: { block, searchRadius },
      };
    }
    const target = ctx.bot.blockAt(found.position);
    if (!target) {
      return {
        ok: false, summary: `could not inspect ${block} at ${found.position}`,
        code: "WORLD_UNAVAILABLE", recoverable: true,
      };
    }

    ensurePathfinder(ctx.bot);
    const tool = ctx.bot.pathfinder.bestHarvestTool(target);
    if (!tool) {
      return {
        ok: false,
        summary: `no suitable tool for ${block} in inventory`,
        code: "NO_TOOL",
        recoverable: true,
        details: { block },
      };
    }
    try {
      await ctx.bot.equip(tool, "hand");
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return {
        ok: false, summary: `failed to equip ${tool.name}: ${message}`,
        code: "UNKNOWN", recoverable: true, details: { block, tool: tool.name, message },
      };
    }
    return {
      ok: true,
      summary: `equipped ${tool.name} for ${block}`,
      data: { block, tool: tool.name },
    };
  },
});
