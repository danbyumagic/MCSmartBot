import { describe, expect, it } from "vitest";
import {
  normalizeMinecraftUsername,
  resolveOnlinePlayer,
  sameMinecraftUsername,
} from "../../src/bot/playerIdentity.js";

describe("player identity", () => {
  it("normalizes whitespace and casing", () => {
    expect(normalizeMinecraftUsername("  XXDJ ")).toBe("xxdj");
    expect(sameMinecraftUsername("XXDJ", "xxdj")).toBe(true);
    expect(sameMinecraftUsername("", "")).toBe(false);
  });

  it("resolves Mineflayer player keys case-insensitively", () => {
    const player = { username: "xxdj", entity: { id: 1 } };
    const bot = { players: { xxdj: player } } as any;

    const resolved = resolveOnlinePlayer(bot, "XXDJ");

    expect(resolved).toMatchObject({
      requestedUsername: "XXDJ",
      username: "xxdj",
      player,
    });
  });

  it("prefers an exact key when available", () => {
    const exact = { username: "Alice" };
    const bot = {
      players: {
        Alice: exact,
        alice: { username: "alice" },
      },
    } as any;
    expect(resolveOnlinePlayer(bot, "Alice")?.player).toBe(exact);
  });
});
