import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import {
  createConstructionJob,
  getBlueprint,
  getConstructionJob,
  registerCompiledBlueprint,
} from "../../../src/construction/store.js";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { buildBlueprint } from "../../../src/skills/construction/buildBlueprint.js";
import type { SkillContext } from "../../../src/skills/types.js";
import { createWorldTransactionService } from "../../../src/world/transactions/service.js";
import { getTransaction, listTransactions } from "../../../src/world/transactions/store.js";

type BlockProperties = Record<string, string | number | boolean>;
type WorldCell = { readonly name: string; readonly properties?: BlockProperties };

let temporaryDirectory: string;
let db: DB;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "smbmc-hinted-build-"));
  db = openDatabase(join(temporaryDirectory, "memory.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function positionKey(position: { x: number; y: number; z: number }): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function facingFromYaw(yaw: number): "north" | "east" | "south" | "west" {
  if (Math.abs(yaw) < 0.001) return "north";
  if (Math.abs(yaw + Math.PI / 2) < 0.001) return "east";
  if (Math.abs(Math.abs(yaw) - Math.PI) < 0.001) return "south";
  return "west";
}

function makeContext(bot: unknown): SkillContext {
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
      // Source authorization deliberately re-resolves this as the configured
      // owner rather than trusting the durable role snapshot.
      actor: { username: "Owner", role: "owner", source: "minecraft-chat" },
    },
  };
}

function makeSkill() {
  return buildBlueprint({
    db,
    transactions: createWorldTransactionService({ db }),
    serverKey: "test.example:25565",
    ownerUsername: "Owner",
    configuredVersion: "1.21.11",
    getLiveVersion: () => "1.21.11",
  });
}

function makeStatefulBot(input: {
  readonly world: Map<string, WorldCell>;
  readonly stateRegistry?: boolean;
}) {
  const inventory = { oak_stairs: 1 };
  let held: string | undefined;
  let yaw = 0;
  const blockAt = vi.fn((position: Vec3) => {
    const floored = position.floored();
    const cell = input.world.get(positionKey(floored)) ?? { name: "air" };
    return {
      name: cell.name,
      position: floored,
      stateId: cell.name === "air" ? 0 : 1,
      boundingBox: cell.name === "air" ? "empty" : "block",
      diggable: true,
      getProperties: () => ({ ...cell.properties }),
    };
  });
  const bot = {
    version: "1.21.11",
    game: { dimension: "overworld" },
    entity: { position: new Vec3(10, 65, 8) },
    registry: {
      itemsByName: {
        oak_stairs: { id: 1 },
      },
      ...(input.stateRegistry === false ? {} : {
        blocksByName: {
          oak_stairs: {
            states: [
              { name: "facing", values: ["north", "east", "south", "west"] },
              { name: "half", values: ["top", "bottom"] },
              { name: "shape", values: ["straight", "inner_left", "inner_right"] },
            ],
          },
        },
      }),
    },
    inventory: {
      items: () => inventory.oak_stairs > 0
        ? [{ name: "oak_stairs", type: 1, count: inventory.oak_stairs }]
        : [],
    },
    blockAt,
    canSeeBlock: vi.fn(() => true),
    equip: vi.fn(async (item: { name: string }) => { held = item.name; }),
    look: vi.fn(async (nextYaw: number) => { yaw = nextYaw; }),
    placeBlock: vi.fn(async () => {
      throw new Error("hinted stairs must not use the unverified public placement path");
    }),
    _placeBlockWithOptions: vi.fn(async (
      reference: { position: Vec3 },
      face: Vec3,
      options: { half?: "top" | "bottom" },
    ) => {
      if (held !== "oak_stairs") throw new Error("expected oak stairs to be equipped");
      const target = reference.position.plus(face);
      input.world.set(positionKey(target), {
        name: "oak_stairs",
        properties: {
          facing: facingFromYaw(yaw),
          half: options.half ?? "bottom",
          shape: "straight",
        },
      });
      inventory.oak_stairs--;
    }),
  };
  return { bot, blockAt };
}

