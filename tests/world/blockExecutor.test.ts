import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";

const { pathfindTo } = vi.hoisted(() => ({ pathfindTo: vi.fn() }));

vi.mock("../../src/skills/pathfinder.js", () => ({
  goals: {
    GoalNear: class GoalNear {
      constructor(
        public readonly x: number,
        public readonly y: number,
        public readonly z: number,
        public readonly range: number,
      ) {}
    },
  },
  pathfindTo,
}));

import {
  digAt,
  placeAt,
  type BlockMutationHooks,
} from "../../src/world/blockExecutor.js";

function positionKey(position: Vec3): string {
  return `${position.x},${position.y},${position.z}`;
}

function mutableWorld(initial: Record<string, string>) {
  const world = new Map(Object.entries(initial));
  let held = "";
  const blockAt = vi.fn((position: Vec3) => {
    const name = world.get(positionKey(position)) ?? "air";
    return {
      name,
      position: position.floored(),
      stateId: name === "air" ? 0 : 1,
      boundingBox: name === "air" ? "empty" : "block",
      diggable: name !== "bedrock",
      getProperties: () => ({ waterlogged: false }),
    };
  });
  const bot = {
    entity: { position: new Vec3(0, 64, -2) },
    registry: { itemsByName: { stone: { id: 1 }, dirt: { id: 2 } } },
    inventory: {
      items: () => [
        { name: "stone", type: 1, count: 3 },
        { name: "dirt", type: 2, count: 3 },
      ],
    },
    blockAt,
    canDigBlock: vi.fn((block: { name: string }) => block.name !== "bedrock"),
    canSeeBlock: vi.fn(() => true),
    equip: vi.fn(async (item: { name: string }) => { held = item.name; }),
    placeBlock: vi.fn(async (reference: { position: Vec3 }, face: Vec3) => {
      world.set(positionKey(reference.position.plus(face)), held);
    }),
    dig: vi.fn(async (block: { position: Vec3 }) => {
      world.delete(positionKey(block.position));
    }),
  };
  return { bot, world, blockAt };
}

