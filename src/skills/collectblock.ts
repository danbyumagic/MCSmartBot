// src/skills/collectblock.ts
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import collectBlockPkg from "mineflayer-collectblock";
import {
  goals,
  pathfindTo,
  pathfindingFailureDetails,
  setFlightEnabled,
  isFlightEnabled,
  type PathfindTelemetry,
} from "./pathfinder.js";

const plugin = (collectBlockPkg as { plugin?: unknown; default?: unknown }).plugin
  ?? (collectBlockPkg as { default?: unknown }).default;

/**
 * Lazily load mineflayer-collectblock onto the bot. Safe to call repeatedly;
 * only loads once. Must be called after `inject_allowed` fires (same constraint
 * as `ensurePathfinder`).
 */
export function ensureCollectBlock(bot: Bot): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((bot as any).collectBlock) return;
  if (typeof plugin !== "function") {
    throw new Error("mineflayer-collectblock plugin export not callable");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot.loadPlugin(plugin as any);
}

export interface CollectBlockTelemetry {
  attempts: number;
  approach?: PathfindTelemetry;
}

export class CollectBlockFailure extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CollectBlockFailure";
  }
}

/**
 * collectblock owns its own pathfinder call and uses the library's short
 * default planning timeout. If that route fails, approach the target through
 * SmartBot's staged recovery pathfinder, then retry collection once.
 */
export async function collectBlockWithRecovery(
  bot: Bot,
  block: Block,
  signal: AbortSignal,
): Promise<CollectBlockTelemetry> {
  const collect = (bot as Bot & {
    collectBlock?: { collect?: (target: Block) => Promise<void> };
  }).collectBlock?.collect;
  if (typeof collect !== "function") {
    throw new CollectBlockFailure("mineflayer-collectblock plugin not loaded", {
      failureKind: "plugin_unavailable",
      attempts: 0,
    });
  }

  let approach: PathfindTelemetry | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal.aborted) throw new Error("aborted");
    try {
      await collect.call(
        (bot as Bot & { collectBlock: unknown }).collectBlock,
        block,
      );
      setFlightEnabled(bot, isFlightEnabled());
      return { attempts: attempt, approach };
    } catch (err) {
      if (signal.aborted || messageOf(err) === "aborted") throw new Error("aborted");
      const message = messageOf(err);
      if (attempt === 2 || !isCollectionPathFailure(message)) {
        throw new CollectBlockFailure(
          `collect failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${message}`,
          {
            failureKind: isCollectionPathFailure(message) ? "collection_no_path" : "collection_error",
            attempts: attempt,
            message,
            approach,
          },
        );
      }

      try {
        approach = await pathfindTo(
          bot,
          new goals.GoalNear(
            block.position.x,
            block.position.y,
            block.position.z,
            3,
          ),
          signal,
        );
      } catch (pathErr) {
        throw new CollectBlockFailure(
          `could not approach ${block.name} at ${block.position}: ${messageOf(pathErr)}`,
          {
            failureKind: "approach_failed",
            collectMessage: message,
            ...pathfindingFailureDetails(pathErr),
          },
        );
      }
    }
  }

  throw new CollectBlockFailure("collect recovery exhausted", {
    failureKind: "collection_error",
    attempts: 2,
  });
}

export function collectBlockFailureDetails(err: unknown): Record<string, unknown> {
  return err instanceof CollectBlockFailure
    ? err.details
    : { failureKind: "collection_error", message: messageOf(err) };
}

function isCollectionPathFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no path") ||
    lower.includes("too long") ||
    lower.includes("to long") ||
    lower.includes("timeout") ||
    lower.includes("goal") ||
    lower.includes("path stopped")
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
