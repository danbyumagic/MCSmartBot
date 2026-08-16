import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import {
  createConstructionJob,
  registerCompiledBlueprint,
} from "../../../src/construction/store.js";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { setPlayerRole } from "../../../src/permissions/roles.js";
import { buildBlueprint } from "../../../src/skills/construction/buildBlueprint.js";
import type { SkillContext } from "../../../src/skills/types.js";
import { createWorldTransactionService } from "../../../src/world/transactions/service.js";

let directory: string;
let db: DB;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "smbmc-build-hazard-"));
  db = openDatabase(join(directory, "memory.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function key(position: { x: number; y: number; z: number }): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function context(bot: unknown, actor: SkillContext["execution"]["actor"]): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: bot as SkillContext["bot"],
    signal: new AbortController().signal,
    log,
    reportProgress: vi.fn(),
    execution: { actor },
  };
}

function makeSkill(getLiveVersion: () => string | undefined = () => "1.21.11") {
  return buildBlueprint({
    db,
    transactions: createWorldTransactionService({ db }),
    serverKey: "test.example:25565",
    ownerUsername: "Owner",
    configuredVersion: "1.21.11",
    getLiveVersion,
  });
}

function makeBot(world: Map<string, string>) {
  let held: string | undefined;
  const inventory = { tnt: 1 };
  const blockAt = vi.fn((position: Vec3) => {
    const floored = position.floored();
    const name = world.get(key(floored)) ?? "air";
    return {
      name,
      position: floored,
      stateId: name === "air" ? 0 : 1,
      boundingBox: name === "air" ? "empty" : "block",
      diggable: true,
      getProperties: () => ({}),
    };
  });
  const placeBlock = vi.fn(async (reference: { position: Vec3 }, face: Vec3) => {
    if (held !== "tnt") throw new Error("expected TNT to be equipped");
    world.set(key(reference.position.plus(face)), "tnt");
    inventory.tnt--;
  });
  return {
    bot: {
      version: "1.21.11",
      game: { dimension: "overworld" },
      entity: { position: new Vec3(-2, 65, -2) },
      registry: { itemsByName: { tnt: { id: 46 } } },
      inventory: { items: () => inventory.tnt > 0 ? [{ name: "tnt", type: 46, count: inventory.tnt }] : [] },
      blockAt,
      equip: vi.fn(async (item: { name: string }) => { held = item.name; }),
      placeBlock,
      dig: vi.fn(async () => {}),
      canDigBlock: () => true,
      canSeeBlock: () => true,
    },
    placeBlock,
  };
}

function ownerHazardJob(name: string): number {
  const blueprint = registerCompiledBlueprint(db, {
    name,
    blocks: [{ x: 0, y: 0, z: 0, block: "tnt" }],
    sourceSchema: "smartbot.build/v1",
    targetVersion: "1.21.11",
    sourceJson: '{"schema":"smartbot.build/v1"}',
    sourceHash: "a".repeat(64),
    compileReportJson: '{"requiredAccess":"owner"}',
    creator: { username: "Owner", role: "owner", source: "desktop" },
  });
  return createConstructionJob(db, {
    blueprintId: blueprint.id,
    originX: 0,
    originY: 65,
    originZ: 0,
  }).id;
}

describe("owner-authorized hazardous generated builds", () => {
  it("allows an owner-authorized source to place TNT through the verified journaled path", async () => {
    const jobId = ownerHazardJob("owner-hazard");
    const world = new Map<string, string>([["0,64,0", "stone"]]);
    const fake = makeBot(world);

    const result = await makeSkill().run(
      { jobId },
      context(fake.bot, { username: "Owner", role: "owner", source: "minecraft-chat" }),
    );

    expect(result).toMatchObject({ ok: true, data: { placed: 1, total: 1 } });
    expect(fake.placeBlock).toHaveBeenCalledOnce();
    expect(world.get("0,65,0")).toBe("tnt");
  });

  it("denies an operator before any TNT click even when the stored source was owner-approved", async () => {
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
    const jobId = ownerHazardJob("operator-hazard-denied");
    const world = new Map<string, string>([["0,64,0", "stone"]]);
    const fake = makeBot(world);

    const result = await makeSkill().run(
      { jobId },
      context(fake.bot, { username: "Builder", role: "operator", source: "minecraft-chat" }),
    );

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(fake.placeBlock).not.toHaveBeenCalled();
    expect(world.get("0,65,0")).toBeUndefined();
  });

  it("fails closed before any click when a source-backed build loses its live version", async () => {
    const jobId = ownerHazardJob("owner-hazard-no-live-version");
    const world = new Map<string, string>([["0,64,0", "stone"]]);
    const fake = makeBot(world);

    const result = await makeSkill(() => undefined).run(
      { jobId },
      context(fake.bot, { username: "Owner", role: "owner", source: "minecraft-chat" }),
    );

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(fake.placeBlock).not.toHaveBeenCalled();
    expect(world.get("0,65,0")).toBeUndefined();
  });
});
