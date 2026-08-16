import { describe, expect, it, vi } from "vitest";
import { clickWindowSlot } from "../../../src/skills/interaction/clickWindowSlot.js";
import type { SkillContext } from "../../../src/skills/types.js";

function makeContext(bot: unknown, controller = new AbortController()): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: bot as SkillContext["bot"],
    signal: controller.signal,
    log,
    reportProgress: vi.fn(),
  };
}

function makeWindow() {
  return {
    type: "minecraft:generic_9x3",
    title: "Chest",
    slots: [
      { name: "apple", count: 3, type: 260, metadata: 0 },
      null,
    ],
    selectedItem: null,
  };
}

describe("clickWindowSlot", () => {
  it("is an owner-only destructive action", () => {
    expect(clickWindowSlot.policy).toEqual({
      minimumRole: "owner",
      effect: "destructive",
      reversible: false,
      mission: "public",
    });
  });

  it("only accepts bounded slots, two mouse buttons, and a small click-mode enum", () => {
    expect(clickWindowSlot.params.parse({ slot: 2, mouseButton: 0 })).toEqual({
      slot: 2,
      mouseButton: 0,
      mode: "click",
    });
    expect(() => clickWindowSlot.params.parse({ slot: -1, mouseButton: 0, mode: "click" })).toThrow();
    expect(() => clickWindowSlot.params.parse({ slot: 0, mouseButton: 2, mode: "click" })).toThrow();
    expect(() => clickWindowSlot.params.parse({ slot: 0, mouseButton: 0, mode: "drag" })).toThrow();
  });

  it("rejects a missing window and never falls back to the player inventory", async () => {
    const clickWindow = vi.fn();
    const result = await clickWindowSlot.run(
      { slot: 0, mouseButton: 0, mode: "click" },
      makeContext({ currentWindow: null, clickWindow }),
    );

    expect(clickWindow).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE", recoverable: true });
  });

  it("rejects out-of-range live slots before issuing a click", async () => {
    const window = makeWindow();
    const clickWindow = vi.fn();
    const result = await clickWindowSlot.run(
      { slot: 2, mouseButton: 0, mode: "click" },
      makeContext({ currentWindow: window, clickWindow }),
    );

    expect(clickWindow).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
      recoverable: false,
      details: { slot: 2, slotCount: 2 },
    });
  });

  it("uses Mineflayer's numeric mode and verifies sanitized slot/cursor state", async () => {
    const window = makeWindow();
    const bot: { currentWindow: typeof window | null; clickWindow: ReturnType<typeof vi.fn> } = {
      currentWindow: window,
      clickWindow: vi.fn(async (slot: number, mouseButton: number, mode: number) => {
        expect([slot, mouseButton, mode]).toEqual([0, 0, 0]);
        window.selectedItem = window.slots[0];
        window.slots[0] = null;
      }),
    };

    const result = await clickWindowSlot.run(
      { slot: 0, mouseButton: 0, mode: "click" },
      makeContext(bot),
    );

    expect(bot.clickWindow).toHaveBeenCalledWith(0, 0, 0);
    expect(result).toMatchObject({
      ok: true,
      data: {
        slot: 0,
        mouseButton: 0,
        mode: "click",
        changed: true,
        before: { slot: { name: "apple", count: 3 }, cursor: null },
        after: { slot: null, cursor: { name: "apple", count: 3 } },
      },
    });
  });

  it("does not claim a confirmed click if the window closes during the request", async () => {
    const window = makeWindow();
    const bot: { currentWindow: typeof window | null; clickWindow: ReturnType<typeof vi.fn> } = {
      currentWindow: window,
      clickWindow: vi.fn(async () => {
        bot.currentWindow = null;
      }),
    };

    const result = await clickWindowSlot.run(
      { slot: 0, mouseButton: 1, mode: "drop" },
      makeContext(bot),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "STALE_STATE",
      recoverable: true,
      details: { actionMayHaveCompleted: true },
    });
  });

  it("reports a stale window rather than a generic server error when rejection follows closure", async () => {
    const window = makeWindow();
    const bot: { currentWindow: typeof window | null; clickWindow: ReturnType<typeof vi.fn> } = {
      currentWindow: window,
      clickWindow: vi.fn(async () => {
        bot.currentWindow = null;
        throw new Error("transaction rejected after close");
      }),
    };

    const result = await clickWindowSlot.run(
      { slot: 0, mouseButton: 0, mode: "click" },
      makeContext(bot),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "STALE_STATE",
      details: { actionMayHaveCompleted: true },
    });
  });

  it("maps Mineflayer click errors to a technical failure", async () => {
    const window = makeWindow();
    const result = await clickWindowSlot.run(
      { slot: 0, mouseButton: 0, mode: "shift" },
      makeContext({
        currentWindow: window,
        clickWindow: vi.fn().mockRejectedValue(new Error("transaction rejected")),
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "SERVER_REJECTED",
      recoverable: true,
      details: { message: "transaction rejected" },
    });
  });

  it("does not click after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const clickWindow = vi.fn();
    const result = await clickWindowSlot.run(
      { slot: 0, mouseButton: 0, mode: "click" },
      makeContext({ currentWindow: makeWindow(), clickWindow }, controller),
    );

    expect(clickWindow).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED", recoverable: true });
  });
});
