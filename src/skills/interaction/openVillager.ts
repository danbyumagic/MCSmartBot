// Portions adapted from https://github.com/AhmadTariq1337/minecraft-mcp-server,
// src/tools/social.ts @ 39ab7c3a3d5cb1f6262fba080858b083647e650a.
// Licensed under MIT; see LICENSES/ahmad-minecraft-mcp-MIT.txt.
// Modified for SmartBotMC: bounded stable selectors, guarded reach handling,
// sanitized offers, cancellation, and no raw MCP/window exposure.

import { z } from "zod";
import { goals, pathfindTo } from "../pathfinder.js";
import { defineSkill } from "../types.js";
import {
  entitySelectorSchema,
  resolveEntitySelector,
  type EntitySelector,
  type EntitySelectorFailure,
  type EntitySelectorSuccess,
  type EntityTarget,
} from "./entitySelector.js";
import { summarizeWindow, summarizeWindowItem, type WindowItemSummary } from "./inspectWindow.js";

const MAX_VILLAGER_DISTANCE = 32;
const VILLAGER_REACH = 3.5;
const MAX_TRADES = 128;

export interface VillagerTradeSummary {
  readonly index: number;
  readonly inputs: readonly WindowItemSummary[];
  readonly output: WindowItemSummary | null;
  readonly remainingUses: number;
  readonly disabled: boolean;
}

/** Open one verified villager interaction and return bounded trade data. */
export const openVillager = defineSkill({
  name: "openVillager",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  description:
    "Open trades with one live villager selected by recent entity ID or exact villager type within a bounded radius, then return sanitized bounded trade offers.",
  params: z.object({ selector: entitySelectorSchema }),
  async run({ selector }, ctx) {
    if (ctx.signal.aborted) return interrupted();
    const initial = resolveEntitySelector(ctx.bot, selector);
    if (!initial.ok) return initial;
    if (!isVillager(initial.target)) return notVillager(initial.target);
    if (initial.target.distance > MAX_VILLAGER_DISTANCE) return tooFar(initial.target, MAX_VILLAGER_DISTANCE);

    const reached = await reachVillager(ctx, selector, initial.target);
    if (!reached.ok) return reached;
    if (ctx.signal.aborted) return interrupted(reached.target, false);
    try {
      const window = await ctx.bot.openVillager(reached.entity);
      if (ctx.signal.aborted) return interrupted(reached.target, true);
      return {
        ok: true,
        summary: `opened ${label(reached.target)} with ${tradesFrom(window).length} trade offers`,
        data: {
          target: reached.target,
          trades: tradesFrom(window),
          window: summarizeWindow(window),
        },
      };
    } catch (error) {
      if (ctx.signal.aborted) return interrupted(reached.target, true);
      const message = errorMessage(error);
      return {
        ok: false,
        summary: `failed to open ${label(reached.target)}: ${message}`,
        code: "SERVER_REJECTED",
        recoverable: true,
        details: { target: reached.target, message },
      };
    }
  },
});

/** Convert a live villager window into primitive trade data for this and tradeVillager. */
export function tradesFrom(window: unknown): readonly VillagerTradeSummary[] {
  if (typeof window !== "object" || window === null || !Array.isArray((window as { trades?: unknown }).trades)) return [];
  return (window as { trades: unknown[] }).trades.slice(0, MAX_TRADES).map((trade, index) => summarizeTrade(trade, index));
}

function summarizeTrade(value: unknown, index: number): VillagerTradeSummary {
  const trade = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const first = summarizeWindowItem(trade.inputItem1);
  const second = trade.hasItem2 === true ? summarizeWindowItem(trade.inputItem2) : null;
  const max = finiteNonNegative(trade.maximumNbTradeUses);
  const used = finiteNonNegative(trade.nbTradeUses);
  return Object.freeze({
    index,
    inputs: Object.freeze([first, second].filter((item): item is WindowItemSummary => item !== null)),
    output: summarizeWindowItem(trade.outputItem),
    remainingUses: Math.max(0, max - used),
    disabled: trade.tradeDisabled === true,
  });
}

async function reachVillager(
  ctx: Parameters<typeof openVillager.run>[1],
  selector: EntitySelector,
  initial: EntityTarget,
): Promise<EntitySelectorSuccess | EntitySelectorFailure | ReachFailure> {
  if (initial.distance > VILLAGER_REACH) {
    try {
      await pathfindTo(ctx.bot, new goals.GoalNear(initial.position.x, initial.position.y, initial.position.z, 2), ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted || errorMessage(error) === "aborted") return interrupted(initial, false);
      return {
        ok: false,
        summary: `could not reach ${label(initial)}: ${errorMessage(error)}`,
        code: "NO_PATH",
        recoverable: true,
        details: { target: initial },
      };
    }
  }
  if (ctx.signal.aborted) return interrupted(initial, false);
  const current = resolveEntitySelector(ctx.bot, selector);
  if (!current.ok) return current;
  if (current.target.id !== initial.id || !isVillager(current.target)) {
    return {
      ok: false,
      summary: "villager changed or is no longer available after routing",
      code: "TARGET_UNAVAILABLE",
      recoverable: true,
      details: { before: initial, ...(current.ok ? { current: current.target } : {}) },
    };
  }
  if (current.target.distance > VILLAGER_REACH) return tooFar(current.target, VILLAGER_REACH);
  return current;
}

function isVillager(target: EntityTarget): boolean {
  return target.name === "villager" || target.name.endsWith("_villager");
}

function notVillager(target: EntityTarget) {
  return {
    ok: false,
    summary: `${label(target)} is not a villager`,
    code: "TARGET_UNAVAILABLE" as const,
    recoverable: false,
    details: { target },
  };
}

interface ReachFailure {
  readonly ok: false;
  readonly summary: string;
  readonly code: "NO_PATH" | "TARGET_UNAVAILABLE" | "INTERRUPTED";
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;
}

function tooFar(target: EntityTarget, maximumDistance: number): ReachFailure {
  return {
    ok: false as const,
    summary: `${label(target)} is ${target.distance} blocks away; bounded villager range is ${maximumDistance}`,
    code: "TARGET_UNAVAILABLE" as const,
    recoverable: true,
    details: { target, maximumDistance },
  };
}

function interrupted(target?: EntityTarget, actionMayHaveCompleted = false): ReachFailure {
  return {
    ok: false as const,
    summary: "opening villager trades interrupted",
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: {
      ...(target === undefined ? {} : { target }),
      ...(actionMayHaveCompleted ? { actionMayHaveCompleted: true } : {}),
    },
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function label(target: EntityTarget): string {
  return target.username ?? target.name;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
