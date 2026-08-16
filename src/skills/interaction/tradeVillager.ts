// Portions adapted from https://github.com/AhmadTariq1337/minecraft-mcp-server,
// src/tools/social.ts @ 39ab7c3a3d5cb1f6262fba080858b083647e650a.
// Licensed under MIT; see LICENSES/ahmad-minecraft-mcp-MIT.txt.
// Modified for SmartBotMC: live offer/material validation, inventory and use
// delta verification, cancellation, and structured stale-window failures.

import { z } from "zod";
import { defineSkill } from "../types.js";
import { summarizeWindowItem, type WindowItemSummary } from "./inspectWindow.js";
import { tradesFrom, type VillagerTradeSummary } from "./openVillager.js";

const MAX_TRADE_TIMES = 64;

/** Execute a verified amount of a currently-open villager offer. */
export const tradeVillager = defineSkill({
  name: "tradeVillager",
  policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
  description:
    "Trade a bounded number of times using one currently open live villager offer. Validates trade availability and verifies the output inventory delta.",
  params: z.object({
    index: z.number().int().min(0).max(127).describe("Live zero-based villager trade offer index."),
    times: z.number().int().min(1).max(MAX_TRADE_TIMES).default(1).describe("Number of times to perform this exact offer."),
  }),
  async run({ index, times }, ctx) {
    if (ctx.signal.aborted) return interrupted();
    const window = currentVillagerWindow(ctx.bot.currentWindow);
    if (!window) return noVillagerWindow();
    const offer = tradesFrom(window)[index];
    if (!offer) return invalidOffer(index, tradesFrom(window).length);
    if (offer.disabled || offer.remainingUses < times) return unavailableOffer(offer, times);
    const materials = enoughMaterials(ctx.bot.inventory.items(), offer, times);
    if (!materials.ok) return materials.result;
    const before = countByName(ctx.bot.inventory.items());
    const beforeUses = currentUses(window, index);
    if (ctx.signal.aborted) return interrupted();
    try {
      await ctx.bot.trade(window as never, index, times);
    } catch (error) {
      if (ctx.signal.aborted) return interrupted(true);
      if ((ctx.bot.currentWindow as unknown) !== window) return staleWindow(true);
      const message = errorMessage(error);
      return {
        ok: false,
        summary: `villager trade failed: ${message}`,
        code: "SERVER_REJECTED",
        recoverable: true,
        details: { index, times, offer, message },
      };
    }
    if (ctx.signal.aborted) return interrupted(true);
    if ((ctx.bot.currentWindow as unknown) !== window) return staleWindow(true);
    const after = countByName(ctx.bot.inventory.items());
    const afterUses = currentUses(window, index);
    const verification = verifyTrade(before, after, offer, times, beforeUses, afterUses);
    if (!verification.ok) {
      return {
        ok: false,
        summary: "villager trade completed but inventory/use changes could not be verified",
        code: "STALE_STATE",
        recoverable: true,
        details: { index, times, offer, ...verification.details },
      };
    }
    return {
      ok: true,
      summary: `traded offer ${index} x${times}`,
      data: {
        index,
        times,
        offer,
        outputDelta: verification.outputDelta,
        inputDeltas: verification.inputDeltas,
        usesBefore: beforeUses,
        usesAfter: afterUses,
      },
    };
  },
});

function currentVillagerWindow(value: unknown): VillagerWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as VillagerWindow;
  return Array.isArray(candidate.trades) ? candidate : undefined;
}

interface VillagerWindow {
  trades: unknown[];
}

function currentUses(window: VillagerWindow, index: number): number | undefined {
  const trade = window.trades[index];
  if (typeof trade !== "object" || trade === null) return undefined;
  const uses = (trade as { nbTradeUses?: unknown }).nbTradeUses;
  return typeof uses === "number" && Number.isFinite(uses) ? Math.max(0, Math.floor(uses)) : undefined;
}

function countByName(items: Array<{ name: string; count: number }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item || typeof item.name !== "string" || typeof item.count !== "number") continue;
    counts.set(item.name, (counts.get(item.name) ?? 0) + Math.max(0, item.count));
  }
  return counts;
}

