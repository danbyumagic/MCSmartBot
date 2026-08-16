import { describe, it, expect, vi } from "vitest";
import { createTargetFlightDetector, followPlayer } from "../../../src/skills/navigation/followPlayer.js";
import { Vec3 } from "vec3";
import type { SkillContext } from "../../../src/skills/types.js";

function makeBot(players: Record<string, { entity?: unknown }>) {
  return { players, username: "SmartBot" } as unknown as SkillContext["bot"];
}

function makeCtx(bot: SkillContext["bot"]): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return { bot, signal: new AbortController().signal, log, reportProgress: vi.fn() };
}

describe("followPlayer (param + lookup)", () => {
  it("rejects empty usernames via schema", () => {
    expect(() => followPlayer.params.parse({ username: "" })).toThrow();
  });

  it("accepts a valid username and default range", () => {
    expect(followPlayer.params.parse({ username: "alice" })).toEqual({ username: "alice", range: 2 });
  });

  it("fails fast when the player is not online", async () => {
    const ctx = makeCtx(makeBot({}));
    const result = await followPlayer.run({ username: "alice", range: 2 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/not online/i);
  });

  it("fails fast when the player has no entity (out of render range)", async () => {
    const ctx = makeCtx(makeBot({ alice: {} }));
    const result = await followPlayer.run({ username: "alice", range: 2 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/render range/i);
  });

  it("resolves player usernames case-insensitively", async () => {
    const ctx = makeCtx(makeBot({ xxdj: {} }));
    const result = await followPlayer.run({ username: "XXDJ", range: 2 }, ctx);
    expect(result).toMatchObject({
      ok: false,
      details: {
        requestedUsername: "XXDJ",
        resolvedUsername: "xxdj",
        reason: "outside_render_range",
      },
    });
  });

  it("stays in walking mode for jumps and water but detects sustained hovering", () => {
    vi.useFakeTimers();
    const bot = {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt: vi.fn(() => ({ name: "air" })),
    } as unknown as SkillContext["bot"];
    const detector = createTargetFlightDetector(bot);
    const target = {
      position: new Vec3(0, 66, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: false,
      elytraFlying: false,
    } as any;
    expect(detector(target)).toBe(false);
    vi.advanceTimersByTime(700);
    expect(detector(target)).toBe(true);
    vi.mocked(bot.blockAt).mockReturnValue({ name: "stone" } as any);
    expect(detector(target)).toBe(false);
    vi.mocked(bot.blockAt).mockReturnValue({ name: "water" } as any);
    vi.advanceTimersByTime(700);
    expect(detector(target)).toBe(false);
    vi.useRealTimers();
  });
});
