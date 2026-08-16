import { z } from "zod";
import { defineSkill } from "../types.js";
import { findNearestBlockByName, findConnectedLogs } from "../helpers.js";
import {
  collectBlockFailureDetails,
  collectBlockWithRecovery,
} from "../collectblock.js";
import {
  createInventorySnapshot,
  estimateInventorySpace,
} from "../../inventory/snapshot.js";

const VALID_LOGS = [
  "oak_log", "birch_log", "spruce_log", "jungle_log",
  "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log",
  "crimson_stem", "warped_stem",
] as const;

export const chopTrees = defineSkill({
  name: "chopTrees",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  description:
    "Find and fell whole trees of a given log type. Floods to grab connected logs so the tree " +
    "doesn't leave a floating top. Repeats until `count` trees are felled. Use when the owner " +
    "says 'chop some trees', 'get wood', 'fell 3 oak'.",
  params: z.object({
    logType: z
      .enum(VALID_LOGS)
      .describe("Vanilla log block name like 'oak_log', 'birch_log'"),
    count: z.number().int().min(1).max(16).describe("Number of trees to fell"),
    searchRadius: z.number().int().min(8).max(128).default(64),
  }),
  longRunning: true,
  async run({ logType, count, searchRadius }, ctx) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot = ctx.bot as any;
    if (!bot.registry?.blocksByName?.[logType]) {
      return {
        ok: false, summary: `unknown block name: ${logType}`,
        code: "INVALID_PARAMS", recoverable: false, details: { logType },
      };
    }
    if (typeof bot.collectBlock?.collect !== "function") {
      return {
        ok: false, summary: "mineflayer-collectblock plugin not loaded",
        code: "PLUGIN_UNAVAILABLE", recoverable: false,
      };
    }

    let felled = 0;
    let navigationRecoveries = 0;
    while (felled < count) {
      if (ctx.signal.aborted) {
        return {
          ok: false, summary: `chopTrees cancelled after ${felled}/${count}`,
          code: "INTERRUPTED", recoverable: true, details: { logType, felled, target: count },
        };
      }
      if (estimateInventorySpace(ctx.bot, logType) === 0) {
        const snapshot = createInventorySnapshot(ctx.bot);
        return {
          ok: false,
          summary:
            `cannot chop more ${logType}: inventory is full ` +
            `(${snapshot.usedSlots}/${snapshot.capacity} slots)`,
          code: "INVENTORY_FULL",
          recoverable: true,
          details: {
            item: logType,
            felled,
            target: count,
            freeSlots: snapshot.freeSlots,
            guidance: "deposit carried items before chopping more trees",
          },
        };
      }
      const seed = findNearestBlockByName(ctx.bot, logType, searchRadius);
      if (!seed) {
        if (felled > 0) {
          return { ok: true, summary: `felled ${felled} ${logType} trees (no more within ${searchRadius})` };
        }
        return {
          ok: false, summary: `no ${logType} within ${searchRadius} blocks`,
          code: "NO_BLOCK_FOUND", recoverable: true, details: { logType, searchRadius },
        };
      }
      const logs = findConnectedLogs(ctx.bot, seed.position, logType);
      ctx.reportProgress(`tree ${felled + 1}/${count}: ${logs.length} logs`);
      for (const pos of logs) {
        if (ctx.signal.aborted) {
          return {
            ok: false, summary: `chopTrees cancelled mid-tree at ${felled}/${count}`,
            code: "INTERRUPTED", recoverable: true, details: { logType, felled, target: count },
          };
        }
        const block = bot.blockAt(pos);
        if (!block || block.name !== logType) continue;
        try {
          const telemetry = await collectBlockWithRecovery(
            ctx.bot,
            block,
            ctx.signal,
          );
          if (telemetry.attempts > 1) navigationRecoveries++;
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          if (msg === "aborted" || ctx.signal.aborted) {
            return {
              ok: false, summary: `chopTrees cancelled at ${felled}/${count}`,
              code: "INTERRUPTED", recoverable: true, details: { logType, felled, target: count },
            };
          }
          return {
            ok: false, summary: `chopTrees failed at ${felled}/${count}: ${msg}`,
            code: "NO_PATH", recoverable: true,
            details: {
              logType,
              felled,
              target: count,
              message: msg,
              navigationRecoveries,
              ...collectBlockFailureDetails(err),
            },
          };
        }
      }
      felled++;
    }
    return {
      ok: true,
      summary: `felled ${felled} ${logType} trees`,
      data: { felled, navigationRecoveries },
    };
  },
});