function enoughMaterials(
  items: Array<{ name: string; count: number }>,
  offer: VillagerTradeSummary,
  times: number,
): { ok: true } | { ok: false; result: ReturnType<typeof missingMaterials> } {
  const carried = countByName(items);
  const needed = new Map<string, number>();
  for (const input of offer.inputs) {
    needed.set(input.name, (needed.get(input.name) ?? 0) + input.count * times);
  }
  const missing = [...needed.entries()]
    .filter(([name, count]) => (carried.get(name) ?? 0) < count)
    .map(([name, count]) => ({ name, required: count, available: carried.get(name) ?? 0 }));
  return missing.length === 0 ? { ok: true } : { ok: false, result: missingMaterials(missing) };
}

function verifyTrade(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  offer: VillagerTradeSummary,
  times: number,
  usesBefore: number | undefined,
  usesAfter: number | undefined,
): { ok: true; outputDelta: number; inputDeltas: Record<string, number> } | { ok: false; details: Record<string, unknown> } {
  const output = offer.output;
  if (!output) return { ok: false, details: { reason: "offer_has_no_output" } };
  const outputDelta = (after.get(output.name) ?? 0) - (before.get(output.name) ?? 0);
  const inputDeltas: Record<string, number> = {};
  const requiredInputs = new Map<string, number>();
  for (const input of offer.inputs) {
    requiredInputs.set(input.name, (requiredInputs.get(input.name) ?? 0) + input.count * times);
  }
  const outputAlsoInput = requiredInputs.has(output.name);
  for (const [name] of requiredInputs) inputDeltas[name] = (after.get(name) ?? 0) - (before.get(name) ?? 0);
  const inputsVerified = [...requiredInputs.entries()].every(([name, needed]) =>
    outputAlsoInput && name === output.name
      ? inputDeltas[name]! <= -needed + output.count * times
      : inputDeltas[name]! <= -needed,
  );
  const usesVerified = usesBefore === undefined || usesAfter === undefined || usesAfter >= usesBefore + times;
  const outputVerified = outputAlsoInput
    ? inputDeltas[output.name]! >= -requiredInputs.get(output.name)! + output.count * times
    : outputDelta >= output.count * times;
  if (inputsVerified && outputVerified && usesVerified) {
    return { ok: true, outputDelta, inputDeltas };
  }
  return {
    ok: false,
    details: {
      expectedOutput: { name: output.name, count: output.count * times },
      outputDelta,
      inputDeltas,
      usesBefore,
      usesAfter,
      inputsVerified,
      outputVerified,
      usesVerified,
    },
  };
}

function noVillagerWindow() {
  return {
    ok: false,
    summary: "no live villager trade window is currently open",
    code: "TARGET_UNAVAILABLE" as const,
    recoverable: true,
  };
}

function invalidOffer(index: number, count: number) {
  return {
    ok: false,
    summary: `trade offer ${index} is outside the current villager range (0-${Math.max(0, count - 1)})`,
    code: "INVALID_PARAMS" as const,
    recoverable: false,
    details: { index, offerCount: count },
  };
}

function unavailableOffer(offer: VillagerTradeSummary, times: number) {
  return {
    ok: false,
    summary: offer.disabled ? `trade offer ${offer.index} is disabled` : `trade offer ${offer.index} has only ${offer.remainingUses} uses remaining`,
    code: "TARGET_UNAVAILABLE" as const,
    recoverable: true,
    details: { offer, requestedTimes: times },
  };
}

function missingMaterials(missing: Array<{ name: string; required: number; available: number }>) {
  return {
    ok: false,
    summary: "missing carried items required for the selected villager trade",
    code: "NO_MATERIAL" as const,
    recoverable: true,
    details: { missing },
  };
}

function staleWindow(actionMayHaveCompleted = false) {
  return {
    ok: false,
    summary: "villager trade window changed or closed during the trade",
    code: "STALE_STATE" as const,
    recoverable: true,
    details: actionMayHaveCompleted ? { actionMayHaveCompleted: true } : undefined,
  };
}

function interrupted(actionMayHaveCompleted = false) {
  return {
    ok: false,
    summary: "villager trade interrupted",
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: actionMayHaveCompleted ? { actionMayHaveCompleted: true } : undefined,
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
