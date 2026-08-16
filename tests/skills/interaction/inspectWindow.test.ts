import { describe, expect, it, vi } from "vitest";
import { inspectWindow } from "../../../src/skills/interaction/inspectWindow.js";
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

describe("inspectWindow", () => {
  it("is an operator read-only action", () => {
    expect(inspectWindow.policy).toEqual({
      minimumRole: "operator",
      effect: "read",
      reversible: false,
      mission: "public",
    });
  });

  it("returns at most 128 sanitized slot summaries and a sanitized cursor", async () => {
    const slots = Array.from({ length: 130 }, (_value, index) => index === 0
      ? {
        name: "diamond_sword",
        count: 1,
        type: 276,
        metadata: 0,
        nbt: { secret: "must not leak" },
        displayName: "Very private item name",
      }
      : null);
    const bot = {
      currentWindow: {
        type: "minecraft:generic_9x6",
        title: "Storage",
        slots,
        selectedItem: { name: "cobblestone", count: 12, type: 4, metadata: 0, nbt: { raw: true } },
      },
    };

    const result = await inspectWindow.run({}, makeContext(bot));

    expect(result).toMatchObject({
      ok: true,
      data: {
        window: {
          type: "minecraft:generic_9x6",
          title: "Storage",
          slotCount: 130,
          truncated: true,
          cursor: { name: "cobblestone", count: 12, type: 4, metadata: 0 },
        },
      },
    });
    const window = result.data?.window as { slots: Array<Record<string, unknown>> };
    expect(window.slots).toHaveLength(128);
    expect(window.slots[0]).toEqual({
      slot: 0,
      item: { name: "diamond_sword", count: 1, type: 276, metadata: 0 },
    });
    expect(JSON.stringify(result.data)).not.toContain("must not leak");
    expect(JSON.stringify(result.data)).not.toContain("displayName");
  });

  it("returns a recoverable result when no live window is open", async () => {
    const result = await inspectWindow.run({}, makeContext({ currentWindow: null }));

    expect(result).toMatchObject({
      ok: false,
      code: "TARGET_UNAVAILABLE",
      recoverable: true,
    });
  });

  it("does not inspect after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await inspectWindow.run({}, makeContext({ currentWindow: {} }, controller));

    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED", recoverable: true });
  });
});
