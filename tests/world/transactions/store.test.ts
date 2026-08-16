import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConstructionJob,
  upsertBlueprint,
} from "../../../src/construction/store.js";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import {
  MAX_PROPERTY_VALUE_LENGTH,
  MAX_SNAPSHOT_JSON_BYTES,
  beginOrReuseConstructionAttempt,
  beginTransaction,
  beginUndoTransaction,
  cancelTransaction,
  completeTransaction,
  countAppliedChanges,
  getTransaction,
  listConstructionMutationHistory,
  listTransactions,
  markChangeApplied,
  markChangeFailed,
  markChangeReverted,
  markChangeReverting,
  markChangeUndoConflict,
  planChange,
  finalizeUndoTransaction,
  reconcileOpenTransactions,
} from "../../../src/world/transactions/store.js";

let tmp: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
  installTransactionTables(db);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const actor = {
  username: "Builder",
  role: "operator" as const,
  source: "minecraft-chat" as const,
};

function begin(label = "test change") {
  return beginTransaction(db, {
    serverKey: "example.test:25565",
    dimension: "overworld",
    label,
    kind: "test",
    actor,
    correlation: { request: "store-test", nested: { stable: true } },
  }, 100);
}

function plan(transactionId: number, ordinal = 0) {
  return planChange(db, {
    transactionId,
    ordinal,
    position: { x: 4, y: 65, z: -7 },
    action: "place",
    before: {
      name: "air",
      properties: { waterlogged: false },
    },
    intended: {
      name: "stone",
      stateId: 1,
      properties: { axis: "y" },
    },
  }, 110 + ordinal);
}

function createTaskPlanId(title: string): number {
  const result = db.prepare(
    "INSERT INTO task_plans (ts_created, ts_updated, title, status, last_error) VALUES (?, ?, ?, 'pending', NULL)",
  ).run(100, 100, title);
  return Number(result.lastInsertRowid);
}

function createConstructionAttemptLinks(name: string): { jobId: number; planId: number } {
  const blueprint = upsertBlueprint(db, {
    name: `attempt-${name}`,
    blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
  });
  const job = createConstructionJob(db, {
    blueprintId: blueprint.id,
    originX: 0,
    originY: 64,
    originZ: 0,
  });
  return { jobId: job.id, planId: createTaskPlanId(`attempt ${name}`) };
}

