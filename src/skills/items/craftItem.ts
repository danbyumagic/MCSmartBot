import { z } from "zod";
import type { Block } from "prismarine-block";
import type { Recipe } from "prismarine-recipe";
import { defineSkill } from "../types.js";
import { countInInventory, findNearestBlockByName } from "../helpers.js";
import {
  goals,
  pathfindTo,
  pathfindingFailureDetails,
} from "../pathfinder.js";
import {
  createInventorySnapshot,
  estimateInventorySpace,
} from "../../inventory/snapshot.js";

export const craftItem = defineSkill({
  name: "craftItem",
  policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
  description:
    "Craft an item until the requested total quantity is present in inventory. " +
    "Uses an inventory recipe when possible, otherwise a nearby crafting table. " +
    "This skill does not collect missing ingredients.",
  params: z.object({
    item: z.string().min(1).max(64).describe("Vanilla item name such as 'iron_pickaxe' or 'torch'"),
    quantity: z.number().int().min(1).max(256).describe("Target total inventory count"),
    craftingTableRadius: z.number().int().min(2).max(64).default(16),
  }),
  async run({ item, quantity, craftingTableRadius }, ctx) {
    const itemData = ctx.bot.registry?.itemsByName?.[item];
    if (!itemData) {
      return {
        ok: false,
        summary: `unknown item name: ${item}`,
        code: "INVALID_PARAMS",
        recoverable: false,
        details: { item },
      };
    }

    const initial = countInInventory(ctx.bot, item);
    if (initial >= quantity) {
      return { ok: true, summary: `already have ${initial} ${item} (target was ${quantity})` };
    }

    if (ctx.signal.aborted) {
      return { ok: false, summary: `craftItem ${item} cancelled`, code: "INTERRUPTED", recoverable: true };
    }

    const deficit = quantity - initial;
    const availableSpace = estimateInventorySpace(ctx.bot, item);
    if (availableSpace < deficit) {
      const snapshot = createInventorySnapshot(ctx.bot);
      return {
        ok: false,
        summary:
          `cannot craft ${deficit} ${item}: inventory only has room for ${availableSpace} ` +
          `(${snapshot.freeSlots} free slots)`,
        code: "INVENTORY_FULL",
        recoverable: true,
        details: {
          item,
          have: initial,
          target: quantity,
          requiredSpace: deficit,
          availableSpace,
          freeSlots: snapshot.freeSlots,
          guidance: "deposit carried items or lower the target quantity",
        },
      };
    }
    let table: Block | undefined;
    let recipes = ctx.bot.recipesFor(itemData.id, null, deficit, false);

    if (recipes.length === 0) {
      const found = findNearestBlockByName(ctx.bot, "crafting_table", craftingTableRadius);
      if (found) {
        const block = ctx.bot.blockAt(found.position);
        if (block) {
          try {
            await pathfindTo(
              ctx.bot,
              new goals.GoalNear(found.position.x, found.position.y, found.position.z, 2),
              ctx.signal,
            );
          } catch (err) {
            const message = (err as Error).message ?? String(err);
            if (message === "aborted") {
              return { ok: false, summary: `craftItem ${item} cancelled`, code: "INTERRUPTED", recoverable: true };
            }
            return {
              ok: false,
              summary: `could not reach crafting table: ${message}`,
              code: "NO_PATH",
              recoverable: true,
              details: { item, message, ...pathfindingFailureDetails(err) },
            };
          }
          table = block;
          recipes = ctx.bot.recipesFor(itemData.id, null, deficit, table);
        }
      }
    }

    const recipe = recipes[0];
    if (!recipe) {
      const recipePreflight = describeRecipeShortage(
        ctx.bot,
        itemData.id,
        deficit,
        table,
      );
      return {
        ok: false,
        summary:
          `cannot craft ${deficit} ${item} with current ingredients` +
          (recipePreflight.missing.length > 0
            ? `; missing ${recipePreflight.missing
              .map((entry) => `${entry.missing} ${entry.item}`)
              .join(", ")}`
            : recipePreflight.requiresTable && !table
              ? "; a crafting table is required"
              : ""),
        code: "NO_MATERIAL",
        recoverable: true,
        details: {
          item,
          have: initial,
          target: quantity,
          craftingTableFound: Boolean(table),
          recipeRequiresTable: recipePreflight.requiresTable,
          missingMaterials: recipePreflight.missing,
          guidance: recipePreflight.requiresTable && !table
            ? "move within range of a crafting table and gather the missing ingredients"
            : "retrieve or gather the missing ingredients",
        },
      };
    }

    const perCraft = Math.max(1, recipe.result.count);
    const craftCount = Math.ceil(deficit / perCraft);
    try {
      await ctx.bot.craft(recipe, craftCount, table);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (ctx.signal.aborted || message === "aborted") {
        return { ok: false, summary: `craftItem ${item} cancelled`, code: "INTERRUPTED", recoverable: true };
      }
      return {
        ok: false,
        summary: `failed to craft ${item}: ${message}`,
        code: "NO_MATERIAL",
        recoverable: true,
        details: { item, craftCount, message },
      };
    }

    const total = await waitForInventoryTarget(
      ctx.bot,
      item,
      quantity,
      ctx.signal,
    );
    if (total < quantity) {
      return {
        ok: false,
        summary:
          `crafting produced ${Math.max(0, total - initial)} ${item} but ` +
          `${quantity - total} are still missing`,
        code: "NO_MATERIAL",
        recoverable: true,
        details: {
          item,
          have: total,
          target: quantity,
          crafted: Math.max(0, total - initial),
          missing: quantity - total,
          guidance: "retry crafting; the server may have completed only part of the batch",
        },
      };
    }
    return {
      ok: true,
      summary: `crafted ${Math.max(0, total - initial)} ${item} (now have ${total})`,
      data: { item, crafted: Math.max(0, total - initial), total, target: quantity },
    };
  },
});

