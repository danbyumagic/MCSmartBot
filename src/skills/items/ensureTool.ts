import { z } from "zod";
import { defineSkill } from "../types.js";
import { craftItem } from "./craftItem.js";
import { equipBestTool } from "./equipBestTool.js";

const TIERS = ["diamond", "iron", "stone", "wooden"] as const;

function toolKindFor(block: string): "axe" | "shovel" | "hoe" | "pickaxe" {
  if (/(log|wood|stem|hyphae|planks|bookshelf|pumpkin|melon)/.test(block)) return "axe";
  if (/(dirt|grass_block|sand|gravel|clay|snow|soul_sand|soul_soil)/.test(block)) return "shovel";
  if (/(leaves|hay_block|sponge|sculk|wart_block)/.test(block)) return "hoe";
  return "pickaxe";
}

export const ensureTool = defineSkill({
  name: "ensureTool",
  policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
  description:
    "Ensure an appropriate tool is equipped for a visible block. Uses the best carried tool first; " +
    "if none is suitable, crafts the best tool currently possible and equips it.",
  params: z.object({
    block: z.string().min(1).max(64),
    searchRadius: z.number().int().min(2).max(64).default(16),
    craftingTableRadius: z.number().int().min(2).max(64).default(16),
  }),
  async run({ block, searchRadius, craftingTableRadius }, ctx) {
    const equipped = await equipBestTool.run({ block, searchRadius }, ctx);
    if (equipped.ok) return equipped;
    if (equipped.code !== "NO_TOOL") return equipped;

    const kind = toolKindFor(block);
    const attempts: Array<{ item: string; code?: string }> = [];
    for (const tier of TIERS) {
      if (ctx.signal.aborted) {
        return { ok: false, summary: "ensureTool cancelled", code: "INTERRUPTED", recoverable: true };
      }
      const item = `${tier}_${kind}`;
      if (!ctx.bot.registry?.itemsByName?.[item]) continue;
      const crafted = await craftItem.run(
        { item, quantity: 1, craftingTableRadius },
        ctx,
      );
      attempts.push({ item, code: crafted.code });
      if (!crafted.ok) continue;

      const result = await equipBestTool.run({ block, searchRadius }, ctx);
      if (result.ok) {
        return {
          ok: true,
          summary: `crafted and equipped ${item} for ${block}`,
          data: { block, tool: item, crafted: true },
        };
      }
    }

    return {
      ok: false,
      summary: `no suitable ${kind} available and could not craft one`,
      code: "NO_MATERIAL",
      recoverable: true,
      details: { block, toolKind: kind, attempts },
    };
  },
});
