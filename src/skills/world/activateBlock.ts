import { Vec3 } from "vec3";
import { z } from "zod";
import { defineSkill } from "../types.js";
import {
  isAirSnapshot,
  sameBlockSnapshot,
  snapshotBlock,
  type BlockSnapshot,
} from "../../world/blockSnapshot.js";
import { ensureReachableBlock } from "../../world/reach.js";
import type { BlockPosition } from "../../world/types.js";

const coordinate = z.number().finite().int().min(-30_000_000).max(30_000_000);
const verticalCoordinate = z.number().finite().int().min(-64).max(320);

/**
 * Activate one exact block after routing to it and refreshing its live world
 * state. This intentionally is not a block-change transaction: interaction
 * effects such as container access, redstone, and doors are asynchronous and
 * may affect more than one block.
 */
export const activateBlock = defineSkill({
  name: "activateBlock",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  description:
    "Activate one exact block at integer coordinates after safely reaching and rereading it. " +
    "Returns bounded block and currently-open window information when available.",
  params: z.object({
    x: coordinate.describe("Exact block X coordinate."),
    y: verticalCoordinate.describe("Exact block Y coordinate."),
    z: coordinate.describe("Exact block Z coordinate."),
  }),
  async run({ x, y, z }, ctx) {
    const target: BlockPosition = { x, y, z };
    if (ctx.signal.aborted) return interrupted(target);

    const initialBlock = ctx.bot.blockAt(new Vec3(x, y, z));
    if (!initialBlock) return unavailable(target);
    const initial = snapshotBlock(initialBlock, target);
    if (isAirSnapshot(initial)) return unavailableTarget(target, initial);

    const reachable = await ensureReachableBlock(ctx.bot as never, target, {
      signal: ctx.signal,
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
      return stale(target, initial, reached, "while reaching it");
    }
    if (ctx.signal.aborted) return interrupted(target);

    // The reach helper rereads after pathfinding. Read once more immediately
    // before the interaction so a Mineflayer Block object is never held across
    // an await and then used after the world has changed.
    const liveBlock = ctx.bot.blockAt(new Vec3(x, y, z));
    if (!liveBlock) return unavailable(target);
    const live = snapshotBlock(liveBlock, target);
    if (!sameBlockSnapshot(reached, live)) {
      return stale(target, reached, live, "immediately before activation");
    }
    if (isAirSnapshot(live)) return stale(target, reached, live, "immediately before activation");
    if (ctx.signal.aborted) return interrupted(target);

    try {
      await ctx.bot.activateBlock(liveBlock);
    } catch (error) {
      if (ctx.signal.aborted) return interrupted(target, true);
      const message = errorMessage(error);
      return {
        ok: false,
        summary: `failed to activate ${live.name} at ${formatPosition(target)}: ${message}`,
        code: "SERVER_REJECTED",
        recoverable: true,
        details: { target, block: publicBlock(live), message },
      };
    }

    if (ctx.signal.aborted) return interrupted(target, true);
    return {
      ok: true,
      summary: `activated ${live.name} at ${formatPosition(target)}`,
      data: {
        target,
        block: publicBlock(live),
        window: summarizeWindow(ctx.bot.currentWindow),
        pathfound: reachable.pathfound,
      },
    };
  },
});

function unavailable(target: BlockPosition) {
  return {
    ok: false,
    summary: `world data unavailable at ${formatPosition(target)}`,
    code: "WORLD_UNAVAILABLE" as const,
    recoverable: true,
    details: { target },
  };
}

function unavailableTarget(target: BlockPosition, block: BlockSnapshot) {
  return {
    ok: false,
    summary: `no activatable block at ${formatPosition(target)}`,
    code: "TARGET_UNAVAILABLE" as const,
    recoverable: true,
    details: { target, block: publicBlock(block) },
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
    summary: `block changed ${phase} at ${formatPosition(target)}`,
    code: "STALE_STATE" as const,
    recoverable: true,
    details: { target, before: publicBlock(before), current: publicBlock(current) },
  };
}

function interrupted(target: BlockPosition, actionMayHaveCompleted = false) {
  return {
    ok: false,
    summary: `activateBlock interrupted at ${formatPosition(target)}`,
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: { target, ...(actionMayHaveCompleted ? { actionMayHaveCompleted: true } : {}) },
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

function summarizeWindow(window: unknown): {
  type: string | number;
  title: string;
  slotCount: number;
} | null {
  if (typeof window !== "object" || window === null) return null;
  const candidate = window as {
    type?: unknown;
    title?: unknown;
    slots?: unknown;
  };
  const type = typeof candidate.type === "string" || typeof candidate.type === "number"
    ? candidate.type
    : "unknown";
  const title = typeof candidate.title === "string" ? candidate.title.slice(0, 256) : "";
  const slotCount = Array.isArray(candidate.slots) ? Math.min(candidate.slots.length, 4_096) : 0;
  return { type, title, slotCount };
}

function formatPosition(target: BlockPosition): string {
  return `${target.x},${target.y},${target.z}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
