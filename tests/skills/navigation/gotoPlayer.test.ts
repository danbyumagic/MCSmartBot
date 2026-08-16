import { describe, it, expect, vi } from "vitest";
import { gotoPlayer } from "../../../src/skills/navigation/gotoPlayer.js";
import type { SkillContext } from "../../../src/skills/types.js";

function makeBot(players: Record<string, { entity?: { position: { x: number; y: number; z: number } } }>) {
  return { players, username: "SmartBot" } as unknown as SkillContext["bot"];
}

function makeCtx(bot: SkillContext["bot"]): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return { bot, signal: new AbortController().signal, log, reportProgress: vi.fn() };
}

describe("gotoPlayer (param + lookup behavior)", () => {
  it("rejects empty usernames", () => {
    expect(() => gotoPlayer.params.parse({ username: "" })).toThrow();
  });

  it("accepts a valid username and default range", () => {
    expect(gotoPlayer.params.parse({ username: "alice" })).toEqual({ username: "alice", range: 2 });
  });

  it("returns a failed result when the player is not online", async () => {
    const bot = makeBot({});
    const ctx = makeCtx(bot);
    const result = await gotoPlayer.run({ username: "alice", range: 2 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/alice/i);
    expect(result.summary).toMatch(/not.*online|cannot.*find/i);
  });

  it("returns a failed result when the player has no entity (not in render range)", async () => {
    const bot = makeBot({ alice: {} });
    const ctx = makeCtx(bot);
    const result = await gotoPlayer.run({ username: "alice", range: 2 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/render range|not visible|no entity/i);
  });

  it("resolves player usernames case-insensitively", async () => {
    const bot = makeBot({ xxdj: {} });
    const ctx = makeCtx(bot);
    const result = await gotoPlayer.run({ username: "XXDJ", range: 2 }, ctx);
    expect(result).toMatchObject({
      ok: false,
      details: {
        requestedUsername: "XXDJ",
        resolvedUsername: "xxdj",
        reason: "outside_render_range",
      },
    });
  });
});
