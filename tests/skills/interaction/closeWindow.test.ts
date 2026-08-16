import { describe, expect, it, vi } from "vitest";
import { closeWindow } from "../../../src/skills/interaction/closeWindow.js";
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
    slots: [null],
    selectedItem: null,
  };
}

describe("closeWindow", () => {
  it("is an operator world-interaction action", () => {
    expect(closeWindow.policy).toEqual({
      minimumRole: "operator",
      effect: "world-change",
      reversible: false,
      mission: "public",
    });
  });

  it("is idempotent when no window is open", async () => {
    const close = vi.fn();
    const result = await closeWindow.run({}, makeContext({ currentWindow: null, closeWindow: close }));

    expect(close).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      data: { closed: false, alreadyClosed: true },
    });
  });

  it("closes the captured live window and confirms synchronous Mineflayer closure", async () => {
    const window = makeWindow();
    const bot: { currentWindow: typeof window | null; closeWindow: ReturnType<typeof vi.fn> } = {
      currentWindow: window,
      closeWindow: vi.fn(() => {
        bot.currentWindow = null;
      }),
    };

    const result = await closeWindow.run({}, makeContext(bot));

    expect(bot.closeWindow).toHaveBeenCalledWith(window);
    expect(result).toMatchObject({
      ok: true,
      data: { closed: true, confirmed: true, window: { title: "Chest", slotCount: 1 } },
    });
  });

  it("reports a requested close when a test/adapter does not synchronously clear currentWindow", async () => {
    const window = makeWindow();
    const close = vi.fn();

    const result = await closeWindow.run({}, makeContext({ currentWindow: window, closeWindow: close }));

    expect(result).toMatchObject({ ok: true, data: { closed: true, confirmed: false } });
  });

  it("maps close errors to a technical failure", async () => {
    const result = await closeWindow.run({}, makeContext({
      currentWindow: makeWindow(),
      closeWindow: vi.fn(() => { throw new Error("window rejected close"); }),
    }));

    expect(result).toMatchObject({
      ok: false,
      code: "SERVER_REJECTED",
      recoverable: true,
      details: { message: "window rejected close" },
    });
  });

  it("does not close after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const close = vi.fn();
    const result = await closeWindow.run(
      {},
      makeContext({ currentWindow: makeWindow(), closeWindow: close }, controller),
    );

    expect(close).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED", recoverable: true });
  });
});
