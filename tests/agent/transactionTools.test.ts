import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { createWorldTransactionService } from "../../src/world/transactions/service.js";
import {
  createGetWorldTransactionTool,
  createListWorldTransactionsTool,
  createPreviewUndoTransactionTool,
  createUndoWorldTransactionTool,
} from "../../src/agent/transactionTools.js";

let temporaryDirectory: string;
let db: DB;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "smartbotmc-transaction-tools-"));
  db = openDatabase(join(temporaryDirectory, "memory.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

const owner = { username: "owner", role: "owner" as const, source: "desktop" as const };
const viewer = { username: "viewer", role: "viewer" as const, source: "desktop" as const };

function dependencies(actor = owner) {
  const transactions = createWorldTransactionService({ db, now: vi.fn(() => 100) });
  transactions.begin({
    serverKey: "test.example:25565",
    dimension: "overworld",
    kind: "test",
    actor,
    label: "transaction tool test",
  });
  return {
    transactions,
    serverKey: "test.example:25565",
    getBot: () => ({ game: { dimension: "overworld" } } as never),
    actorProvider: () => actor,
  };
}

describe("transaction tools", () => {
  it("lists and reads bounded durable transactions for owners", async () => {
    const deps = dependencies();
    const list = createListWorldTransactionsTool(deps);
    const get = createGetWorldTransactionTool(deps);
    expect(await list.handler({})).toMatchObject({ ok: true });
    expect(await get.handler({ transactionId: 1 })).toMatchObject({ ok: true });
  });

  it("keeps all transaction tools owner-only even when called without the wrapper", async () => {
    const deps = dependencies(viewer);
    const tools = [
      createListWorldTransactionsTool(deps),
      createGetWorldTransactionTool(deps),
      createPreviewUndoTransactionTool(deps),
      createUndoWorldTransactionTool(deps),
    ];
    for (const tool of tools) {
      expect(tool.policy.minimumRole).toBe("owner");
      expect(await tool.handler({ transactionId: 1 } as never)).toMatchObject({
        ok: false,
        code: "PERMISSION_DENIED",
      });
    }
  });

  it("reports a disconnected preview/undo without journal changes", async () => {
    const deps = dependencies();
    const getBot = () => undefined;
    const preview = createPreviewUndoTransactionTool({ ...deps, getBot });
    const undo = createUndoWorldTransactionTool({ ...deps, getBot });
    expect(await preview.handler({ transactionId: 1 })).toMatchObject({ ok: false, code: "WORLD_UNAVAILABLE" });
    expect(await undo.handler({ transactionId: 1 })).toMatchObject({ ok: false, code: "WORLD_UNAVAILABLE" });
  });
});