describe("verified block executor", () => {
  it("places only after target precondition and verifies the actual result", async () => {
    const { bot, world } = mutableWorld({ "0,63,0": "stone" });
    const planned = vi.fn();
    const applied = vi.fn();
    const result = await placeAt(bot as any, {
      position: { x: 0.9, y: 64.2, z: 0.1 },
      item: "stone",
      signal: new AbortController().signal,
      expected: (snapshot) => snapshot.replaceable,
      hooks: { planned, applied },
    });

    expect(result).toMatchObject({
      ok: true,
      before: { name: "air", position: { x: 0, y: 64, z: 0 } },
      after: { name: "stone" },
      reference: { direction: "up" },
    });
    expect(world.get("0,64,0")).toBe("stone");
    expect(planned).toHaveBeenCalledOnce();
    expect(applied).toHaveBeenCalledOnce();
  });

  it("records intended observable properties and requires an additional post-placement predicate", async () => {
    const { bot } = mutableWorld({ "0,63,0": "stone" });
    const planned = vi.fn();
    const applied = vi.fn();

    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      intendedProperties: { waterlogged: false },
      expectedAfter: (after) => after.properties.waterlogged === false,
      hooks: { planned, applied },
    });

    expect(result).toMatchObject({ ok: true, after: { name: "stone" } });
    expect(planned).toHaveBeenCalledWith(expect.objectContaining({
      intended: { name: "stone", properties: { waterlogged: false } },
    }));
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      intended: expect.objectContaining({ properties: { waterlogged: false } }),
    }));
  });

  it("does not mutate when the live target changes after a caller snapshot", async () => {
    const { bot } = mutableWorld({ "0,63,0": "stone", "0,64,0": "dirt" });
    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      expected: { name: "air", position: { x: 0, y: 64, z: 0 } },
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });

  it("rereads after equip and rejects a target changed during an await", async () => {
    const { bot, world } = mutableWorld({ "0,63,0": "stone" });
    bot.equip.mockImplementation(async () => {
      world.set("0,64,0", "dirt");
    });
    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });

  it("digs a verified diggable block and invokes journal hooks in order", async () => {
    const { bot, world } = mutableWorld({ "1,64,0": "stone" });
    const events: string[] = [];
    const hooks: BlockMutationHooks = {
      planned: () => { events.push("planned"); },
      applied: () => { events.push("applied"); },
      failed: () => { events.push("failed"); },
    };
    const result = await digAt(bot as any, {
      position: { x: 1, y: 64, z: 0 },
      signal: new AbortController().signal,
      expected: (snapshot) => snapshot.name === "stone",
      hooks,
    });

    expect(result).toMatchObject({ ok: true, before: { name: "stone" }, after: { name: "air" } });
    expect(world.get("1,64,0")).toBeUndefined();
    expect(events).toEqual(["planned", "applied"]);
  });

  it("navigates before evaluating Mineflayer's dig reach check", async () => {
    const { bot, world } = mutableWorld({ "8,64,0": "stone" });
    let routed = false;
    pathfindTo.mockReset().mockImplementation(async () => { routed = true; });
    bot.canDigBlock.mockImplementation((block: { name: string }) => routed && block.name !== "bedrock");

    const result = await digAt(bot as any, {
      position: { x: 8, y: 64, z: 0 },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ ok: true, after: { name: "air" } });
    expect(pathfindTo).toHaveBeenCalledOnce();
    expect(pathfindTo.mock.calls[0]?.[1]).toMatchObject({ x: 8, y: 64, z: 0 });
    expect(bot.dig).toHaveBeenCalledWith(expect.objectContaining({ name: "stone" }), true);
    expect(world.get("8,64,0")).toBeUndefined();
  });

  it("stops Mineflayer digging when cancellation occurs during the active dig", async () => {
    const { bot } = mutableWorld({ "1,64,0": "stone" });
    const controller = new AbortController();
    const events: string[] = [];
    let rejectDig!: (reason: Error) => void;
    bot.stopDigging = vi.fn();
    bot.dig.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectDig = reject;
    }));

    const pending = digAt(bot as any, {
      position: { x: 1, y: 64, z: 0 },
      signal: controller.signal,
      hooks: {
        planned: () => { events.push("planned"); },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });
    await vi.waitFor(() => expect(bot.dig).toHaveBeenCalledOnce());
    controller.abort();
    expect(bot.stopDigging).toHaveBeenCalledOnce();
    rejectDig(new Error("aborted"));

    await expect(pending).resolves.toMatchObject({ ok: false, code: "INTERRUPTED" });
    expect(events).toEqual(["planned", "failed:INTERRUPTED"]);
  });

  it("marks a planned dig applied when cancellation races with a verified removal", async () => {
    const { bot, world } = mutableWorld({ "1,64,0": "stone" });
    const controller = new AbortController();
    const events: string[] = [];
    bot.stopDigging = vi.fn();
    bot.dig.mockImplementation(async (block: { position: Vec3 }) => {
      world.delete(positionKey(block.position));
      controller.abort();
      throw new Error("aborted");
    });

    const result = await digAt(bot as any, {
      position: { x: 1, y: 64, z: 0 },
      signal: controller.signal,
      hooks: {
        planned: () => { events.push("planned"); },
        applied: () => { events.push("applied"); },
        failed: () => { events.push("failed"); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED", after: { name: "air" } });
    expect(bot.stopDigging).toHaveBeenCalledOnce();
    expect(events).toEqual(["planned", "applied"]);
  });

  it("leaves a planned dig unreconciled when the world cannot be reread after an error", async () => {
    const { bot } = mutableWorld({ "1,64,0": "stone" });
    const originalBlockAt = bot.blockAt.getMockImplementation()!;
    let unavailable = false;
    const events: string[] = [];
    bot.blockAt.mockImplementation((position: Vec3) => unavailable ? null : originalBlockAt(position));
    bot.dig.mockImplementation(async () => {
      unavailable = true;
      throw new Error("connection lost");
    });

    const result = await digAt(bot as any, {
      position: { x: 1, y: 64, z: 0 },
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        failed: () => { events.push("failed"); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(events).toEqual(["planned"]);
  });

  it("marks a planned placement no-op as failed instead of fabricating a conflict", async () => {
    const { bot } = mutableWorld({ "0,63,0": "stone" });
    const events: string[] = [];
    bot.placeBlock.mockImplementation(async () => {});

    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        applied: () => { events.push("applied"); },
        conflicted: (event) => { events.push(`conflict:${event.code}:${event.after.name}`); },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    expect(events).toEqual(["planned", "failed:STALE_STATE"]);
  });

  it("records a changed-but-wrong placement as a conflict with its observed state", async () => {
    const { bot, world } = mutableWorld({ "0,63,0": "stone" });
    const events: string[] = [];
    bot.placeBlock.mockImplementation(async (reference: { position: Vec3 }, face: Vec3) => {
      world.set(positionKey(reference.position.plus(face)), "dirt");
    });

    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        applied: () => { events.push("applied"); },
        conflicted: (event) => { events.push(`conflict:${event.code}:${event.after.name}`); },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    expect(events).toEqual(["planned", "conflict:STALE_STATE:dirt"]);
  });

  it("marks a planned placement failed when Mineflayer throws before changing the world", async () => {
    const { bot } = mutableWorld({ "0,63,0": "stone" });
    const events: string[] = [];
    bot.placeBlock.mockImplementation(async () => { throw new Error("click rejected"); });

    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        conflicted: (event) => { events.push(`conflict:${event.after.name}`); },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(events).toEqual(["planned", "failed:UNKNOWN"]);
  });

  it("terminalizes a planned placement when last-moment authorization rejects before the click", async () => {
    const { bot } = mutableWorld({ "0,63,0": "stone" });
    const events: string[] = [];
    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        beforeMutation: () => {
          events.push("authorize");
          return {
            ok: false as const,
            code: "PERMISSION_DENIED" as const,
            summary: "build authority was revoked",
            recoverable: false,
          };
        },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED", recoverable: false });
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(events).toEqual(["planned", "authorize", "failed:PERMISSION_DENIED"]);
  });

  it("rechecks the placement target after async authorization before clicking", async () => {
    const { bot, world } = mutableWorld({ "0,63,0": "stone" });
    const events: string[] = [];
    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        beforeMutation: async () => {
          events.push("authorize");
          world.set("0,64,0", "dirt");
        },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    expect(world.get("0,64,0")).toBe("dirt");
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(events).toEqual(["planned", "authorize", "failed:STALE_STATE"]);
  });

  it("rechecks the placement reference after async authorization before clicking", async () => {
    const { bot, world } = mutableWorld({ "0,63,0": "stone" });
    const events: string[] = [];
    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        beforeMutation: async () => {
          events.push("authorize");
          world.delete("0,63,0");
        },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    expect(world.get("0,64,0")).toBeUndefined();
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(events).toEqual(["planned", "authorize", "failed:STALE_STATE"]);
  });

  it("checks cancellation after last-moment authorization before placing", async () => {
    const { bot } = mutableWorld({ "0,63,0": "stone" });
    const controller = new AbortController();
    const events: string[] = [];
    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: controller.signal,
      hooks: {
        planned: () => { events.push("planned"); },
        beforeMutation: () => { controller.abort(); },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED" });
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(events).toEqual(["planned", "failed:INTERRUPTED"]);
  });

  it("returns a structured pre-mutation journal rejection without changing the world", async () => {
    const { bot } = mutableWorld({ "0,63,0": "stone" });
    const failed = vi.fn();
    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      hooks: {
        planned: () => ({
          ok: false as const,
          code: "BUDGET_EXCEEDED" as const,
          summary: "world change budget 1 is exhausted",
          recoverable: false,
          details: { limit: 1 },
        }),
        failed,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "BUDGET_EXCEEDED",
      details: { limit: 1 },
    });
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("does not mark a verified mutation retryable when only its journal confirmation fails", async () => {
    const { bot, world } = mutableWorld({ "0,63,0": "stone" });
    const failed = vi.fn();
    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      hooks: {
        planned: () => undefined,
        applied: () => { throw new Error("database unavailable"); },
        failed,
      },
    });

    expect(result).toMatchObject({ ok: false, code: "UNKNOWN", recoverable: false });
    expect(world.get("0,64,0")).toBe("stone");
    expect(failed).not.toHaveBeenCalled();
  });

  it("marks a planned placement applied when the block is present despite a Mineflayer error", async () => {
    const { bot, world } = mutableWorld({ "0,63,0": "stone" });
    const events: string[] = [];
    bot.placeBlock.mockImplementation(async (reference: { position: Vec3 }, face: Vec3) => {
      world.set(positionKey(reference.position.plus(face)), "stone");
      throw new Error("connection reset");
    });

    const result = await placeAt(bot as any, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        applied: () => { events.push("applied"); },
        failed: () => { events.push("failed"); },
      },
    });

    expect(result).toMatchObject({ ok: true, after: { name: "stone" } });
    expect(events).toEqual(["planned", "applied"]);
  });

  it("terminalizes a planned dig when last-moment authorization rejects before the click", async () => {
    const { bot } = mutableWorld({ "1,64,0": "stone" });
    const events: string[] = [];
    const result = await digAt(bot as any, {
      position: { x: 1, y: 64, z: 0 },
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        beforeMutation: () => {
          events.push("authorize");
          return {
            ok: false as const,
            code: "PERMISSION_DENIED" as const,
            summary: "build authority was revoked",
            recoverable: false,
          };
        },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED", recoverable: false });
    expect(bot.dig).not.toHaveBeenCalled();
    expect(events).toEqual(["planned", "authorize", "failed:PERMISSION_DENIED"]);
  });

  it("rechecks the dig target/block after async authorization before clicking", async () => {
    const { bot, world } = mutableWorld({ "1,64,0": "stone" });
    const events: string[] = [];
    const result = await digAt(bot as any, {
      position: { x: 1, y: 64, z: 0 },
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        beforeMutation: async () => {
          events.push("authorize");
          world.set("1,64,0", "dirt");
        },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    expect(world.get("1,64,0")).toBe("dirt");
    expect(bot.dig).not.toHaveBeenCalled();
    expect(events).toEqual(["planned", "authorize", "failed:STALE_STATE"]);
  });

  it("rechecks dig reachability after async authorization before clicking", async () => {
    const { bot } = mutableWorld({ "1,64,0": "stone" });
    let canDig = true;
    bot.canDigBlock.mockImplementation(() => canDig);
    const events: string[] = [];
    const result = await digAt(bot as any, {
      position: { x: 1, y: 64, z: 0 },
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        beforeMutation: async () => {
          events.push("authorize");
          canDig = false;
        },
        failed: (event) => { events.push(`failed:${event.code}`); },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    expect(bot.dig).not.toHaveBeenCalled();
    expect(events).toEqual(["planned", "authorize", "failed:STALE_STATE"]);
  });

  it("treats any observed state change after a failed dig call as applied", async () => {
    const { bot, world } = mutableWorld({ "1,64,0": "stone" });
    const events: string[] = [];
    bot.dig.mockImplementation(async (block: { position: Vec3 }) => {
      world.set(positionKey(block.position), "dirt");
      throw new Error("connection reset");
    });

    const result = await digAt(bot as any, {
      position: { x: 1, y: 64, z: 0 },
      signal: new AbortController().signal,
      hooks: {
        planned: () => { events.push("planned"); },
        applied: () => { events.push("applied"); },
        failed: () => { events.push("failed"); },
      },
    });

    expect(result).toMatchObject({ ok: true, after: { name: "dirt" } });
    expect(events).toEqual(["planned", "applied"]);
  });

  it("rejects bedrock without calling dig", async () => {
    const { bot } = mutableWorld({ "1,64,0": "bedrock" });
    const result = await digAt(bot as any, {
      position: { x: 1, y: 64, z: 0 },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });
    expect(bot.dig).not.toHaveBeenCalled();
  });
});
