import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotBlock } from "../../../src/world/blockSnapshot.js";
import type { BlockMutationEvent } from "../../../src/world/blockExecutor.js";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import {
  createConstructionJob,
  upsertBlueprint,
} from "../../../src/construction/store.js";
import {
  getTransaction,
  planChange,
} from "../../../src/world/transactions/store.js";
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

const actor = { username: "Builder", role: "operator" as const, source: "minecraft-chat" as const };

function service() {
  return createWorldTransactionService({ db, now: vi.fn(() => 100) });
}

function event(name = "stone"): BlockMutationEvent {
  return {
    action: "place",
    position: { x: 4, y: 65, z: -7 },
    before: snapshotBlock({
      name: "air", position: { x: 4, y: 65, z: -7 }, boundingBox: "empty", diggable: false,
      getProperties: () => ({}),
    }),
    intended: { name },
  };
}

describe("world transaction service", () => {
  it("writes planned and confirmed states through a fresh executor hook closure", () => {
    const transactions = service();
    const transaction = transactions.begin({
      serverKey: "example.test:25565",
      dimension: "overworld",
      label: "place marker",
      kind: "atomic-place",
      actor,
    });
    const hooks = transactions.createMutationHooks({
      transactionId: transaction.id,
      ordinal: 0,
      maxWorldChanges: 1,
    });
    const planned = event();
    expect(hooks.planned?.(planned)).toBeUndefined();
    hooks.applied?.({
      ...planned,
      intended: snapshotBlock({
        name: "stone", stateId: 1, position: planned.position, boundingBox: "block", diggable: true,
        getProperties: () => ({ axis: "y" }),
      }),
    });

    expect(getTransaction(db, transaction.id)).toMatchObject({
      requestedChangeCount: 1,
      appliedChangeCount: 1,
      changes: [{ status: "applied", confirmedAfter: { name: "stone", properties: { axis: "y" } } }],
    });
    expect(transactions.complete(transaction.id)).toMatchObject({ status: "completed" });
  });

  it("uses a canonical construction ordinal only with an open construction attempt", () => {
    const blueprint = upsertBlueprint(db, {
      name: "journal-ordinal-test",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 64,
      originZ: 0,
    });
    const transactions = service();
    const attempt = transactions.beginOrReuseConstructionAttempt({
      serverKey: "example.test:25565",
      dimension: "overworld",
      constructionJobId: job.id,
      actor,
      label: "build journal ordinal test",
    });

    const hooks = transactions.createConstructionMutationHooks({
      transactionId: attempt.id,
      // This is the canonical placement-unit index, not `placed` for this run.
      ordinal: 23,
    });
    const planned = event();
    hooks.planned?.(planned);
    hooks.applied?.({
      ...planned,
      intended: snapshotBlock({
        name: "stone", position: planned.position, boundingBox: "block", diggable: true,
        getProperties: () => ({}),
      }),
    });
    expect(getTransaction(db, attempt.id)).toMatchObject({
      kind: "construction",
      constructionJobId: job.id,
      changes: [{ ordinal: 23, status: "applied" }],
    });

    const ordinary = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "atomic-place", actor,
    });
    expect(() => transactions.createConstructionMutationHooks({
      transactionId: ordinary.id,
      ordinal: 0,
    })).toThrow(/not a construction attempt/);
    expect(() => transactions.createConstructionMutationHooks({
      transactionId: attempt.id,
      ordinal: -1,
    })).toThrow(/construction mutation ordinal/);
  });

  it("rejects a budget before Mineflayer without adding a journal failure row", () => {
    const transactions = service();
    const transaction = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "atomic-place", actor,
    });
    const first = transactions.createMutationHooks({
      transactionId: transaction.id, ordinal: 0, maxWorldChanges: 1,
    });
    expect(first.planned?.(event())).toBeUndefined();

    const second = transactions.createMutationHooks({
      transactionId: transaction.id, ordinal: 1, maxWorldChanges: 1,
    });
    expect(second.planned?.(event())).toMatchObject({
      ok: false,
      code: "BUDGET_EXCEEDED",
      recoverable: false,
      details: { limit: 1, reserved: 1 },
    });
    expect(getTransaction(db, transaction.id)).toMatchObject({
      requestedChangeCount: 1,
      changes: [{ status: "planned" }],
    });
  });

  it("preflights an entire requested operation against its shared budget scope", () => {
    const transactions = service();
    const first = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "atomic-dig", actor,
      budgetScope: "mission:42",
    });
    const hooks = transactions.createMutationHooks({
      transactionId: first.id, ordinal: 0, maxWorldChanges: 3,
    });
    hooks.planned?.(event());

    const second = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "clear-region", actor,
      budgetScope: "mission:42",
    });
    expect(transactions.preflightWorldChanges({
      transactionId: second.id,
      maxWorldChanges: 3,
      requestedChanges: 3,
    })).toMatchObject({
      ok: false,
      code: "BUDGET_EXCEEDED",
      details: { limit: 3, reserved: 1, requested: 3 },
    });
    expect(transactions.preflightWorldChanges({
      transactionId: second.id,
      maxWorldChanges: 3,
      requestedChanges: 2,
    })).toMatchObject({ ok: true, reserved: 1, requested: 2, limit: 3 });
  });

  it("reserves observed conflicts but releases unconfirmed reconciliation conflicts", () => {
    const transactions = service();

    const observed = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "atomic-place", actor,
      budgetScope: "mission:observed-conflict",
    });
    const observedHooks = transactions.createMutationHooks({
      transactionId: observed.id, ordinal: 0, maxWorldChanges: 1,
    });
    const observedEvent = event();
    observedHooks.planned?.(observedEvent);
    observedHooks.conflicted?.({
      ...observedEvent,
      after: snapshotBlock({
        name: "dirt", position: observedEvent.position, boundingBox: "block", diggable: true,
        getProperties: () => ({}),
      }),
      code: "STALE_STATE",
      summary: "placement changed the target to dirt instead of stone",
    });

    const blocked = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "atomic-place", actor,
      budgetScope: "mission:observed-conflict",
    });
    expect(transactions.createMutationHooks({
      transactionId: blocked.id, ordinal: 0, maxWorldChanges: 1,
    }).planned?.(event())).toMatchObject({
      ok: false,
      code: "BUDGET_EXCEEDED",
      details: { limit: 1, reserved: 1 },
    });
    expect(getTransaction(db, observed.id)).toMatchObject({
      changes: [{ status: "conflict", confirmedAfter: { name: "dirt" } }],
    });

    const reconciled = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "atomic-place", actor,
      budgetScope: "mission:reconciled-conflict",
    });
    const reconciledEvent = event();
    planChange(db, {
      transactionId: reconciled.id,
      ordinal: 0,
      position: reconciledEvent.position,
      action: reconciledEvent.action,
      before: reconciledEvent.before,
      intended: reconciledEvent.intended,
    });
    expect(transactions.reconcileLive({
      serverKey: "example.test:25565",
      dimension: "overworld",
      inspect: () => ({ name: "dirt", properties: {} }),
    })).toMatchObject({ conflicts: 1 });
    expect(getTransaction(db, reconciled.id)).toMatchObject({
      changes: [{ status: "conflict", confirmedAfter: null }],
    });

    const released = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "atomic-place", actor,
      budgetScope: "mission:reconciled-conflict",
    });
    expect(transactions.createMutationHooks({
      transactionId: released.id, ordinal: 0, maxWorldChanges: 1,
    }).planned?.(event())).toBeUndefined();
  });

  it("records executor failure after planning without downgrading an applied change", () => {
    const transactions = service();
    const transaction = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "atomic-place", actor,
    });
    const hooks = transactions.createMutationHooks({ transactionId: transaction.id, ordinal: 0 });
    const planned = event();
    hooks.planned?.(planned);
    hooks.failed?.({ ...planned, code: "STALE_STATE", summary: "placement verification failed" });
    expect(transactions.complete(transaction.id)).toMatchObject({ status: "failed" });

    const appliedTransaction = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "atomic-place", actor,
    });
    const appliedHooks = transactions.createMutationHooks({ transactionId: appliedTransaction.id, ordinal: 0 });
    appliedHooks.planned?.(planned);
    appliedHooks.applied?.({
      ...planned,
      intended: snapshotBlock({
        name: "stone", position: planned.position, boundingBox: "block", diggable: true,
        getProperties: () => ({}),
      }),
    });
    appliedHooks.failed?.({ ...planned, code: "UNKNOWN", summary: "late journal signal" });
    expect(getTransaction(db, appliedTransaction.id)?.changes[0]).toMatchObject({ status: "applied" });
  });

  it("reconciles only matching server/dimension records using live snapshots", () => {
    const transactions = service();
    const transaction = transactions.begin({
      serverKey: "example.test:25565", dimension: "overworld", kind: "recovery", actor,
    });
    for (const [ordinal, x] of [[0, 0], [1, 1], [2, 2]] as const) {
      planChange(db, {
        transactionId: transaction.id,
        ordinal,
        position: { x, y: 64, z: 0 },
        action: "place",
        before: { name: "air", properties: {} },
        intended: { name: "stone", properties: {} },
      });
    }
    const otherServer = transactions.begin({
      serverKey: "other.test:25565", dimension: "overworld", kind: "recovery", actor,
    });
    planChange(db, {
      transactionId: otherServer.id, ordinal: 0, position: { x: 9, y: 64, z: 0 }, action: "place",
      before: { name: "air", properties: {} }, intended: { name: "stone", properties: {} },
    });
    const inspect = vi.fn((position: { x: number }) => {
      if (position.x === 0) return { name: "stone", properties: {} };
      if (position.x === 1) return { name: "air", properties: {} };
      return { name: "dirt", properties: {} };
    });

    const result = transactions.reconcileLive({
      serverKey: "example.test:25565", dimension: "overworld", inspect,
    });

    expect(result).toMatchObject({ applied: 1, failed: 1, conflicts: 1, unavailable: 0, finalized: 1 });
    expect(getTransaction(db, transaction.id)).toMatchObject({
      status: "partial",
      changes: [
        { status: "applied" },
        { status: "failed" },
        { status: "conflict" },
      ],
    });
    expect(getTransaction(db, otherServer.id)).toMatchObject({ status: "open", changes: [{ status: "planned" }] });
    expect(inspect).not.toHaveBeenCalledWith(expect.objectContaining({ x: 9 }));
  });

  it("paginates scoped recovery without inspecting a different server", () => {
    const transactions = service();
    for (const x of [0, 1, 2]) {
      const transaction = transactions.begin({
        serverKey: "EXAMPLE.TEST:25565", dimension: "overworld", kind: "recovery", actor,
      });
      planChange(db, {
        transactionId: transaction.id, ordinal: 0, position: { x, y: 64, z: 0 }, action: "place",
        before: { name: "air", properties: {} }, intended: { name: "stone", properties: {} },
      });
    }
    const inspected: number[] = [];
    const first = transactions.reconcileLive({
      serverKey: "example.test:25565", dimension: "overworld", limit: 2,
      inspect: (position) => {
        inspected.push(position.x);
        return { name: "stone", properties: {} };
      },
    });
    expect(first).toMatchObject({ transactionsVisited: 2, finalized: 2, nextTransactionId: expect.any(Number) });
    const second = transactions.reconcileLive({
      serverKey: "example.test:25565", dimension: "overworld", limit: 2,
      afterTransactionId: first.nextTransactionId!,
      inspect: (position) => {
        inspected.push(position.x);
        return { name: "stone", properties: {} };
      },
    });
    expect(second).toMatchObject({ transactionsVisited: 1, finalized: 1, nextTransactionId: null });
    expect(inspected.sort()).toEqual([0, 1, 2]);
  });
});
