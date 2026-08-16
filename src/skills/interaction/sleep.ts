import { Vec3 } from "vec3";
import { z } from "zod";
import { defineSkill } from "../types.js";
import {
  sameBlockSnapshot,
  snapshotBlock,
  type BlockSnapshot,
} from "../../world/blockSnapshot.js";
import { ensureReachableBlock } from "../../world/reach.js";
import type { BlockPosition } from "../../world/types.js";

const coordinate = z.number().finite().int().min(-30_000_000).max(30_000_000);
const verticalCoordinate = z.number().finite().int().min(-64).max(320);

const params = z.object({
  bed: z.object({
    x: coordinate.describe("Exact bed block X coordinate."),
    y: verticalCoordinate.describe("Exact bed block Y coordinate."),
    z: coordinate.describe("Exact bed block Z coordinate."),
  }).optional().describe("Optional exact bed position. Omit to find the nearest loaded bed."),
  searchRadius: z.number().int().min(2).max(32).default(16).describe(
    "Maximum distance for nearest-bed lookup when bed is omitted.",
  ),
});

/** Sleep in one exact bed, or a bounded nearest loaded bed when none is supplied. */
export const sleep = defineSkill({
  name: "sleep",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  description:
    "Sleep in an exact bed or the nearest loaded bed within a bounded radius. " +
    "The server decides whether sleeping is currently possible.",
  params,
  async run({ bed, searchRadius }, ctx) {
    if (ctx.signal.aborted) return interrupted();
    if (ctx.bot.isSleeping) {
      return {
        ok: true,
        summary: "already sleeping",
        data: { alreadySleeping: true },
      };
    }

    const selection = bed ? "exact" : "nearest";
    let target: BlockPosition;
    if (bed) {
      target = { x: bed.x, y: bed.y, z: bed.z };
    } else {
      const found = ctx.bot.findBlock({
        matching: (block) => isBedName(block?.name),
        maxDistance: searchRadius,
      });
      if (!found) {
        return {
          ok: false,
          summary: `no bed found within ${searchRadius} blocks`,
          code: "TARGET_UNAVAILABLE",
          recoverable: true,
          details: { searchRadius },
        };
      }
      target = { x: Math.floor(found.position.x), y: Math.floor(found.position.y), z: Math.floor(found.position.z) };
    }

    const initialBlock = ctx.bot.blockAt(new Vec3(target.x, target.y, target.z));
    if (!initialBlock) return unavailable(target, selection, searchRadius);
    const initial = snapshotBlock(initialBlock, target);
    if (!isBedName(initial.name)) {
      return selection === "exact"
        ? wrongBed(target, initial)
        : stale(target, initial, initial, "while selecting the nearest bed");
    }

    const reachable = await ensureReachableBlock(ctx.bot as never, target, {
      signal: ctx.signal,
      // Mineflayer's bed interaction has a tighter directional click range
      // than ordinary block activation, so route closer than the generic
      // interaction default before handing it the live bed object.
      reach: 2,
    });
    if (!reachable.ok) {
      return {
        ok: false,
        summary: reachable.summary,
        code: reachable.code,
        recoverable: reachable.recoverable,
        details: reachable.details,
      };
    }

    const reached = snapshotBlock(reachable.block, target);
    if (!sameBlockSnapshot(initial, reached)) {
      return stale(target, initial, reached, "while reaching the bed");
    }
    if (!isBedName(reached.name)) return wrongBed(target, reached);
    if (ctx.signal.aborted) return interrupted(target);

    // The generic reach helper has refreshed after routing; refresh once more
    // directly before calling Mineflayer so the bed object is live.
    const liveBlock = ctx.bot.blockAt(new Vec3(target.x, target.y, target.z));
    if (!liveBlock) return unavailable(target, selection, searchRadius);
    const live = snapshotBlock(liveBlock, target);
    if (!sameBlockSnapshot(reached, live)) {
      return stale(target, reached, live, "immediately before sleeping");
    }
    if (!isBedName(live.name)) return wrongBed(target, live);
    if (ctx.signal.aborted) return interrupted(target);

    try {
      await ctx.bot.sleep(liveBlock);
    } catch (error) {
      if (ctx.signal.aborted) return interrupted(target, true);
      if (ctx.bot.isSleeping) {
        return {
          ok: true,
          summary: "already sleeping",
          data: { bed: target, selection, pathfound: reachable.pathfound, alreadySleeping: true },
        };
      }
      const message = errorMessage(error);
      return {
        ok: false,
        summary: `failed to sleep in bed at ${formatPosition(target)}: ${message}`,
        code: "SERVER_REJECTED",
        recoverable: true,
        details: { bed: target, selection, block: publicBlock(live), message },
      };
    }

    if (ctx.signal.aborted) return interrupted(target, true);
    return {
      ok: true,
      summary: `sleeping in bed at ${formatPosition(target)}`,
      data: { bed: target, selection, block: publicBlock(live), pathfound: reachable.pathfound },
    };
  },
});

function isBedName(name: unknown): boolean {
  return typeof name === "string" && (name === "bed" || name.endsWith("_bed"));
}

function unavailable(target: BlockPosition, selection: "exact" | "nearest", searchRadius: number) {
  return {
    ok: false,
    summary: `world data unavailable at ${formatPosition(target)}`,
    code: "WORLD_UNAVAILABLE" as const,
    recoverable: true,
    details: { bed: target, selection, ...(selection === "nearest" ? { searchRadius } : {}) },
  };
}

function wrongBed(target: BlockPosition, block: BlockSnapshot) {
  return {
    ok: false,
    summary: `target at ${formatPosition(target)} is not a bed`,
    code: "TARGET_UNAVAILABLE" as const,
    recoverable: true,
    details: { bed: target, block: publicBlock(block) },
  };
}

function stale(
  target: BlockPosition,
  before: BlockSnapshot,
  current: BlockSnapshot,
  phase: string,
) {
  return {
    ok: false,
    summary: `bed changed ${phase} at ${formatPosition(target)}`,
    code: "STALE_STATE" as const,
    recoverable: true,
    details: { bed: target, before: publicBlock(before), current: publicBlock(current) },
  };
}

function interrupted(target?: BlockPosition, actionMayHaveCompleted = false) {
  return {
    ok: false,
    summary: target ? `sleep interrupted at ${formatPosition(target)}` : "sleep interrupted",
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: {
      ...(target ? { bed: target } : {}),
      ...(actionMayHaveCompleted ? { actionMayHaveCompleted: true } : {}),
    },
  };
}

function publicBlock(snapshot: BlockSnapshot) {
  return {
    name: snapshot.name,
    position: snapshot.position,
    ...(snapshot.stateId === undefined ? {} : { stateId: snapshot.stateId }),
    properties: snapshot.properties,
  };
}

function formatPosition(target: BlockPosition): string {
  return `${target.x},${target.y},${target.z}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
