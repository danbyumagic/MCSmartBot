import { describe, it, expect, vi } from "vitest";
import { createFindBlockTool } from "../../src/agent/findBlockTool.js";

function makeBot(opts: {
  selfPos?: { x: number; y: number; z: number };
  registry?: Record<string, { id: number }>;
  findResults?: Array<{ x: number; y: number; z: number }>;
}) {
  const pos = opts.selfPos ?? { x: 0, y: 64, z: 0 };
  const findBlocks = vi.fn().mockReturnValue(opts.findResults ?? []);
  return {
    bot: {
      entity: { position: pos },
      registry: opts.registry ? { blocksByName: opts.registry } : undefined,
      findBlocks,
    } as unknown as Parameters<typeof createFindBlockTool>[0],
    findBlocks,
  };
}

describe("createFindBlockTool", () => {
  it("returns ok:false when block name is unknown", async () => {
    const { bot } = makeBot({ registry: { iron_ore: { id: 73 } } });
    const tool = createFindBlockTool(bot);
    const result = await tool.handler({ name: "unobtanium", radius: 32, maxResults: 3, detail: false });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/unknown block/);
  });

  it("returns ok:true with 'no X within Nb' when search finds nothing", async () => {
    const { bot } = makeBot({ registry: { iron_ore: { id: 73 } }, findResults: [] });
    const tool = createFindBlockTool(bot);
    const result = await tool.handler({ name: "iron_ore", radius: 32, maxResults: 3, detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/no iron_ore within 32/);
  });

  it("summary (detail:false): single nearest match as one-liner", async () => {
    const { bot } = makeBot({
      selfPos: { x: 0, y: 64, z: 0 },
      registry: { iron_ore: { id: 73 } },
      findResults: [
        { x: 10, y: 50, z: 0 },  // ~14b
        { x: 0, y: 64, z: 5 },   // ~5b
      ],
    });
    const tool = createFindBlockTool(bot);
    const result = await tool.handler({ name: "iron_ore", radius: 64, maxResults: 5, detail: false });
    expect(result.ok).toBe(true);
    // Should contain the first (nearest) result only
    expect(result.summary).toMatch(/nearest iron_ore at 10 50 0/);
    expect(result.summary).toMatch(/away/);
    // Should NOT be a multi-line list
    expect(result.summary).not.toMatch(/\n/);
    // Should NOT include the second result
    expect(result.summary).not.toMatch(/0 64 5/);
  });

  it("detail:true: top N results as a list with coordinates and distance", async () => {
    const { bot, findBlocks } = makeBot({
      selfPos: { x: 0, y: 64, z: 0 },
      registry: { iron_ore: { id: 73 } },
      findResults: [
        { x: 10, y: 50, z: 0 },  // ~14b away
        { x: 0, y: 64, z: 5 },   // ~5b away
      ],
    });
    const tool = createFindBlockTool(bot);
    const result = await tool.handler({ name: "iron_ore", radius: 64, maxResults: 5, detail: true });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/iron_ore at 10 50 0/);
    expect(result.summary).toMatch(/iron_ore at 0 64 5/);
    expect(findBlocks).toHaveBeenCalledWith({ matching: [73], maxDistance: 64, count: 5 });
  });

  it("returns ok:false when not yet spawned (registry missing)", async () => {
    const { bot } = makeBot({});
    const tool = createFindBlockTool(bot);
    const result = await tool.handler({ name: "stone", radius: 32, maxResults: 3, detail: false });
    expect(result.ok).toBe(false);
  });
});
