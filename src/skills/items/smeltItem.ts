import { z } from "zod";
import type { Furnace } from "mineflayer";
import { defineSkill } from "../types.js";
import { countInInventory, findNearestBlockByName } from "../helpers.js";
import {
  goals,
  pathfindTo,
  pathfindingFailureDetails,
} from "../pathfinder.js";

const FUEL_OPERATIONS: Record<string, number> = {
  coal: 8,
  charcoal: 8,
  coal_block: 80,
  blaze_rod: 12,
  lava_bucket: 100,
  oak_planks: 1.5,
  spruce_planks: 1.5,
  birch_planks: 1.5,
  jungle_planks: 1.5,
  acacia_planks: 1.5,
  dark_oak_planks: 1.5,
  mangrove_planks: 1.5,
  cherry_planks: 1.5,
};

function waitForUpdate(furnace: Furnace, signal: AbortSignal, timeoutMs: number): Promise<"update" | "timeout" | "aborted"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: "update" | "timeout" | "aborted") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      furnace.removeListener("update", onUpdate);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onUpdate = () => finish("update");
    const onAbort = () => finish("aborted");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    furnace.once("update", onUpdate);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export const smeltItem = defineSkill({
  name: "smeltItem",
  policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
  description:
    "Smelt an input item in a nearby furnace until the requested output inventory total is reached. " +
    "Requires the input and fuel to already be in inventory.",
  longRunning: true,
  params: z.object({
    input: z.string().min(1).max(64).describe("Input item, e.g. 'raw_iron'"),
    output: z.string().min(1).max(64).describe("Expected output item, e.g. 'iron_ingot'"),
    quantity: z.number().int().min(1).max(256).describe("Target total output count in inventory"),
    fuel: z.string().min(1).max(64).default("coal"),
    furnaceRadius: z.number().int().min(2).max(64).default(16),
  }),
  async run({ input, output, quantity, fuel, furnaceRadius }, ctx) {
    const inputData = ctx.bot.registry?.itemsByName?.[input];
    const outputData = ctx.bot.registry?.itemsByName?.[output];
    const fuelData = ctx.bot.registry?.itemsByName?.[fuel];
    if (!inputData || !outputData || !fuelData || !FUEL_OPERATIONS[fuel]) {
      return {
        ok: false,
        summary: `unknown input output or supported fuel (${input} -> ${output} using ${fuel})`,
        code: "INVALID_PARAMS",
        recoverable: false,
        details: { input, output, fuel },
      };
    }

    const initial = countInInventory(ctx.bot, output);
    if (initial >= quantity) {
      return { ok: true, summary: `already have ${initial} ${output} (target was ${quantity})` };
    }
    const needed = quantity - initial;
    const availableInput = countInInventory(ctx.bot, input);
    if (availableInput < needed) {
      return {
        ok: false,
        summary: `need ${needed} ${input} but only have ${availableInput}`,
        code: "NO_MATERIAL",
        recoverable: true,
        details: { input, required: needed, available: availableInput },
      };
    }
    const fuelNeeded = Math.ceil(needed / FUEL_OPERATIONS[fuel]);
    const availableFuel = countInInventory(ctx.bot, fuel);
    if (availableFuel < fuelNeeded) {
      return {
        ok: false,
        summary: `need ${fuelNeeded} ${fuel} but only have ${availableFuel}`,
        code: "NO_FUEL",
        recoverable: true,
        details: { fuel, required: fuelNeeded, available: availableFuel },
      };
    }

    const found = findNearestBlockByName(ctx.bot, "furnace", furnaceRadius);
    if (!found) {
      return {
        ok: false, summary: `no furnace within ${furnaceRadius} blocks`,
        code: "NOT_CONFIGURED", recoverable: true, details: { furnaceRadius },
      };
    }
    const block = ctx.bot.blockAt(found.position);
    if (!block) {
      return { ok: false, summary: "furnace block is not loaded", code: "WORLD_UNAVAILABLE", recoverable: true };
    }
    try {
      await pathfindTo(
        ctx.bot,
        new goals.GoalNear(found.position.x, found.position.y, found.position.z, 2),
        ctx.signal,
      );
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return {
        ok: false, summary: message === "aborted" ? "smeltItem cancelled" : `could not reach furnace: ${message}`,
        code: message === "aborted" ? "INTERRUPTED" : "NO_PATH",
        recoverable: true, details: { message, ...pathfindingFailureDetails(err) },
      };
    }

    let furnace: Furnace;
    try {
      furnace = await ctx.bot.openFurnace(block);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return {
        ok: false, summary: `failed to open furnace: ${message}`,
        code: "TARGET_UNAVAILABLE", recoverable: true, details: { message },
      };
    }

    try {
      await furnace.putInput(inputData.id, null, needed);
      await furnace.putFuel(fuelData.id, null, fuelNeeded);

      let collected = 0;
      const deadline = Date.now() + Math.min(300_000, needed * 12_000 + 5_000);
      while (collected < needed) {
        if (ctx.signal.aborted) {
          return {
            ok: false, summary: `smeltItem cancelled after ${collected}/${needed}`,
            code: "INTERRUPTED", recoverable: true, details: { input, output, collected, needed },
          };
        }
        const ready = furnace.outputItem();
        if (ready?.type === outputData.id && ready.count > 0) {
          const taken = await furnace.takeOutput();
          collected += taken.count;
          ctx.reportProgress(`${collected}/${needed} ${output}`);
          continue;
        }
        if (Date.now() >= deadline) {
          return {
            ok: false, summary: `smelting timed out after ${collected}/${needed} ${output}`,
            code: "TIMED_OUT", recoverable: true, details: { input, output, collected, needed },
          };
        }
        const event = await waitForUpdate(furnace, ctx.signal, 1_000);
        if (event === "aborted") continue;
      }

      return {
        ok: true,
        summary: `smelted ${collected} ${output}`,
        data: { input, output, smelted: collected, target: quantity },
      };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return {
        ok: false, summary: `smeltItem failed: ${message}`,
        code: ctx.signal.aborted ? "INTERRUPTED" : "UNKNOWN",
        recoverable: true, details: { input, output, message },
      };
    } finally {
      try {
        furnace.close();
      } catch {
        // ignore close errors
      }
    }
  },
});
