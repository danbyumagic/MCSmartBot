import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";

const { pathfindTo } = vi.hoisted(() => ({ pathfindTo: vi.fn() }));

vi.mock("../../../src/skills/pathfinder.js", () => ({
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

import { openDatabase, type DB } from "../../../src/memory/db.js";
import { snapshotSkillExecutionContext } from "../../../src/permissions/executionActor.js";
import { createPlaceBlockSkill } from "../../../src/skills/world/placeBlock.js";
import { createDigBlockSkill } from "../../../src/skills/world/digBlock.js";
import { createClearRegionSkill } from "../../../src/skills/world/clearRegion.js";
import type { SkillContext } from "../../../src/skills/types.js";
import { getTransaction } from "../../../src/world/transactions/store.js";
import { createWorldTransactionService } from "../../../src/world/transactions/service.js";

type BlockState = {
  name: string;
  diggable?: boolean;
  blockEntity?: boolean;
};

let temporaryDirectory: string;
let db: DB;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "smartbotmc-world-skills-"));
  db = openDatabase(join(temporaryDirectory, "memory.sqlite"));
  pathfindTo.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  db.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function key(position: { x: number; y: number; z: number }): string {
  return `${position.x},${position.y},${position.z}`;
}

function createWorld(initial: Record<string, BlockState | null>) {
  const world = new Map(Object.entries(initial));
  let held = "";
  const bot: Record<string, any> = {
    game: { dimension: "overworld" },
    entity: { position: new Vec3(-3, 64, -2) },
    registry: { itemsByName: { stone: { id: 1 }, dirt: { id: 2 }, chest: { id: 3 } } },
    inventory: { items: () => [{ name: "stone", type: 1, count: 16 }, { name: "dirt", type: 2, count: 16 }] },
    entities: {},
    canSeeBlock: vi.fn(() => true),
    canDigBlock: vi.fn(() => true),
    pathfinder: { bestHarvestTool: vi.fn(() => null) },
  };
  bot.blockAt = vi.fn((position: Vec3) => {
    const at = position.floored();
    const state = world.get(key(at));
    if (state === null) return null;
    const name = state?.name ?? "air";
    return {
      name,
      position: at,
      stateId: name === "air" ? 0 : name === "stone" ? 1 : 2,
      boundingBox: name === "air" ? "empty" : "block",
      diggable: state?.diggable !== false,
      blockEntity: state?.blockEntity ? { id: "minecraft:chest" } : undefined,
      getProperties: () => ({}),
    };
  });
  bot.equip = vi.fn(async (item: { name: string }) => { held = item.name; });
  bot.placeBlock = vi.fn(async (reference: { position: Vec3 }, face: Vec3) => {
    world.set(key(reference.position.plus(face)), { name: held });
  });
  bot.dig = vi.fn(async (block: { position: Vec3 }) => {
    world.delete(key(block.position));
  });
  return { bot, world };
}

function dependencies() {
  return {
    transactions: createWorldTransactionService({ db }),
    serverKey: "test.example:25565",
  };
}

function context(bot: unknown, controller = new AbortController(), maxWorldChanges?: number): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: bot as SkillContext["bot"],
    signal: controller.signal,
    log,
    reportProgress: vi.fn(),
    execution: snapshotSkillExecutionContext({
      actor: { username: "Alice", role: "owner", source: "minecraft-chat" },
      ...(maxWorldChanges === undefined ? {} : { maxWorldChanges }),
    }),
  };
}