describe("world transaction store", () => {
  it("tracks resumable undo states without creating recursive changes", () => {
    const transaction = begin("undo me");
    const change = plan(transaction.id);
    markChangeApplied(db, change.id, { name: "stone", properties: {} }, 120);
    completeTransaction(db, transaction.id, 121);

    expect(beginUndoTransaction(db, transaction.id, 122)).toMatchObject({ status: "undoing" });
    expect(markChangeReverting(db, change.id, 123)).toMatchObject({ status: "reverting" });
    expect(markChangeReverted(db, change.id, 124)).toMatchObject({ status: "reverted" });
    expect(finalizeUndoTransaction(db, transaction.id, 125)).toMatchObject({ status: "undone" });
    expect(getTransaction(db, transaction.id)).toMatchObject({
      status: "undone",
      changes: [{ status: "reverted", confirmedAfter: { name: "stone" } }],
    });
  });

  it("preserves an undo conflict as partial and does not overwrite the change", () => {
    const transaction = begin("conflicted undo");
    const change = plan(transaction.id);
    markChangeApplied(db, change.id, { name: "stone", properties: {} }, 120);
    completeTransaction(db, transaction.id, 121);
    beginUndoTransaction(db, transaction.id, 122);
    markChangeReverting(db, change.id, 123);
    expect(markChangeUndoConflict(db, change.id, "owner edited the block", 124)).toMatchObject({
      status: "conflict",
      lastError: "owner edited the block",
    });
    expect(finalizeUndoTransaction(db, transaction.id, 125)).toMatchObject({ status: "undo_partial" });
  });

  it("does not start undo while an original planned mutation is unresolved", () => {
    const transaction = begin("uncertain undo");
    plan(transaction.id);
    expect(cancelTransaction(db, transaction.id, "interrupted", 120)).toMatchObject({ status: "open" });
    expect(() => beginUndoTransaction(db, transaction.id, 121)).toThrow(/cannot be undone/);
  });

  it("persists immutable actor, correlation, and normalized block snapshots", () => {
    const transaction = begin("place marker");
    const change = plan(transaction.id);
    const persisted = getTransaction(db, transaction.id)!;

    expect(persisted).toMatchObject({
      id: transaction.id,
      serverKey: "example.test:25565",
      dimension: "overworld",
      label: "place marker",
      kind: "test",
      actor,
      status: "open",
      requestedChangeCount: 1,
      appliedChangeCount: 0,
      correlation: { request: "store-test", nested: { stable: true } },
      changes: [{
        id: change.id,
        ordinal: 0,
        position: { x: 4, y: 65, z: -7 },
        action: "place",
        before: { name: "air", properties: { waterlogged: false } },
        intended: { name: "stone", stateId: 1, properties: { axis: "y" } },
        confirmedAfter: null,
        status: "planned",
      }],
    });
    expect(Object.isFrozen(persisted.actor)).toBe(true);
    expect(Object.isFrozen(persisted.correlation)).toBe(true);
    expect(Object.isFrozen(persisted.changes[0]!.before)).toBe(true);
    expect(Object.isFrozen(persisted.changes[0]!.before.properties)).toBe(true);
  });

  it("records applied changes once and makes completion idempotent", () => {
    const transaction = begin();
    const change = plan(transaction.id);

    const applied = markChangeApplied(db, change.id, {
      name: "stone",
      stateId: 1,
      properties: { axis: "y" },
    }, 120)!;
    const repeated = markChangeApplied(db, change.id, {
      name: "stone",
      stateId: 1,
      properties: { axis: "y" },
    }, 121)!;
    expect(() => markChangeApplied(db, change.id, {
      name: "dirt",
      properties: {},
    }, 122)).toThrow(/different confirmed state/);

    expect(applied).toMatchObject({ status: "applied", confirmedAfter: { name: "stone" } });
    expect(repeated).toEqual(applied);
    expect(countAppliedChanges(db, transaction.id)).toBe(1);
    expect(getTransaction(db, transaction.id)).toMatchObject({
      requestedChangeCount: 1,
      appliedChangeCount: 1,
    });

    const completed = completeTransaction(db, transaction.id, 130)!;
    expect(completed.status).toBe("completed");
    expect(completeTransaction(db, transaction.id, 131)).toEqual(completed);
  });

  it("finishes mixed mutation outcomes as partial, never completed", () => {
    const transaction = begin();
    const applied = plan(transaction.id, 0);
    const failed = plan(transaction.id, 1);
    markChangeApplied(db, applied.id, { name: "stone", properties: {} }, 120);
    markChangeFailed(db, failed.id, "mineflayer rejected mutation", 121);

    expect(completeTransaction(db, transaction.id, 130)).toMatchObject({
      status: "partial",
      appliedChangeCount: 1,
      lastError: "mineflayer rejected mutation",
    });
  });

  it("checks lifecycle transitions and prevents planning after cancellation", () => {
    const transaction = begin();
    expect(cancelTransaction(db, transaction.id, "cancelled by operator", 120)).toMatchObject({
      status: "cancelled",
      lastError: "cancelled by operator",
    });
    expect(cancelTransaction(db, transaction.id, "duplicate", 121)).toMatchObject({
      status: "cancelled",
      lastError: "cancelled by operator",
    });
    expect(() => plan(transaction.id)).toThrow(/not open/);
  });

  it("enforces the mutation budget atomically across planned and applied changes", () => {
    const transaction = begin();
    planChange(db, {
      transactionId: transaction.id,
      ordinal: 0,
      position: { x: 0, y: 64, z: 0 },
      action: "place",
      before: { name: "air", properties: {} },
      intended: { name: "stone", properties: {} },
      maxWorldChanges: 1,
    });
    expect(() => planChange(db, {
      transactionId: transaction.id,
      ordinal: 1,
      position: { x: 1, y: 64, z: 0 },
      action: "place",
      before: { name: "air", properties: {} },
      intended: { name: "stone", properties: {} },
      maxWorldChanges: 1,
    })).toThrow(/budget 1 is exhausted/);
  });

  it("shares a supplied execution budget scope across transactions on one server", () => {
    const first = beginTransaction(db, {
      serverKey: "EXAMPLE.TEST:25565", dimension: "overworld", kind: "test", actor,
      budgetScope: "mission:42",
    });
    const second = beginTransaction(db, {
      serverKey: "example.test:25565", dimension: "the_nether", kind: "test", actor,
      budgetScope: "mission:42",
    });
    planChange(db, {
      transactionId: first.id, ordinal: 0, position: { x: 0, y: 64, z: 0 }, action: "place",
      before: { name: "air", properties: {} }, intended: { name: "stone", properties: {} },
      maxWorldChanges: 1,
    });
    expect(() => planChange(db, {
      transactionId: second.id, ordinal: 0, position: { x: 1, y: 64, z: 0 }, action: "place",
      before: { name: "air", properties: {} }, intended: { name: "stone", properties: {} },
      maxWorldChanges: 1,
    })).toThrow(/budget 1 is exhausted/);
    expect(first.serverKey).toBe("example.test:25565");
  });

  it("keeps a cancelled transaction with uncertain planned state reconcilable", () => {
    const transaction = begin();
    plan(transaction.id);
    expect(cancelTransaction(db, transaction.id, "interrupted before confirmation")).toMatchObject({
      status: "open",
    });
    expect(reconcileOpenTransactions(db)).toBe(0);
    expect(getTransaction(db, transaction.id)).toMatchObject({ status: "open" });
  });

  it("blocks a fresh plan behind an uncertain construction click and terminalizes resolved old attempts", () => {
    const links = createConstructionAttemptLinks("first");
    const input = {
      serverKey: "EXAMPLE.TEST:25565",
      dimension: "overworld",
      constructionJobId: links.jobId,
      taskPlanId: links.planId,
      actor,
      label: "build test house",
      budgetScope: `plan:${links.planId}`,
    };
    const first = beginOrReuseConstructionAttempt(db, input, 100);
    const same = beginOrReuseConstructionAttempt(db, {
      ...input,
      serverKey: "example.test:25565",
    }, 101);
    expect(same).toMatchObject({
      id: first.id,
      kind: "construction",
      constructionJobId: links.jobId,
      taskPlanId: links.planId,
      status: "open",
    });

    planChange(db, {
      transactionId: first.id,
      ordinal: 17,
      position: { x: 4, y: 65, z: -7 },
      action: "place",
      before: { name: "air", properties: {} },
      intended: { name: "stone", properties: {} },
    });
    expect(cancelTransaction(db, first.id, "interrupted while world state was unavailable", 110))
      .toMatchObject({ status: "open" });
    expect(beginOrReuseConstructionAttempt(db, input, 111)).toMatchObject({
      id: first.id,
      status: "open",
      changes: [{ ordinal: 17, status: "planned" }],
    });

    expect(() => beginOrReuseConstructionAttempt(db, {
      ...input,
      actor: { username: "OtherBuilder", role: "operator", source: "minecraft-chat" },
    }, 113)).toThrow(/different immutable actor provenance/);

    const differentPlanId = createTaskPlanId("attempt different plan");
    expect(() => beginOrReuseConstructionAttempt(db, {
      ...input,
      taskPlanId: differentPlanId,
      budgetScope: `plan:${differentPlanId}`,
    }, 112)).toThrow(/unresolved planned changes/);

    // Simulate startup reconciliation finishing the old click. The old row is
    // intentionally left `open` here; begin/reuse must terminalize it in the
    // same transaction before allowing the new plan to create its attempt.
    const planned = getTransaction(db, first.id)?.changes[0];
    expect(planned).toBeDefined();
    markChangeApplied(db, planned!.id, { name: "stone", properties: {} }, 114);
    const differentPlan = beginOrReuseConstructionAttempt(db, {
      ...input,
      taskPlanId: differentPlanId,
      budgetScope: `plan:${differentPlanId}`,
    }, 115);
    expect(differentPlan.id).not.toBe(first.id);
    expect(getTransaction(db, first.id)).toMatchObject({ status: "completed" });

    const terminalLinks = createConstructionAttemptLinks("terminal");
    const completedAttempt = beginOrReuseConstructionAttempt(db, {
      ...input,
      constructionJobId: terminalLinks.jobId,
      taskPlanId: terminalLinks.planId,
      budgetScope: `plan:${terminalLinks.planId}`,
    }, 116);
    expect(cancelTransaction(db, completedAttempt.id, "cancelled before mutation", 117))
      .toMatchObject({ status: "cancelled" });
    const retried = beginOrReuseConstructionAttempt(db, {
      ...input,
      constructionJobId: terminalLinks.jobId,
      taskPlanId: terminalLinks.planId,
      budgetScope: `plan:${terminalLinks.planId}`,
    }, 118);
    expect(retried.id).not.toBe(completedAttempt.id);
  });

  it("returns only the latest applied construction mutation per support position", () => {
    const links = createConstructionAttemptLinks("support-history");
    const input = {
      serverKey: "example.test:25565",
      dimension: "overworld",
      constructionJobId: links.jobId,
      taskPlanId: links.planId,
      actor,
      label: "support history",
      budgetScope: `plan:${links.planId}`,
    };
    const first = beginOrReuseConstructionAttempt(db, input, 100);
    const position = { x: 4, y: 65, z: -7 };
    const placed = planChange(db, {
      transactionId: first.id,
      ordinal: 8_192,
      position,
      action: "place",
      before: { name: "air", properties: {} },
      intended: { name: "dirt", properties: {} },
    }, 101);
    markChangeApplied(db, placed.id, { name: "dirt", properties: {} }, 102);
    const failedCleanup = planChange(db, {
      transactionId: first.id,
      ordinal: 8_198,
      position,
      action: "dig",
      before: { name: "dirt", properties: {} },
      intended: { name: "air", properties: {} },
    }, 103);
    markChangeFailed(db, failedCleanup.id, "support cleanup denied", 104);

    // A failed cleanup never discharges the earlier confirmed placement: a
    // caller must still inspect the live coordinate before it resumes.
    expect(listConstructionMutationHistory(db, {
      serverKey: input.serverKey,
      dimension: input.dimension,
      constructionJobId: links.jobId,
      minOrdinal: 8_192,
    })).toMatchObject({
      truncated: false,
      changes: [expect.objectContaining({ action: "place", ordinal: 8_192, status: "applied" })],
    });

    completeTransaction(db, first.id, 105);
    const second = beginOrReuseConstructionAttempt(db, input, 106);
    const appliedCleanup = planChange(db, {
      transactionId: second.id,
      ordinal: 8_198,
      position,
      action: "dig",
      before: { name: "dirt", properties: {} },
      intended: { name: "air", properties: {} },
    }, 107);
    markChangeApplied(db, appliedCleanup.id, { name: "air", properties: {} }, 108);

    // An applied dig is the latest confirmed mutation at this coordinate. The
    // builder sees that terminal cleanup record and creates no support
    // candidate from it.
    expect(listConstructionMutationHistory(db, {
      serverKey: input.serverKey,
      dimension: input.dimension,
      constructionJobId: links.jobId,
      minOrdinal: 8_192,
    })).toMatchObject({
      truncated: false,
      changes: [expect.objectContaining({ action: "dig", ordinal: 8_198, status: "applied" })],
    });
  });

  it("honors a dimension-only list filter", () => {
    const over = begin("overworld");
    const nether = beginTransaction(db, {
      serverKey: "example.test:25565", dimension: "the_nether", kind: "test", actor,
    });
    expect(listTransactions(db, { dimension: "the_nether" }).map((transaction) => transaction.id))
      .toEqual([nether.id]);
    expect(over.dimension).toBe("overworld");
  });

  it("reconciles only safely finalizable open transactions", () => {
    const empty = begin("empty");
    const complete = begin("complete");
    const completeChange = plan(complete.id);
    markChangeApplied(db, completeChange.id, { name: "stone", properties: {} }, 120);
    const failed = begin("failed");
    const failedChange = plan(failed.id);
    markChangeFailed(db, failedChange.id, "no material", 120);
    const unresolved = begin("unresolved");
    plan(unresolved.id);

    expect(reconcileOpenTransactions(db, 200)).toBe(3);
    expect(getTransaction(db, empty.id)?.status).toBe("completed");
    expect(getTransaction(db, complete.id)?.status).toBe("completed");
    expect(getTransaction(db, failed.id)?.status).toBe("failed");
    expect(getTransaction(db, unresolved.id)?.status).toBe("open");
    expect(listTransactions(db, { serverKey: "example.test:25565", limit: 2 })).toHaveLength(2);
  });

  it("rejects unsafe snapshot serialization at the store boundary", () => {
    const transaction = begin();
    expect(() => planChange(db, {
      transactionId: transaction.id,
      ordinal: 0,
      position: { x: 0, y: 64, z: 0 },
      action: "dig",
      before: {
        name: "stone",
        properties: { invalid: ["arrays are not allowed"] as unknown as string },
      },
      intended: { name: "air", properties: {} },
    })).toThrow(/property 'invalid'/);
    expect(() => planChange(db, {
      transactionId: transaction.id,
      ordinal: 0,
      position: { x: 0, y: Number.NaN, z: 0 },
      action: "dig",
      before: { name: "stone", properties: {} },
      intended: { name: "air", properties: {} },
    })).toThrow(/position/);
    expect(() => planChange(db, {
      transactionId: transaction.id,
      ordinal: 0,
      position: { x: 0, y: 64, z: 0 },
      action: "dig",
      before: {
        name: "stone",
        properties: Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [
            `property_${index}`,
            "x".repeat(MAX_PROPERTY_VALUE_LENGTH),
          ]),
        ),
      },
      intended: { name: "air", properties: {} },
    })).toThrow(new RegExp(`${MAX_SNAPSHOT_JSON_BYTES}|snapshot`));
  });
});