function registerHintedStairs(name: string) {
  return registerCompiledBlueprint(db, {
    name,
    blocks: [{
      x: 0,
      y: 0,
      z: 0,
      block: "oak_stairs",
      hint: { facing: "north", half: "top" },
    }],
    sourceSchema: "smartbot.build/v1",
    targetVersion: "1.21.11",
    sourceJson: '{"schema":"smartbot.build/v1"}',
    sourceHash: "a".repeat(64),
    compileReportJson: '{"requiredAccess":"owner"}',
    creator: { username: "Owner", role: "owner", source: "desktop" },
  });
}

describe("buildBlueprint source-backed stateful stairs", () => {
  it("persists a compiler hint through normalization, rotates its facing, verifies it, and journals the intended state", async () => {
    const registered = registerHintedStairs("rotated-hinted-stair");
    // The executor rereads this serialized representation, so this makes the
    // test cover the registration/store/normalization boundary—not just an
    // in-memory compiled result.
    expect(getBlueprint(db, registered.id)?.placementUnits).toEqual([
      expect.objectContaining({
        item: "oak_stairs",
        hint: { facing: "north", half: "top" },
        anchor: expect.objectContaining({ hint: { facing: "north", half: "top" } }),
      }),
    ]);
    const job = createConstructionJob(db, {
      blueprintId: registered.id,
      originX: 10,
      originY: 65,
      originZ: 10,
      rotation: 90,
    });
    // The east-facing controlled click uses the solid west neighbor. Keeping
    // the support at the same Y also verifies the top-half side-click route.
    const world = new Map<string, WorldCell>([["9,65,10", { name: "stone" }]]);
    const fake = makeStatefulBot({ world });

    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(result).toMatchObject({
      ok: true,
      data: {
        placed: 1,
        total: 1,
        verification: { matches: true, stateMismatched: 0 },
      },
    });
    // North in the source rotates clockwise to east for a 90-degree job.
    expect(fake.bot.look).toHaveBeenCalledWith(-Math.PI / 2, 0);
    expect(fake.bot._placeBlockWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ position: expect.objectContaining({ x: 9, y: 65, z: 10 }) }),
      expect.objectContaining({ x: 1, y: 0, z: 0 }),
      expect.objectContaining({ half: "top", forceLook: "ignore" }),
    );
    expect(fake.bot.placeBlock).not.toHaveBeenCalled();
    expect(world.get("10,65,10")).toEqual({
      name: "oak_stairs",
      properties: { facing: "east", half: "top", shape: "straight" },
    });
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "completed", placedCount: 1 });

    const [summary] = listTransactions(db, { serverKey: "test.example:25565" });
    expect(summary).toMatchObject({
      kind: "construction",
      status: "completed",
      constructionJobId: job.id,
      requestedChangeCount: 1,
      appliedChangeCount: 1,
    });
    expect(getTransaction(db, summary!.id)?.changes).toEqual([
      expect.objectContaining({
        ordinal: 0,
        action: "place",
        status: "applied",
        intended: expect.objectContaining({
          name: "oak_stairs",
          properties: expect.objectContaining({ facing: "east", half: "top" }),
        }),
        confirmedAfter: expect.objectContaining({
          name: "oak_stairs",
          properties: expect.objectContaining({ facing: "east", half: "top" }),
        }),
      }),
    ]);
  });

  it("fails closed before a click when the live runtime cannot verify a persisted stateful hint", async () => {
    const blueprint = registerHintedStairs("unsupported-hinted-stair");
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 10,
      originY: 65,
      originZ: 10,
    });
    const world = new Map<string, WorldCell>([["9,65,10", { name: "stone" }]]);
    const fake = makeStatefulBot({ world, stateRegistry: false });

    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_STATE", recoverable: false });
    expect(fake.bot.equip).not.toHaveBeenCalled();
    expect(fake.bot.look).not.toHaveBeenCalled();
    expect(fake.bot._placeBlockWithOptions).not.toHaveBeenCalled();
    expect(fake.bot.placeBlock).not.toHaveBeenCalled();
    expect(world.get("10,65,10")).toBeUndefined();
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "failed", placedCount: 0 });
    const [summary] = listTransactions(db, { serverKey: "test.example:25565" });
    expect(summary).toMatchObject({ requestedChangeCount: 0, appliedChangeCount: 0 });
  });
});