describe("journaled direct world skills", () => {
  it("places a carried item through the verified executor and records actor/server context", async () => {
    const { bot, world } = createWorld({ "0,63,0": { name: "stone" } });
    const skill = createPlaceBlockSkill(dependencies());

    const result = await skill.run(skill.params.parse({ block: "stone", x: 0, y: 64, z: 0 }), context(bot));

    expect(result).toMatchObject({ ok: true, data: { after: { name: "stone" } } });
    expect(world.get("0,64,0")).toEqual({ name: "stone" });
    const transactionId = (result.details?.transaction as { id: number }).id;
    expect(getTransaction(db, transactionId)).toMatchObject({
      serverKey: "test.example:25565",
      dimension: "overworld",
      actor: { username: "Alice", role: "owner", source: "minecraft-chat" },
      status: "completed",
      changes: [{ action: "place", status: "applied", before: { name: "air" }, intended: { name: "stone" } }],
    });
  });

  it("forwards an observed wrong placement state to the journal as a conflict", async () => {
    const { bot, world } = createWorld({ "0,63,0": { name: "stone" } });
    bot.placeBlock.mockImplementation(async (reference: { position: Vec3 }, face: Vec3) => {
      world.set(key(reference.position.plus(face)), { name: "dirt" });
    });
    const skill = createPlaceBlockSkill(dependencies());

    const result = await skill.run(skill.params.parse({ block: "stone", x: 0, y: 64, z: 0 }), context(bot));

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    const transactionId = (result.details?.transaction as { id: number }).id;
    expect(getTransaction(db, transactionId)).toMatchObject({
      status: "partial",
      changes: [{
        action: "place",
        status: "conflict",
        confirmedAfter: { name: "dirt" },
      }],
    });
  });

  it("refuses an occupied placement without overwriting the live block", async () => {
    const { bot, world } = createWorld({ "0,63,0": { name: "stone" }, "0,64,0": { name: "dirt" } });
    const skill = createPlaceBlockSkill(dependencies());

    const result = await skill.run(skill.params.parse({ block: "stone", x: 0, y: 64, z: 0 }), context(bot));

    expect(result).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });
    expect(world.get("0,64,0")).toEqual({ name: "dirt" });
    const transactionId = (result.details?.transaction as { id: number }).id;
    expect(getTransaction(db, transactionId)).toMatchObject({ status: "cancelled", changes: [] });
  });

  it("honors collectDrops=false without attempting post-dig pickup", async () => {
    const { bot, world } = createWorld({ "0,64,0": { name: "stone" } });
    bot.dig.mockImplementation(async (block: { position: Vec3 }) => {
      world.delete(key(block.position));
      bot.entities = { "77": { id: 77, name: "item", position: new Vec3(0, 64, 0) } };
    });
    const skill = createDigBlockSkill(dependencies());

    const result = await skill.run(skill.params.parse({ x: 0, y: 64, z: 0, collectDrops: false }), context(bot));

    expect(result).toMatchObject({ ok: true, data: { after: { name: "air" }, collectDrops: false } });
    expect(pathfindTo).not.toHaveBeenCalled();
  });

  it("makes a bounded truthful pickup attempt only when collectDrops=true", async () => {
    const { bot, world } = createWorld({ "0,64,0": { name: "stone" } });
    bot.dig.mockImplementation(async (block: { position: Vec3 }) => {
      world.delete(key(block.position));
      bot.entities = { "77": { id: 77, name: "item", position: new Vec3(0, 64, 0) } };
    });
    const skill = createDigBlockSkill(dependencies());

    const result = await skill.run(skill.params.parse({ x: 0, y: 64, z: 0, collectDrops: true }), context(bot));

    expect(pathfindTo).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      data: { dropPickup: { observed: 1, approached: 1, unreachable: 0 } },
    });
  });

  it("preflights the full clear before changing any candidate when its budget cannot fit", async () => {
    const { bot, world } = createWorld({ "0,64,0": { name: "stone" }, "1,64,0": { name: "dirt" } });
    const skill = createClearRegionSkill(dependencies());

    const result = await skill.run(skill.params.parse({
      from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 0 }, collectDrops: false,
    }), context(bot, new AbortController(), 1));

    expect(result).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED", details: { candidates: 2 } });
    expect(world.get("0,64,0")).toEqual({ name: "stone" });
    expect(world.get("1,64,0")).toEqual({ name: "dirt" });
    expect(bot.dig).not.toHaveBeenCalled();
  });

  it("preserves containers by default, includes them only explicitly, and reports deterministic skips", async () => {
    const initial = {
      "0,64,0": { name: "stone" },
      "1,64,0": { name: "chest", blockEntity: true },
      "2,64,0": { name: "dirt" },
      "3,64,0": { name: "bedrock", diggable: false },
    } satisfies Record<string, BlockState>;
    const first = createWorld(initial);
    const skill = createClearRegionSkill(dependencies());

    const defaultResult = await skill.run(skill.params.parse({
      from: { x: 0, y: 64, z: 0 }, to: { x: 3, y: 64, z: 0 }, collectDrops: false,
      preserve: ["dirt"],
    }), context(first.bot));

    expect(defaultResult).toMatchObject({
      ok: true,
      data: { counts: { confirmed: 1, containers: 1, preserved: 1, undiggable: 1 } },
    });
    expect(first.world.get("0,64,0")).toBeUndefined();
    expect(first.world.get("1,64,0")).toEqual({ name: "chest", blockEntity: true });

    const second = createWorld(initial);
    const explicitResult = await skill.run(skill.params.parse({
      from: { x: 1, y: 64, z: 0 }, to: { x: 1, y: 64, z: 0 },
      includeContainers: true, collectDrops: false,
    }), context(second.bot));
    expect(explicitResult).toMatchObject({ ok: true, data: { counts: { confirmed: 1, containers: 0 } } });
    expect(second.world.get("1,64,0")).toBeUndefined();
  });

  it("fails closed on an unloaded scan and on a volume overflow before a transaction mutation", async () => {
    const { bot } = createWorld({ "0,64,0": null });
    const skill = createClearRegionSkill(dependencies());

    const unavailable = await skill.run(skill.params.parse({
      from: { x: 0, y: 64, z: 0 }, to: { x: 0, y: 64, z: 0 },
    }), context(bot));
    expect(unavailable).toMatchObject({ ok: false, code: "WORLD_UNAVAILABLE", details: { unavailableCount: 1 } });

    const overflow = await skill.run(skill.params.parse({
      from: { x: -30_000_000, y: -64, z: -30_000_000 },
      to: { x: 30_000_000, y: 320, z: 30_000_000 },
    }), context(bot));
    expect(overflow).toMatchObject({ ok: false, code: "AREA_UNSAFE" });
    expect(bot.dig).not.toHaveBeenCalled();
  });

  it("keeps a partially completed clear journaled as partial when a later dig fails", async () => {
    const { bot, world } = createWorld({ "0,64,0": { name: "stone" }, "1,64,0": { name: "dirt" } });
    let digCount = 0;
    bot.dig.mockImplementation(async (block: { position: Vec3 }) => {
      digCount++;
      if (digCount === 2) throw new Error("server stopped digging");
      world.delete(key(block.position));
    });
    const skill = createClearRegionSkill(dependencies());

    const result = await skill.run(skill.params.parse({
      from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 0 }, collectDrops: false,
    }), context(bot));

    expect(result).toMatchObject({ ok: false, code: "UNKNOWN", details: { counts: { confirmed: 1 } } });
    const transactionId = (result.details?.transaction as { id: number }).id;
    expect(getTransaction(db, transactionId)).toMatchObject({
      status: "partial",
      changes: [{ status: "applied" }, { status: "failed" }],
    });
  });

  it("validates exact integer region and direct-action coordinates", () => {
    const clear = createClearRegionSkill(dependencies());
    const dig = createDigBlockSkill(dependencies());
    expect(() => clear.params.parse({ from: { x: 0.5, y: 64, z: 0 }, to: { x: 0, y: 64, z: 0 } })).toThrow();
    expect(() => clear.params.parse({ from: { x: 0, y: 321, z: 0 }, to: { x: 0, y: 64, z: 0 } })).toThrow();
    expect(() => dig.params.parse({ x: 0, y: 64.2, z: 0 })).toThrow();
  });
});
