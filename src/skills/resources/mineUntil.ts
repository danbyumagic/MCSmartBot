import { z } from "zod";
import { defineSkill } from "../types.js";
import { countInInventory, findNearestBlockByName } from "../helpers.js";
import {
  collectBlockFailureDetails,
  collectBlockWithRecovery,
} from "../collectblock.js";
import {
  createInventorySnapshot,
  estimateInventorySpace,
} from "../../inventory/snapshot.js";

/**
 * Mine until inventory count reaches target. Uses bot.collectBlock when
 * available (mineflayer-collectblock plugin), which handles pathfinding,
 * tool selection, digging, and pickup automatically.
 *
 * longRunning: true — large quantities may take minutes. The trigger queue
 * stays unblocked so the owner can interrupt via `stop`.
 */
export const mineUntil = defineSkill({
  name: "mineUntil",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  description:
    "Mine a specific block type until reaching a target quantity in inventory. " +
    "Pathfinds to the nearest match, equips the best tool, digs, picks up the drop, repeats. " +
    "Use when the owner says 'mine X', 'get me Y iron', 'chop some cobblestone'. " +
    "Stops cleanly when interrupted via `stop`.",
  params: z.object({
    block: z.string().min(1).max(64).describe("Block name to mine, e.g. 'iron_ore', 'cobblestone'"),
    resultItem: z.string().min(1).max(64).optional().describe(
      "Inventory item produced by the block when it differs from the block name, e.g. raw_iron for iron_ore",
    ),
    quantity: z.number().int().min(1).max(256).describe("Target inventory count (capped at 256)"),
    searchRadius: z.number().int().min(8).max(128).default(64).describe("Block search radius per cycle"),
  }),
  longRunning: true,
  async run({ block, resultItem, quantity, searchRadius }, ctx) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot = ctx.bot as any;
    if (!bot.registry?.blocksByName?.[block]) {
      return {
        ok: false, summary: `unknown block name: ${block}`,
        code: "INVALID_PARAMS", recoverable: false, details: { block },
      };
    }

    const countedItem = resultItem ?? block;
    if (bot.registry?.itemsByName && !bot.registry.itemsByName[countedItem]) {
      return {
        ok: false, summary: `unknown result item name: ${countedItem}`,
        code: "INVALID_PARAMS", recoverable: false, details: { block, resultItem: countedItem },
      };
    }
    const initial = countInInventory(ctx.bot, countedItem);
    if (initial >= quantity) {
      return { ok: true, summary: `already have ${initial} ${countedItem} (target was ${quantity})` };
    }
    const requiredSpace = quantity - initial;
    const availableSpace = estimateInventorySpace(ctx.bot, countedItem);
    if (availableSpace < requiredSpace) {
      const snapshot = createInventorySnapshot(ctx.bot);
      return {
        ok: false,
        summary:
          `cannot collect ${requiredSpace} more ${countedItem}: inventory only has room for ` +
          `${availableSpace} (${snapshot.freeSlots} free slots)`,
        code: "INVENTORY_FULL",
        recoverable: true,
        details: {
          item: countedItem,
          have: initial,
          target: quantity,
          requiredSpace,
          availableSpace,
          freeSlots: snapshot.freeSlots,
          guidance: "deposit carried items or lower the target quantity",
        },
      };
    }

    let mined = initial;
    let navigationRecoveries = 0;
    while (mined < quantity) {
      if (ctx.signal.aborted) {
        return {
          ok: false, summary: `mineUntil cancelled at ${mined}/${quantity} ${countedItem}`,
          code: "INTERRUPTED", recoverable: true,
          details: { block, resultItem: countedItem, mined, target: quantity },
        };
      }
      const target = findNearestBlockByName(ctx.bot, block, searchRadius);
      if (!target) {
        if (mined > initial) {
          return {
            ok: true,
            summary: `collected ${mined - initial} ${countedItem} from ${block} (no more within ${searchRadius})`,
          };
        }
        return {
          ok: false, summary: `no ${block} within ${searchRadius} blocks`,
          code: "NO_BLOCK_FOUND", recoverable: true, details: { block, searchRadius },
        };
      }
      const blockObj = bot.blockAt(target.position);
      if (!blockObj) {
        return {
          ok: false, summary: `could not load block at ${target.position}`,
          code: "WORLD_UNAVAILABLE", recoverable: true, details: { block, position: String(target.position) },
        };
      }
      try {
        if (typeof bot.collectBlock?.collect === "function") {
          const telemetry = await collectBlockWithRecovery(
            ctx.bot,
            blockObj,
            ctx.signal,
          );
          if (telemetry.attempts > 1) navigationRecoveries++;
        } else {
          return {
            ok: false, summary: "mineflayer-collectblock plugin not loaded",
            code: "PLUGIN_UNAVAILABLE", recoverable: false,
          };
        }
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg === "aborted" || ctx.signal.aborted) {
          return {
            ok: false, summary: `mineUntil cancelled at ${mined}/${quantity} ${countedItem}`,
            code: "INTERRUPTED", recoverable: true,
            details: { block, resultItem: countedItem, mined, target: quantity },
          };
        }
        return {
          ok: false, summary: `mineUntil failed at ${mined}/${quantity}: ${msg}`,
          code: "NO_PATH", recoverable: true,
          details: {
            block,
            resultItem: countedItem,
            mined,
            target: quantity,
            message: msg,
            navigationRecoveries,
            ...collectBlockFailureDetails(err),
          },
        };
      }
      mined = countInInventory(ctx.bot, countedItem);
      ctx.reportProgress(`${mined}/${quantity} ${countedItem}`);
    }
    return {
      ok: true,
      summary: `collected ${mined - initial} ${countedItem} from ${block} (now have ${mined})`,
      data: {
        mined,
        target: quantity,
        block,
        resultItem: countedItem,
        navigationRecoveries,
      },
    };
  },
});