function installTransactionTables(database: DB): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS world_transactions (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_created             INTEGER NOT NULL,
      ts_updated             INTEGER NOT NULL,
      server_key             TEXT NOT NULL,
      dimension              TEXT NOT NULL,
      label                  TEXT NOT NULL,
      kind                   TEXT NOT NULL,
      actor_username         TEXT NOT NULL,
      actor_role             TEXT NOT NULL,
      actor_source           TEXT NOT NULL,
      status                 TEXT NOT NULL,
      task_plan_id           INTEGER,
      construction_job_id    INTEGER,
      budget_scope           TEXT NOT NULL,
      correlation_json       TEXT,
      requested_change_count INTEGER NOT NULL DEFAULT 0,
      applied_change_count   INTEGER NOT NULL DEFAULT 0,
      last_error             TEXT
    );
    CREATE TABLE IF NOT EXISTS world_changes (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id       INTEGER NOT NULL REFERENCES world_transactions(id) ON DELETE CASCADE,
      ordinal              INTEGER NOT NULL,
      x                    INTEGER NOT NULL,
      y                    INTEGER NOT NULL,
      z                    INTEGER NOT NULL,
      action               TEXT NOT NULL,
      before_json          TEXT NOT NULL,
      intended_json        TEXT NOT NULL,
      confirmed_after_json TEXT,
      status               TEXT NOT NULL,
      last_error           TEXT,
      ts_planned           INTEGER NOT NULL,
      ts_updated           INTEGER NOT NULL,
      UNIQUE(transaction_id, ordinal)
    );
  `);
}
