import { describe, it, expect } from "vitest";
import { createInspectTool } from "../../src/agent/inspectTool.js";

function makeBot(partial: Record<string, unknown>) {
  return partial as unknown as Parameters<typeof createInspectTool>[0];
}

describe("createInspectTool", () => {
  // ── self ──────────────────────────────────────────────────────────────────

  it("self summary: terse one-liner with hp/food/pos/dim", async () => {
    const bot = makeBot({
      entity: { position: { x: 100.4, y: 64, z: -50.7 } },
      health: 18,
      food: 17,
      game: { dimension: "minecraft:overworld" },
      time: { timeOfDay: 6000 },
      isRaining: false,
      players: {},
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "self", detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/hp 18\/20/);
    expect(result.summary).toMatch(/food 17\/20/);
    expect(result.summary).toMatch(/100/);
    expect(result.summary).toMatch(/overworld/);
    // should NOT contain time or weather in terse mode
    expect(result.summary).not.toMatch(/time/);
    expect(result.summary).not.toMatch(/rain/);
  });

  it("self detail: full version with time-of-day and weather", async () => {
    const bot = makeBot({
      entity: { position: { x: 100.4, y: 64, z: -50.7 } },
      health: 18,
      food: 17,
      game: { dimension: "minecraft:overworld" },
      time: { timeOfDay: 6000 },
      isRaining: false,
      thunderState: 0,
      players: {},
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "self", detail: true });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/100/);
    expect(result.summary).toMatch(/64/);
    expect(result.summary).toMatch(/-51/);
    expect(result.summary).toMatch(/hp/i);
    expect(result.summary).toMatch(/overworld/i);
    expect(result.summary).toMatch(/time/i);
    expect(result.summary).toMatch(/day/i);
  });

  // ── owner ─────────────────────────────────────────────────────────────────

  it("owner summary: terse format 'alice Nb away at X Y Z'", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      players: {
        alice: { entity: { position: { x: 200, y: 70, z: 300 } } },
      },
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "owner", detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/alice/i);
    expect(result.summary).toMatch(/\d+b away/i);
    expect(result.summary).toMatch(/200/);
    expect(result.summary).toMatch(/300/);
    expect(result.summary).not.toMatch(/blocks away/);
  });

  it("owner detail: verbose format 'alice at X Y Z (N blocks away)'", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      players: {
        alice: { entity: { position: { x: 200, y: 70, z: 300 } } },
      },
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "owner", detail: true });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/alice/i);
    expect(result.summary).toMatch(/200/);
    expect(result.summary).toMatch(/300/);
    expect(result.summary).toMatch(/blocks away/i);
  });

  it("returns ok:false when asking for the owner and they aren't online", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      players: {},
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "owner", detail: false });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/not online|no entity/i);
  });

  // ── nearby ────────────────────────────────────────────────────────────────

  it("nearby summary: count only ('N players in range')", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      players: {
        alice: { entity: { position: { x: 10, y: 64, z: 0 } } },
        bob: { entity: { position: { x: 0, y: 64, z: 30 } } },
      },
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "nearby", detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/2 players in range/);
    expect(result.summary).not.toMatch(/alice/);
    expect(result.summary).not.toMatch(/bob/);
  });

  it("nearby detail: lists players with distances", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      players: {
        alice: { entity: { position: { x: 10, y: 64, z: 0 } } },
        bob: { entity: { position: { x: 0, y: 64, z: 30 } } },
      },
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "nearby", detail: true });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/alice/);
    expect(result.summary).toMatch(/bob/);
  });

  it("nearby singular: '1 player in range' when exactly one nearby", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      players: {
        alice: { entity: { position: { x: 10, y: 64, z: 0 } } },
      },
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "nearby", detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/1 player in range/);
  });

  // ── server ────────────────────────────────────────────────────────────────

  it("server summary: 'brand, gamemode, difficulty'", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      game: {
        serverBrand: "Paper",
        gameMode: "survival",
        difficulty: "normal",
        levelType: "default",
        viewDistance: 10,
      },
      time: { timeOfDay: 6000 },
      isRaining: false,
      players: {},
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "server", detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/Paper/);
    expect(result.summary).toMatch(/survival/);
    expect(result.summary).toMatch(/normal/);
    // detail=false should not include time, view distance, level type
    expect(result.summary).not.toMatch(/view distance/);
    expect(result.summary).not.toMatch(/level type/);
    expect(result.summary).not.toMatch(/time/);
  });

  it("server detail: full breakdown including level type, view distance, time, weather", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      game: {
        serverBrand: "Paper",
        gameMode: "survival",
        difficulty: "normal",
        levelType: "default",
        viewDistance: 10,
      },
      time: { timeOfDay: 6000 },
      isRaining: false,
      players: {},
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "server", detail: true });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/Paper/);
    expect(result.summary).toMatch(/survival/);
    expect(result.summary).toMatch(/normal/);
    expect(result.summary).toMatch(/day/);
    expect(result.summary).toMatch(/clear/);
  });

  // ── players ───────────────────────────────────────────────────────────────

  it("players summary: 'N online: name1, name2, ...'", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      players: {
        alice: { ping: 42, gamemode: "survival", entity: { position: { x: 10, y: 64, z: 0 } } },
        bob: { ping: 120, gamemode: "creative", entity: null },
        charlie: { ping: 8 },
      },
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "players", detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/3 online/);
    expect(result.summary).toMatch(/alice/);
    expect(result.summary).toMatch(/bob/);
    expect(result.summary).toMatch(/charlie/);
    // terse: no ping or gamemode
    expect(result.summary).not.toMatch(/42ms/);
    expect(result.summary).not.toMatch(/gamemode/);
  });

  it("players detail: full list with ping, gamemode, distance", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      players: {
        alice: { ping: 42, gamemode: "survival", entity: { position: { x: 10, y: 64, z: 0 } } },
        bob: { ping: 120, gamemode: "creative", entity: null },
        charlie: { ping: 8 },
      },
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "players", detail: true });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/alice/);
    expect(result.summary).toMatch(/bob/);
    expect(result.summary).toMatch(/charlie/);
    expect(result.summary).toMatch(/42ms/);
    expect(result.summary).toMatch(/120ms/);
  });

  it("returns 'no players connected' when only the bot itself is in the list", async () => {
    const bot = makeBot({
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 20,
      food: 20,
      players: {},
      username: "SmartBot",
    });
    const tool = createInspectTool(bot, "alice");
    const result = await tool.handler({ what: "players", detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/no players/);
  });
});
