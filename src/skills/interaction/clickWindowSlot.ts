import { z } from "zod";
import { defineSkill } from "../types.js";
import {
  sameWindowItem,
  summarizeWindow,
  summarizeWindowItem,
} from "./inspectWindow.js";

const clickModes = {
  click: 0,
  shift: 1,
  drop: 4,
} as const;

const params = z.object({
  slot: z.number().int().min(0).max(4_095).describe("Exact numeric slot in the currently open window."),
  mouseButton: z.number().int().min(0).max(1).describe("0 for primary/left, 1 for secondary/right."),
  mode: z.enum(["click", "shift", "drop"]).default("click").describe(
    "Narrow supported Mineflayer click mode; drag, hotbar swap, creative, and raw protocol modes are unavailable.",
  ),
});

/**
 * Execute one narrow, owner-authorized Mineflayer window click. The action is
 * limited to a live slot and three understood modes; it is not a packet API.
 */
export const clickWindowSlot = defineSkill({
  name: "clickWindowSlot",
  policy: { minimumRole: "owner", effect: "destructive", reversible: false, mission: "public" },
  description:
    "Click one exact slot in the currently open Minecraft window using a small safe set of click modes. " +
    "Verifies and returns sanitized before/after slot and cursor state.",
  params,
  async run({ slot, mouseButton, mode }, ctx) {
    if (ctx.signal.aborted) return interrupted();
    const window = ctx.bot.currentWindow;
    if (!window || !Array.isArray(window.slots)) return noWindow();
    if (slot >= window.slots.length) {
      return {
        ok: false,
        summary: `slot ${slot} is outside the current window (0-${Math.max(0, window.slots.length - 1)})`,
        code: "INVALID_PARAMS",
        recoverable: false,
        details: { slot, slotCount: window.slots.length },
      };
    }

    const before = {
      slot: summarizeWindowItem(window.slots[slot]),
      cursor: summarizeWindowItem(window.selectedItem),
    };
    const windowBefore = summarizeWindow(window);
    if (!windowBefore) return noWindow();
    if (ctx.signal.aborted) return interrupted();

    // There are no awaits between this identity check and Mineflayer's
    // invocation, so it cannot fall back to clicking the player inventory
    // because the current container closed in between.
    if (ctx.bot.currentWindow !== window) return windowChanged(before, windowBefore);
    try {
      await ctx.bot.clickWindow(slot, mouseButton, clickModes[mode]);
    } catch (error) {
      if (ctx.signal.aborted) return interrupted(true);
      if (ctx.bot.currentWindow !== window) return windowChanged(before, windowBefore, true);
      const message = errorMessage(error);
      return {
        ok: false,
        summary: `window click failed: ${message}`,
        code: "SERVER_REJECTED",
        recoverable: true,
        details: { slot, mouseButton, mode, before, message },
      };
    }

    if (ctx.signal.aborted) return interrupted(true);
    if (ctx.bot.currentWindow !== window) return windowChanged(before, windowBefore, true);
    if (!Array.isArray(window.slots) || slot >= window.slots.length) {
      return windowChanged(before, windowBefore, true);
    }
    const after = {
      slot: summarizeWindowItem(window.slots[slot]),
      cursor: summarizeWindowItem(window.selectedItem),
    };
    const windowAfter = summarizeWindow(window);
    if (!windowAfter) return windowChanged(before, windowBefore, true);

    return {
      ok: true,
      summary: `clicked slot ${slot} using ${mode} mode`,
      data: {
        slot,
        mouseButton,
        mode,
        changed: !sameWindowItem(before.slot, after.slot) || !sameWindowItem(before.cursor, after.cursor),
        before,
        after,
        window: windowAfter,
      },
    };
  },
});

function noWindow() {
  return {
    ok: false,
    summary: "no Minecraft window is currently open",
    code: "TARGET_UNAVAILABLE" as const,
    recoverable: true,
  };
}

function windowChanged(
  before: { slot: ReturnType<typeof summarizeWindowItem>; cursor: ReturnType<typeof summarizeWindowItem> },
  windowBefore: ReturnType<typeof summarizeWindow>,
  actionMayHaveCompleted = false,
) {
  return {
    ok: false,
    summary: "the Minecraft window changed or closed during the click",
    code: "STALE_STATE" as const,
    recoverable: true,
    details: {
      before,
      ...(windowBefore ? { window: windowBefore } : {}),
      ...(actionMayHaveCompleted ? { actionMayHaveCompleted: true } : {}),
    },
  };
}

function interrupted(actionMayHaveCompleted = false) {
  return {
    ok: false,
    summary: "window click interrupted",
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: actionMayHaveCompleted ? { actionMayHaveCompleted: true } : undefined,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}
