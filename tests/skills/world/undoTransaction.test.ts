import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { completeTransaction, markChangeApplied, planChange } from "../../../src/world/transactions/store.js";
import { createWorldTransactionService } from "../../../src/world/transactions/service.js";
import { previewUndoTransaction, undoWorldTransaction } from "../../../src/skills/world/undoTransaction.js";

let temporaryDirectory: string;
let db: DB;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "smartbotmc-undo-"));
  db = openDatabase(join(temporaryDirectory, "memory.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

const actor = { username: "owner", role: "owner" as const, source: "minecraft-chat" as const };

function createWorld(initial: Record<string, string>) {
  const blocks = new Map(Object.entries(initial));
  let held = "";
  const bot: Record<string, any> = {
    game: { dimension: "overworld" },
    entity: { position: new Vec3(0, 63, 0) },
    registry: { itemsByName: { stone: { id: 1 }, dirt: { id: 2 } } },
    inventory: { items: () => held ? [{ name: held, type: held === "stone" ? 1 : 2, count: 8 }] : [] },
    canDigBlock: vi.fn(() => true),
    canSeeBlock: vi.fn(() => true),
    pathfinder: { bestHarvestTool: vi.fn(() => null) },
  };
  bot.blockAt = vi.fn((position: Vec3) => {
    const p = position.floored();
    const name = blocks.get(`${p.x},${p.y},${p.z}`) ?? "air";
    return {
      name,
      position: p,
      stateId: name === "air" ? 0 : name === "stone" ? 1 : 2,
      boundingBox: name === "air" ? "empty" : "block",
      diggable: name !== "bedrock",
      getProperties: () => ({}),
    };
  });
  bot.equip = vi.fn(async (item: { name: string }) => { held = item.name; });
  bot.dig = vi.fn(async (block: { position: Vec3 }) => {
    const p = block.position.floored();
    blocks.delete(`${p.x},${p.y},${p.z}`);
  });
  bot.placeBlock = vi.fn(async (reference: { position: Vec3 }, face: Vec3) => {
    const p = reference.position.plus(face).floored();
    blocks.set(`${p.x},${p.y},${p.z}`, held);
  });
  return { bot, blocks, setHeld: (item: string) => { held = item; } };
}

function createPlacedTransaction(service: ReturnType<typeof createWorldTransactionService>) {
  const transaction = service.begin({
    serverKey: "test.example:25565",
    dimension: "overworld",
    kind: "atomic-place",
    actor,
  });
  const change = planChange(db, {
    transactionId: transaction.id,
    ordinal: 0,
    position: { x: 0, y: 64, z: 0 },
    action: "place",
    before: { name: "air", properties: {} },
    intended: { name: "stone", properties: {} },
  });
  markChangeApplied(db, change.id, { name: "stone", properties: {} }, 101);
  completeTransaction(db, transaction.id, 102);
  return transaction.id;
}

describe("undoTransaction", () => {
  it("previews and reverses a completed placement", async () => {
    const service = createWorldTransactionService({ db, now: vi.fn(() => 200) });
    const { bot, blocks } = createWorld({ "0,64,0": "stone", "0,63,0": "stone" });
    const transactionId = createPlacedTransaction(service);

    const preview = previewUndoTransaction({ transactions: service, serverKey: "test.example:25565", bot }, transactionId);
    expect(preview).toMatchObject({ readyCount: 1, conflictCount: 0, changes: [{ disposition: "ready" }] });
    const result = await undoWorldTransaction({ transactions: service, serverKey: "test.example:25565", bot }, { transactionId });

    expect(result).toMatchObject({ ok: true, data: { reverted: 1 } });
    expect(blocks.has("0,64,0")).toBe(false);
    expect(service.get(transactionId)).toMatchObject({ status: "undone", changes: [{ status: "reverted" }] });
    expect(bot.dig).toHaveBeenCalledTimes(1);
  });

  it("preserves an intervening edit as a conflict without digging it", async () => {
    const service = createWorldTransactionService({ db, now: vi.fn(() => 200) });
    const { bot } = createWorld({ "0,64,0": "dirt", "0,63,0": "stone" });
    const transactionId = createPlacedTransaction(service);

    const result = await undoWorldTransaction({ transactions: service, serverKey: "test.example:25565", bot }, { transactionId });
    expect(result).toMatchObject({ ok: false, code: "STALE_STATE", details: { conflicts: 1 } });
    expect(bot.dig).not.toHaveBeenCalled();
    expect(service.get(transactionId)).toMatchObject({ status: "undo_partial", changes: [{ status: "conflict" }] });
  });

  it("does not manufacture restoration material", async () => {
    const service = createWorldTransactionService({ db, now: vi.fn(() => 200) });
    const { bot, blocks } = createWorld({ "0,64,0": "air", "0,63,0": "stone" });
    const transaction = service.begin({
      serverKey: "test.example:25565", dimension: "overworld", kind: "atomic-dig", actor,
    });
    const change = planChange(db, {
      transactionId: transaction.id,
      ordinal: 0,
      position: { x: 0, y: 64, z: 0 },
      action: "dig",
      before: { name: "dirt", properties: {} },
      intended: { name: "air", properties: {} },
    });
    markChangeApplied(db, change.id, { name: "air", properties: {} }, 101);
    completeTransaction(db, transaction.id, 102);

    const result = await undoWorldTransaction({ transactions: service, serverKey: "test.example:25565", bot }, { transactionId: transaction.id });
    expect(result).toMatchObject({ ok: false, code: "NO_MATERIAL", details: { materialMissing: "dirt" } });
    expect(blocks.get("0,64,0")).toBe("air");
    expect(service.get(transaction.id)).toMatchObject({ status: "undoing", changes: [{ status: "reverting" }] });
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });
});