async function waitForInventoryTarget(
  bot: Parameters<typeof countInInventory>[0],
  item: string,
  target: number,
  signal: AbortSignal,
  timeoutMs = 2_500,
): Promise<number> {
  let current = countInInventory(bot, item);
  if (current >= target) return current;
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    current = countInInventory(bot, item);
    if (current >= target) return current;
  }
  return current;
}

function describeRecipeShortage(
  bot: Parameters<typeof countInInventory>[0],
  itemType: number,
  resultCount: number,
  table: Block | undefined,
): {
  requiresTable: boolean;
  missing: Array<{ item: string; required: number; have: number; missing: number }>;
} {
  if (typeof bot.recipesAll !== "function") {
    return { requiresTable: false, missing: [] };
  }
  // A truthy stand-in is sufficient here: Mineflayer only uses this argument
  // to include table recipes. No crafting action is performed by this preflight.
  const allRecipes = bot.recipesAll(
    itemType,
    null,
    table ?? (true as unknown as Block),
  );
  const candidates = allRecipes.map((recipe) => ({
    recipe,
    missing: missingForRecipe(bot, recipe, resultCount),
  }));
  candidates.sort((a, b) =>
    totalMissing(a.missing) - totalMissing(b.missing) ||
    Number(a.recipe.requiresTable) - Number(b.recipe.requiresTable));
  const best = candidates[0];
  return best
    ? { requiresTable: best.recipe.requiresTable, missing: best.missing }
    : { requiresTable: false, missing: [] };
}

function missingForRecipe(
  bot: Parameters<typeof countInInventory>[0],
  recipe: Recipe,
  resultCount: number,
): Array<{ item: string; required: number; have: number; missing: number }> {
  const craftCount = Math.ceil(resultCount / Math.max(1, recipe.result.count));
  const requirements = new Map<number, number>();
  for (const delta of recipe.delta) {
    if (delta.id < 0 || delta.count >= 0) continue;
    requirements.set(
      delta.id,
      (requirements.get(delta.id) ?? 0) + (-delta.count * craftCount),
    );
  }
  return [...requirements]
    .map(([id, required]) => {
      const itemName = bot.registry?.items?.[id]?.name ??
        bot.inventory.items().find((item) => item.type === id)?.name ??
        `item_${id}`;
      const have = bot.inventory.items()
        .filter((item) => item.type === id || item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
      return {
        item: itemName,
        required,
        have,
        missing: Math.max(0, required - have),
      };
    })
    .filter((entry) => entry.missing > 0);
}

function totalMissing(
  entries: Array<{ missing: number }>,
): number {
  return entries.reduce((sum, entry) => sum + entry.missing, 0);
}
