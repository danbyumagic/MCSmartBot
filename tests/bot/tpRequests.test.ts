import { describe, it, expect } from "vitest";
import { parseTpRequester } from "../../src/bot/tpRequests.js";

describe("parseTpRequester", () => {
  it("matches vanilla/essentials 'has requested to teleport to you'", () => {
    expect(parseTpRequester("xxdj has requested to teleport to you.")).toBe("xxdj");
  });

  it("matches 'has requested that you teleport to them'", () => {
    expect(parseTpRequester("xxdj has requested that you teleport to them.")).toBe("xxdj");
  });

  it("matches '[TPA] X wants to teleport to you'", () => {
    expect(parseTpRequester("[TPA] xxdj wants to teleport to you.")).toBe("xxdj");
  });

  it("matches 'is requesting to teleport'", () => {
    expect(parseTpRequester("xxdj is requesting to teleport to your location.")).toBe("xxdj");
  });

  it("returns null for unrelated messages", () => {
    expect(parseTpRequester("xxdj joined the game")).toBeNull();
    expect(parseTpRequester("Server tip: do /tpaccept")).toBeNull();
  });

  it("rejects too-short and too-long usernames in the captured position", () => {
    expect(parseTpRequester("me has requested to teleport to you")).toBeNull();
    expect(parseTpRequester("AAAAAAAAAAAAAAAAA has requested to teleport to you")).toBeNull();
  });
});
