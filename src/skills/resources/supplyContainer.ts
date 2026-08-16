import { z } from "zod";
import type { DB } from "../../memory/db.js";
import { getContainerItems } from "../../memory/containers.js";
import { countInInventory } from "../helpers.js";
import { defineSkill, type SkillDefinition, type SkillResult } from "../types.js";
import { ensureTool } from "../items/ensureTool.js";
import { smeltItem } from "../items/smeltItem.js";
import { chestDeposit } from "./chestDeposit.js";
import { mineUntil } from "./mineUntil.js";
import { retrieveItem } from "./retrieveItem.js";
import { scanContainer } from "./scanContainer.js";

interface SmeltingRecipe {
  input: string;
  sourceBlock: string;
  fuel: string;
}

const SMELTING_RECIPES: Record<string, SmeltingRecipe> = {
  iron_ingot: { input: "raw_iron", sourceBlock: "iron_ore", fuel: "coal" },
  gold_ingot: { input: "raw_gold", sourceBlock: "gold_ore", fuel: "coal" },
  copper_ingot: { input: "raw_copper", sourceBlock: "copper_ore", fuel: "coal" },
  glass: { input: "sand", sourceBlock: "sand", fuel: "coal" },
  stone: { input: "cobblestone", sourceBlock: "stone", fuel: "coal" },
};

const params = z.object({
  chestName: z.string().min(1).max(64),
  item: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(4096),
  searchRadius: z.number().int().min(8).max(128).default(64),
});

export function supplyContainer(db: DB): SkillDefinition<z.infer<typeof params>> {
  const scan = scanContainer(db);
  const retrieve = retrieveItem(db);
  const deposit = chestDeposit(db);

  return defineSkill({
    name: "supplyContainer",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
    description:
      "Ensure a remembered container holds at least a target quantity of an item. " +
      "Verifies live stock, deposits carried items, retrieves indexed stock elsewhere, " +
      "and for supported smelted materials gathers inputs and fuel, smelts, deposits, and verifies.",
    params,
    longRunning: true,
    async run({ chestName, item, quantity, searchRadius }, ctx) {
      if (!ctx.bot.registry?.itemsByName?.[item]) {
        return {
          ok: false, summary: `unknown item name: ${item}`,
          code: "INVALID_PARAMS", recoverable: false, details: { item },
        };
      }

      const initialScan = await scan.run({ chestName }, ctx);
      if (!initialScan.ok) return initialScan;
      let stored = storedCount(db, chestName, item);
      if (stored >= quantity) return supplied(chestName, item, stored, quantity, 0);

      // Deposit anything already carried before acquiring more.
      if (countInInventory(ctx.bot, item) > 0) {
        const deposited = await deposit.run({ chestName, itemFilter: item, keepCount: 0 }, ctx);
        if (!deposited.ok) return deposited;
        const rescanned = await scan.run({ chestName }, ctx);
        if (!rescanned.ok) return rescanned;
        stored = storedCount(db, chestName, item);
        if (stored >= quantity) return supplied(chestName, item, stored, quantity, stored);
      }

      // Prefer moving existing finished stock over producing more.
      const deficitBeforeRetrieval = quantity - stored;
      const carriedBeforeRetrieval = countInInventory(ctx.bot, item);
      await retrieve.run({
        item,
        quantity: carriedBeforeRetrieval + deficitBeforeRetrieval,
        excludeChestName: chestName,
      }, ctx);
      if (countInInventory(ctx.bot, item) > 0) {
        const deposited = await deposit.run({ chestName, itemFilter: item, keepCount: 0 }, ctx);
        if (!deposited.ok) return deposited;
        const rescanned = await scan.run({ chestName }, ctx);
        if (!rescanned.ok) return rescanned;
        stored = storedCount(db, chestName, item);
        if (stored >= quantity) {
          return supplied(chestName, item, stored, quantity, stored);
        }
      }

      const recipe = SMELTING_RECIPES[item];
      if (!recipe) {
        return {
          ok: false,
          summary: `'${chestName}' has ${stored}/${quantity} ${item} and no production recipe is configured`,
          code: "NO_MATERIAL",
          recoverable: true,
          details: { chestName, item, stored, target: quantity },
        };
      }

      const needed = quantity - stored;
      const inputTarget = needed;
      await retrieve.run({
        item: recipe.input,
        quantity: inputTarget,
        excludeChestName: chestName,
      }, ctx);
      if (countInInventory(ctx.bot, recipe.input) < inputTarget) {
        const tool = await ensureTool.run(
          { block: recipe.sourceBlock, searchRadius, craftingTableRadius: 16 },
          ctx,
        );
        if (!tool.ok) return prerequisiteFailure("tool", tool, { chestName, item });
        const mined = await mineUntil.run({
          block: recipe.sourceBlock,
          resultItem: recipe.input,
          quantity: inputTarget,
          searchRadius,
        }, ctx);
        if (!mined.ok) return prerequisiteFailure("input", mined, { chestName, item });
      }

      const fuelNeeded = Math.ceil(needed / 8);
      const fuelTarget = fuelNeeded;
      await retrieve.run({
        item: recipe.fuel,
        quantity: fuelTarget,
        excludeChestName: chestName,
      }, ctx);
      if (countInInventory(ctx.bot, recipe.fuel) < fuelTarget) {
        const tool = await ensureTool.run(
          { block: "coal_ore", searchRadius, craftingTableRadius: 16 },
          ctx,
        );
        if (!tool.ok) return prerequisiteFailure("fuel_tool", tool, { chestName, item });
        const minedFuel = await mineUntil.run({
          block: "coal_ore",
          resultItem: "coal",
          quantity: fuelTarget,
          searchRadius,
        }, ctx);
        if (!minedFuel.ok) return prerequisiteFailure("fuel", minedFuel, { chestName, item });
      }

      const outputTarget = needed;
      const smelted = await smeltItem.run({
        input: recipe.input,
        output: item,
        quantity: outputTarget,
        fuel: recipe.fuel,
        furnaceRadius: 16,
      }, ctx);
      if (!smelted.ok) return prerequisiteFailure("smelting", smelted, { chestName, item });

      const deposited = await deposit.run({ chestName, itemFilter: item, keepCount: 0 }, ctx);
      if (!deposited.ok) return deposited;
      const finalScan = await scan.run({ chestName }, ctx);
      if (!finalScan.ok) return finalScan;
      const finalStored = storedCount(db, chestName, item);
      if (finalStored < quantity) {
        return {
          ok: false,
          summary: `supply verification failed: '${chestName}' has ${finalStored}/${quantity} ${item}`,
          code: "NO_MATERIAL",
          recoverable: true,
          details: { chestName, item, stored: finalStored, target: quantity },
        };
      }
      return supplied(chestName, item, finalStored, quantity, finalStored - stored);
    },
  });
}

function storedCount(db: DB, chestName: string, item: string): number {
  return getContainerItems(db, chestName)
    .filter((entry) => entry.item === item)
    .reduce((sum, entry) => sum + entry.count, 0);
}

function supplied(
  chestName: string,
  item: string,
  stored: number,
  target: number,
  added: number,
): SkillResult {
  return {
    ok: true,
    summary: `'${chestName}' supplied with ${stored} ${item} (target ${target})`,
    data: { chestName, item, stored, target, added },
  };
}

function prerequisiteFailure(
  stage: string,
  result: SkillResult,
  context: Record<string, unknown>,
): SkillResult {
  return {
    ...result,
    summary: `supply ${stage} failed: ${result.summary}`,
    details: { ...context, stage, cause: result.details ?? null },
  };
}
