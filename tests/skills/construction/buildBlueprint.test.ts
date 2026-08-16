import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import {
  createConstructionJob,
  getConstructionJob,
  upsertBlueprint,
} from "../../../src/construction/store.js";
import { replaceContainerSnapshot } from "../../../src/memory/containers.js";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { upsertLocation } from "../../../src/memory/locations.js";
import { buildBlueprint } from "../../../src/skills/construction/buildBlueprint.js";
import type { SkillContext } from "../../../src/skills/types.js";
import { createWorldTransactionService } from "../../../src/world/transactions/service.js";

let tmp: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeCtx(bot: unknown): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: bot as SkillContext["bot"],
    signal: new AbortController().signal,
    log,
    reportProgress: vi.fn(),
    execution: {
      actor: { username: "owner", role: "owner", source: "minecraft-chat" },
    },
  };
}

function buildSkill() {
  return buildBlueprint({
    db,
    transactions: createWorldTransactionService({ db }),
    serverKey: "test:25565",
    ownerUsername: "owner",
    configuredVersion: "1.21.11",
    getLiveVersion: () => "1.21.11",
  });
}

function key(position: Vec3): string {
  return `${position.x},${position.y},${position.z}`;
}

describe("buildBlueprint", () => {
  it("skips correct blocks and places only missing blocks on solid support", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "two-planks",
      blocks: [
        { x: 0, y: 0, z: 0, block: "oak_planks" },
        { x: 1, y: 0, z: 0, block: "oak_planks" },
      ],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 10, originY: 65, originZ: 10,
    });
    const world = new Map<string, string>([
      ["10,65,10", "oak_planks"],
      ["10,64,10", "stone"],
      ["11,64,10", "stone"],
    ]);
    let planks = 1;
    const blockAt = vi.fn((position: Vec3) => ({
      name: world.get(key(position)) ?? "air",
      position,
      boundingBox: world.has(key(position)) ? "block" : "empty",
    }));
    const placeBlock = vi.fn(async (
      reference: { position: Vec3 },
      face: Vec3,
    ) => {
      world.set(key(reference.position.plus(face)), "oak_planks");
      planks--;
    });
    const bot = {
      game: { dimension: "overworld" },
      registry: { itemsByName: { oak_planks: { id: 5 } } },
      entity: { position: new Vec3(10, 65, 8) },
      inventory: {
        items: () => planks > 0
          ? [{ name: "oak_planks", type: 5, count: planks }]
          : [],
      },
      blockAt,
      equip: vi.fn().mockResolvedValue(undefined),
      placeBlock,
    };

    const result = await buildSkill().run({ jobId: job.id }, makeCtx(bot));

    expect(result).toMatchObject({
      ok: true,
      data: { placed: 1, alreadyCorrect: 1, total: 2 },
    });
    expect(placeBlock).toHaveBeenCalledOnce();
    expect(world.get("11,65,10")).toBe("oak_planks");
    expect(getConstructionJob(db, job.id)).toMatchObject({
      status: "completed",
      placedCount: 2,
    });
  });

  it("blocks safely before placement when materials are missing", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "stone-marker",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 65, originZ: 0,
    });
    const placeBlock = vi.fn();
    const bot = {
      game: { dimension: "overworld" },
      registry: { itemsByName: { stone: { id: 1 } } },
      inventory: { items: () => [] },
      blockAt: (position: Vec3) => ({
        name: position.y === 64 ? "stone" : "air",
        position,
        boundingBox: position.y === 64 ? "block" : "empty",
      }),
      placeBlock,
    };

    const result = await buildSkill().run({ jobId: job.id }, makeCtx(bot));

    expect(result).toMatchObject({ ok: false, code: "NO_MATERIAL" });
    expect(placeBlock).not.toHaveBeenCalled();
    expect(getConstructionJob(db, job.id)).toMatchObject({
      status: "blocked",
      placedCount: 0,
    });
  });

  it("retrieves missing blocks from configured indexed storage before building", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "stored-marker",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    upsertLocation(db, { name: "main", x: 1, y: 2, z: 3 });
    replaceContainerSnapshot(db, {
      name: "main", dimension: "overworld", x: 1, y: 2, z: 3,
      blockType: "chest",
      items: [{ item: "stone", itemType: 1, metadata: 0, count: 1 }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 10, originY: 65, originZ: 10,
      storageName: "main",
    });
    const world = new Map<string, string>([["10,64,10", "stone"]]);
    let carried = 0;
    let stored = 1;
    const container = {
      containerItems: () => stored > 0
        ? [{ name: "stone", type: 1, metadata: 0, count: stored }]
        : [],
      withdraw: vi.fn(async (_type: number, _metadata: number, count: number) => {
        stored -= count;
        carried += count;
      }),
      close: vi.fn(),
    };
    const blockAt = vi.fn((position: Vec3) => {
      if (key(position) === "1,2,3") {
        return { name: "chest", position, boundingBox: "block" };
      }
      return {
        name: world.get(key(position)) ?? "air",
        position,
        boundingBox: world.has(key(position)) ? "block" : "empty",
      };
    });
    const bot = {
      game: { dimension: "overworld" },
      registry: { itemsByName: { stone: { id: 1 } } },
      entity: { position: new Vec3(10, 65, 8) },
      inventory: {
        items: () => carried > 0 ? [{ name: "stone", type: 1, count: carried }] : [],
      },
      pathfinder: { goto: vi.fn().mockResolvedValue(undefined), setGoal: vi.fn() },
      blockAt,
      openContainer: vi.fn().mockResolvedValue(container),
      equip: vi.fn().mockResolvedValue(undefined),
      placeBlock: vi.fn(async (
        reference: { position: Vec3 },
        face: Vec3,
      ) => {
        world.set(key(reference.position.plus(face)), "stone");
        carried--;
      }),
    };

    const result = await buildSkill().run({ jobId: job.id }, makeCtx(bot));

    expect(result).toMatchObject({ ok: true, data: { placed: 1, total: 1 } });
    expect(container.withdraw).toHaveBeenCalledWith(1, 0, 1);
    expect(world.get("10,65,10")).toBe("stone");
    expect(getConstructionJob(db, job.id)?.status).toBe("completed");
  });

  it("allows placement over harmless non-solid vegetation", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "grass-marker",
      blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 2, originY: 65, originZ: 2,
    });
    const world = new Map<string, string>([
      ["2,64,2", "stone"],
      ["2,65,2", "short_grass"],
    ]);
    let planks = 1;
    const blockAt = (position: Vec3) => {
      const name = world.get(key(position)) ?? "air";
      return {
        name,
        position,
        boundingBox: name === "stone" ? "block" : "empty",
      };
    };
    const bot = {
      game: { dimension: "overworld" },
      registry: { itemsByName: { oak_planks: { id: 5 } } },
      entity: { position: new Vec3(2, 65, 0) },
      inventory: {
        items: () => planks > 0
          ? [{ name: "oak_planks", type: 5, count: planks }]
          : [],
      },
      blockAt,
      equip: vi.fn().mockResolvedValue(undefined),
      placeBlock: vi.fn(async (
        reference: { position: Vec3 },
        face: Vec3,
      ) => {
        world.set(key(reference.position.plus(face)), "oak_planks");
        planks--;
      }),
    };

    const result = await buildSkill().run({ jobId: job.id }, makeCtx(bot));

    expect(result).toMatchObject({ ok: true, data: { placed: 1 } });
    expect(world.get("2,65,2")).toBe("oak_planks");
  });

  it("refuses to replace any existing mismatched block", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "safe-marker",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 2, originY: 65, originZ: 2,
    });
    const placeBlock = vi.fn();
    const bot = {
      game: { dimension: "overworld" },
      registry: { itemsByName: { stone: { id: 1 } } },
      inventory: { items: () => [{ name: "stone", type: 1, count: 1 }] },
      blockAt: (position: Vec3) => ({
        name: "owner_build",
        position,
        boundingBox: "block",
      }),
      placeBlock,
    };

    const result = await buildSkill().run({ jobId: job.id }, makeCtx(bot));

    expect(result).toMatchObject({ ok: false, code: "AREA_UNSAFE", recoverable: false });
    expect(placeBlock).not.toHaveBeenCalled();
    expect(getConstructionJob(db, job.id)?.status).toBe("failed");
  });

  it("defers unsupported blocks until another blueprint block provides support", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "reverse-order-column",
      blocks: [
        { x: 0, y: 1, z: 0, block: "oak_planks" },
        { x: 0, y: 0, z: 0, block: "oak_planks" },
      ],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 4, originY: 65, originZ: 4,
    });
    const world = new Map<string, string>([["4,64,4", "stone"]]);
    let planks = 2;
    let held = "";
    const blockAt = (position: Vec3) => {
      const name = world.get(key(position)) ?? "air";
      return {
        name,
        position,
        boundingBox: name === "air" ? "empty" : "block",
      };
    };
    const bot = {
      game: { dimension: "overworld" },
      registry: { itemsByName: { oak_planks: { id: 5 } } },
      entity: { position: new Vec3(4, 65, 2) },
      inventory: {
        items: () => planks > 0
          ? [{ name: "oak_planks", type: 5, count: planks }]
          : [],
      },
      blockAt,
      equip: vi.fn(async (item: { name: string }) => {
        held = item.name;
      }),
      placeBlock: vi.fn(async (
        reference: { position: Vec3 },
        face: Vec3,
      ) => {
        world.set(key(reference.position.plus(face)), held);
        planks--;
      }),
    };

    const result = await buildSkill().run({ jobId: job.id }, makeCtx(bot));

    expect(result).toMatchObject({ ok: true, data: { placed: 2, total: 2 } });
    expect(world.get("4,65,4")).toBe("oak_planks");
    expect(world.get("4,66,4")).toBe("oak_planks");
  });

  it("uses spare dirt as a bounded temporary scaffold and removes it afterward", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "floating-marker",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 67, originZ: 0,
    });
    const world = new Map<string, string>([
      ["0,64,0", "stone"],
      ["1,64,0", "stone"],
    ]);
    const inventory = new Map<string, number>([["stone", 1], ["dirt", 3]]);
    let held = "";
    const blockAt = (position: Vec3) => {
      const name = world.get(key(position)) ?? "air";
      return {
        name,
        position,
        boundingBox: name === "air" ? "empty" : "block",
      };
    };
    const bot = {
      game: { dimension: "overworld" },
      registry: { itemsByName: { stone: { id: 1 }, dirt: { id: 3 } } },
      entity: { position: new Vec3(0, 67, -2) },
      inventory: {
        items: () => [...inventory]
          .filter(([, count]) => count > 0)
          .map(([name, count]) => ({ name, type: name === "stone" ? 1 : 3, count })),
      },
      blockAt,
      equip: vi.fn(async (item: { name: string }) => {
        held = item.name;
      }),
      placeBlock: vi.fn(async (
        reference: { position: Vec3 },
        face: Vec3,
      ) => {
        world.set(key(reference.position.plus(face)), held);
        inventory.set(held, (inventory.get(held) ?? 0) - 1);
      }),
      dig: vi.fn(async (block: { name: string; position: Vec3 }) => {
        world.delete(key(block.position));
        inventory.set(block.name, (inventory.get(block.name) ?? 0) + 1);
      }),
    };

    const result = await buildSkill().run({ jobId: job.id }, makeCtx(bot));

    expect(result).toMatchObject({ ok: true, data: { placed: 1, total: 1 } });
    expect(world.get("0,67,0")).toBe("stone");
    expect(world.get("1,65,0")).toBeUndefined();
    expect(world.get("1,66,0")).toBeUndefined();
    expect(world.get("1,67,0")).toBeUndefined();
    expect(bot.dig).toHaveBeenCalledTimes(3);
  });

  it("reports an exact scaffold blocker when no spare support material is carried", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "unsupported-marker",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 67, originZ: 0,
    });
    const bot = {
      game: { dimension: "overworld" },
      registry: { itemsByName: { stone: { id: 1 } } },
      entity: { position: new Vec3(0, 67, -2) },
      inventory: { items: () => [{ name: "stone", type: 1, count: 1 }] },
      blockAt: (position: Vec3) => ({
        name: position.y === 64 ? "stone" : "air",
        position,
        boundingBox: position.y === 64 ? "block" : "empty",
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      placeBlock: vi.fn(),
      dig: vi.fn(),
    };

    const result = await buildSkill().run({ jobId: job.id }, makeCtx(bot));

    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      details: {
        requiresScaffold: true,
        acceptedScaffoldBlocks: ["dirt", "cobblestone"],
      },
    });
    expect(getConstructionJob(db, job.id)?.status).toBe("blocked");
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });
});
