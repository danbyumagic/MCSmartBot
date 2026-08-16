import { z } from "zod";
import { defineSkill } from "../types.js";
import { summarizeWindow } from "./inspectWindow.js";

/**
 * Close the currently open interaction window. This is classified as a world
 * interaction rather than inventory access: it changes the bot's active GUI
 * session but never moves an item by itself.
 */
export const closeWindow = defineSkill({
  name: "closeWindow",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  description:
    "Close the currently open Minecraft interaction window. Safe to call when no window is open.",
  params: z.object({}),
  async run(_params, ctx) {
    if (ctx.signal.aborted) return interrupted();
    const window = ctx.bot.currentWindow;
    if (!window) {
      return {
        ok: true,
        summary: "no Minecraft window was open",
        data: { closed: false, alreadyClosed: true },
      };
    }
    const before = summarizeWindow(window);
    try {
      ctx.bot.closeWindow(window);
    } catch (error) {
      if (ctx.signal.aborted) return interrupted(true);
      const message = errorMessage(error);
      return {
        ok: false,
        summary: `failed to close Minecraft window: ${message}`,
        code: "SERVER_REJECTED",
        recoverable: true,
        details: { ...(before ? { window: before } : {}), message },
      };
    }

    if (ctx.signal.aborted) return interrupted(true);
    if (ctx.bot.currentWindow !== null && ctx.bot.currentWindow !== window) {
      return {
        ok: false,
        summary: "the Minecraft window changed while closing it",
        code: "STALE_STATE",
        recoverable: true,
        details: { ...(before ? { window: before } : {}), actionMayHaveCompleted: true },
      };
    }
    const confirmed = ctx.bot.currentWindow === null;
    return {
      ok: true,
      summary: confirmed ? "closed Minecraft window" : "requested Minecraft window close",
      data: {
        closed: true,
        confirmed,
        ...(before ? { window: before } : {}),
      },
    };
  },
});

function interrupted(actionMayHaveCompleted = false) {
  return {
    ok: false,
    summary: "window close interrupted",
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: actionMayHaveCompleted ? { actionMayHaveCompleted: true } : undefined,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}
