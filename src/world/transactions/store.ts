import type { DB } from "../../memory/db.js";
import {
  snapshotExecutionActor,
  type ExecutionActor,
} from "../../permissions/executionActor.js";
import type { BlockPropertyValue } from "../blockSnapshot.js";
import type { BlockPosition } from "../types.js";
import type {
  BeginConstructionAttemptInput,
  BeginWorldTransactionInput,
  ConstructionMutationHistory,
  FindUnresolvedConstructionAttemptInput,
  ListConstructionMutationHistoryInput,
  ListOpenWorldTransactionsInput,
  ListWorldTransactionsInput,
  PlanWorldChangeInput,
  WorldBlockSnapshot,
  WorldBlockSnapshotInput,
  WorldChangeAction,
  WorldChangeRow,
  WorldChangeStatus,
  WorldTransactionDetail,
  WorldTransactionRow,
  WorldTransactionStatus,
} from "./types.js";

/** Bounded payload caps for the durable, renderer-safe world journal. */
export const MAX_SNAPSHOT_JSON_BYTES = 4 * 1024;
export const MAX_CORRELATION_JSON_BYTES = 16 * 1024;
export const MAX_PROPERTY_COUNT = 32;
export const MAX_PROPERTY_KEY_LENGTH = 64;
export const MAX_PROPERTY_VALUE_LENGTH = 128;
export const MAX_LABEL_LENGTH = 256;
export const MAX_KIND_LENGTH = 64;
export const MAX_ERROR_LENGTH = 1_024;
/**
 * Safety cap for one position-deduplicated historical construction scan.
 * This caps only distinct live coordinates, never the number of raw retry
 * rows, so repeated failed/resumed attempts do not cause false ambiguity.
 */
export const MAX_CONSTRUCTION_HISTORY_POSITIONS = 131_072;

const TRANSACTION_STATUSES = new Set<WorldTransactionStatus>([
  "open", "completed", "partial", "failed", "cancelled", "undoing", "undone", "undo_partial",
]);
const CHANGE_STATUSES = new Set<WorldChangeStatus>([
  "planned", "applied", "failed", "conflict", "reverting", "reverted",
]);
const CHANGE_ACTIONS = new Set<WorldChangeAction>(["place", "dig", "replace"]);
const BOUNDING_BOXES = new Set<NonNullable<WorldBlockSnapshot["boundingBox"]>>([
  "block", "empty", "unknown",
]);

/** `kind` value reserved for the one journaled attempt behind a build job. */
export const CONSTRUCTION_TRANSACTION_KIND = "construction";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface TransactionDbRow {
  id: number;
  ts_created: number;
  ts_updated: number;
  server_key: string;
  dimension: string;
  label: string | null;
  kind: string;
  actor_username: string;
  actor_role: string;
  actor_source: string;
  status: string;
  task_plan_id: number | null;
  construction_job_id: number | null;
  budget_scope: string;
  correlation_json: string;
  requested_change_count: number;
  applied_change_count: number;
  last_error: string | null;
}

interface ChangeDbRow {
  id: number;
  transaction_id: number;
  ordinal: number;
  x: number;
  y: number;
  z: number;
  action: string;
  before_json: string;
  intended_json: string;
  confirmed_after_json: string | null;
  status: string;
  last_error: string | null;
  ts_planned: number;
  ts_updated: number;
}

interface Counts {
  total: number;
  planned: number;
  applied: number;
  failed: number;
  conflict: number;
  reverting: number;
  reverted: number;
}

interface NormalizedBeginTransactionInput {
  serverKey: string;
  dimension: string;
  label: string | null;
  kind: string;
  actor: ExecutionActor;
  taskPlanId: number | null;
  constructionJobId: number | null;
  budgetScope?: string;
  correlation: Readonly<Record<string, JsonValue>>;
}

interface NormalizedConstructionAttemptInput extends NormalizedBeginTransactionInput {
  kind: typeof CONSTRUCTION_TRANSACTION_KIND;
  constructionJobId: number;
}

/** A typed, non-retryable signal that the execution mutation cap is exhausted. */
export class WorldChangeBudgetError extends Error {
  readonly limit: number;
  readonly reserved: number;
  readonly requested: number;

  constructor(limit: number, reserved: number, requested = 1) {
    super(
      `world change budget ${limit} is exhausted: ${requested} requested change${requested === 1 ? "" : "s"} ` +
      `cannot fit after ${reserved} changes already planned or applied`,
    );
    this.name = "WorldChangeBudgetError";
    this.limit = limit;
    this.reserved = reserved;
    this.requested = requested;
  }
}

/**
 * A prior construction task plan left a click ambiguous. This is distinct
 * from a generic persistence failure: callers must wait for scoped live
 * reconciliation instead of scheduling another click for the same job.
 */
export class UnresolvedConstructionAttemptError extends Error {
  readonly transactionId: number;
  readonly constructionJobId: number;
  readonly taskPlanId: number | null;

  constructor(input: {
    transactionId: number;
    constructionJobId: number;
    taskPlanId: number | null;
  }) {
    super(
      `construction job ${input.constructionJobId} has unresolved planned changes in ` +
      `transaction ${input.transactionId}`,
    );
    this.name = "UnresolvedConstructionAttemptError";
    this.transactionId = input.transactionId;
    this.constructionJobId = input.constructionJobId;
    this.taskPlanId = input.taskPlanId;
  }
}

/**
 * Read the durable reservation count for one server/budget scope. Planned
 * entries are counted alongside confirmed entries because either one may have
 * changed the world already. This query intentionally has no mutation side
 * effects; `planChange` remains the atomic last-line guard at insertion time.
 */
export function countReservedWorldChanges(
  db: DB,
  input: { serverKey: string; budgetScope: string },
): number {
  const serverKey = normalizeWorldServerKey(input.serverKey);
  const budgetScope = normalizeShortString(input.budgetScope, "budget scope", 128);
  const row = db.prepare(
    `SELECT COUNT(*) AS count
     FROM world_changes c
     JOIN world_transactions t ON t.id = c.transaction_id
     WHERE t.server_key = ? AND t.budget_scope = ?
       AND (
         c.status IN ('planned', 'applied') OR
         (c.status = 'conflict' AND c.confirmed_after_json IS NOT NULL)
       )`,
  ).get(serverKey, budgetScope) as { count: number };
  return row.count;
}

export function beginTransaction(
  db: DB,
  input: BeginWorldTransactionInput,
  now = Date.now(),
): WorldTransactionDetail {
  const normalized = normalizeBeginInput(input);
  const timestamp = normalizeTimestamp(now);
  const insert = db.transaction(() => insertTransaction(db, normalized, timestamp));
  return insert();
}

/**
 * Atomically find the one open journal for a construction attempt or create
 * it. Terminal transactions deliberately do not qualify: a later retry gets
 * a fresh attempt while unresolved planned rows stay open for live recovery.
 *
 * SQLite has no unique index for this legacy schema shape, so the lookup and
 * insert share one database transaction. If a malformed/older database
 * already has two matching open attempts, fail closed instead of arbitrarily
 * attaching a build to one of them.
 */
export function beginOrReuseConstructionAttempt(
  db: DB,
  input: BeginConstructionAttemptInput,
  now = Date.now(),
): WorldTransactionDetail {
  const normalized = normalizeConstructionAttemptInput(input);
  const timestamp = normalizeTimestamp(now);
  const beginOrReuse = db.transaction(() => {
    // Inspect every open attempt for this live construction job inside the
    // same SQLite transaction as lookup/insert. A retry can use a fresh task
    // plan, but it cannot bypass a planned row created by an older plan.
    const openRows = db.prepare(
      `${transactionSelect()}
       WHERE server_key = ?
         AND dimension = ?
         AND kind = ?
         AND status = 'open'
         AND construction_job_id = ?
       ORDER BY id ASC`,
    ).all(
      normalized.serverKey,
      normalized.dimension,
      CONSTRUCTION_TRANSACTION_KIND,
      normalized.constructionJobId,
    ) as TransactionDbRow[];

    const rows = openRows.filter((row) => row.task_plan_id === normalized.taskPlanId);
    if (rows.length > 1) {
      throw new Error(
        "multiple open construction transactions match the same server, dimension, job, and task plan",
      );
    }

    for (const row of openRows) {
      if (row.task_plan_id === normalized.taskPlanId) continue;
      const counts = getCounts(db, row.id);
      if (counts.planned > 0) {
        throw new UnresolvedConstructionAttemptError({
          transactionId: row.id,
          constructionJobId: normalized.constructionJobId,
          taskPlanId: row.task_plan_id,
        });
      }
      // An old process can die after it writes applied/failed change rows but
      // before it terminalizes the attempt. Finish that resolved old attempt
      // atomically before the new plan may create its own journal.
      updateTerminalTransaction(db, toTransaction(row), counts, timestamp);
    }

    if (rows.length === 1) {
      const existing = toTransaction(rows[0]!);
      assertConstructionAttemptCompatibility(existing, normalized);
      return getTransaction(db, existing.id)!;
    }
    return insertTransaction(db, normalized, timestamp);
  });
  return beginOrReuse();
}

function insertTransaction(
  db: DB,
  normalized: NormalizedBeginTransactionInput,
  timestamp: number,
): WorldTransactionDetail {
  const result = db.prepare(
    `INSERT INTO world_transactions (
      ts_created, ts_updated, server_key, dimension, label, kind,
      actor_username, actor_role, actor_source,
      status, task_plan_id, construction_job_id, budget_scope, correlation_json,
      requested_change_count, applied_change_count, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 0, 0, NULL)`,
  ).run(
    timestamp,
    timestamp,
    normalized.serverKey,
    normalized.dimension,
    normalized.label,
    normalized.kind,
    normalized.actor.username,
    normalized.actor.role,
    normalized.actor.source,
    normalized.taskPlanId,
    normalized.constructionJobId,
    normalized.budgetScope ?? "pending",
    JSON.stringify(normalized.correlation),
  );
  const id = Number(result.lastInsertRowid);
  if (normalized.budgetScope === undefined) {
    db.prepare("UPDATE world_transactions SET budget_scope = ? WHERE id = ?")
      .run(`transaction:${id}`, id);
  }
  const transaction = getTransaction(db, id);
  if (!transaction) throw new Error("world transaction insert did not persist");
  return transaction;
}

function assertConstructionAttemptCompatibility(
  existing: WorldTransactionRow,
  requested: NormalizedConstructionAttemptInput,
): void {
  // Server/dimension/job/plan/kind are filtered in SQL. Actor and an explicitly
  // selected budget scope are immutable journal context, so never let a later
  // caller silently inherit a differently authorized or differently bounded
  // attempt.
  if (existing.actor.username !== requested.actor.username ||
      existing.actor.role !== requested.actor.role ||
      existing.actor.source !== requested.actor.source) {
    throw new Error(
      `open construction transaction ${existing.id} has different immutable actor provenance`,
    );
  }
  if (requested.budgetScope !== undefined && existing.budgetScope !== requested.budgetScope) {
    throw new Error(
      `open construction transaction ${existing.id} has a different budget scope`,
    );
  }
}

/**
 * Persist a change immediately before Mineflayer mutates. The optional budget
 * is checked in the same SQLite write transaction as the insertion.
 */
export function planChange(
  db: DB,
  input: PlanWorldChangeInput,
  now = Date.now(),
): WorldChangeRow {
  const normalized = normalizePlanInput(input);
  const timestamp = normalizeTimestamp(now);
  const plan = db.transaction(() => {
    const transaction = getTransactionRow(db, normalized.transactionId);
    if (!transaction) throw new Error(`world transaction ${normalized.transactionId} does not exist`);
    if (transaction.status !== "open") {
      throw new Error(`world transaction ${normalized.transactionId} is not open`);
    }
    const duplicate = db.prepare(
      "SELECT id FROM world_changes WHERE transaction_id = ? AND ordinal = ?",
    ).get(normalized.transactionId, normalized.ordinal) as { id: number } | undefined;
    if (duplicate) {
      throw new Error(`world transaction ${normalized.transactionId} already has change ordinal ${normalized.ordinal}`);
    }
    const reserved = countReservedWorldChanges(db, {
      serverKey: transaction.server_key,
      budgetScope: transaction.budget_scope,
    });
    if (normalized.maxWorldChanges !== undefined && reserved >= normalized.maxWorldChanges) {
      throw new WorldChangeBudgetError(normalized.maxWorldChanges, reserved);
    }
    const result = db.prepare(
      `INSERT INTO world_changes (
        transaction_id, ordinal, x, y, z, action,
        before_json, intended_json, confirmed_after_json,
        status, last_error, ts_planned, ts_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'planned', NULL, ?, ?)`,
    ).run(
      normalized.transactionId,
      normalized.ordinal,
      normalized.position.x,
      normalized.position.y,
      normalized.position.z,
      normalized.action,
      JSON.stringify(normalized.before),
      JSON.stringify(normalized.intended),
      timestamp,
      timestamp,
    );
    db.prepare(
      `UPDATE world_transactions
       SET requested_change_count = requested_change_count + 1, ts_updated = ?
       WHERE id = ?`,
    ).run(timestamp, normalized.transactionId);
    const change = getWorldChange(db, Number(result.lastInsertRowid));
    if (!change) throw new Error("world change insert did not persist");
    return change;
  });
  return plan();
}

/** Confirm a verified Mineflayer mutation. An identical duplicate is idempotent. */
export function markChangeApplied(
  db: DB,
  changeId: number,
  confirmedAfter: WorldBlockSnapshotInput,
  now = Date.now(),
): WorldChangeRow | undefined {
  assertPositiveId("change id", changeId);
  const after = normalizeSnapshot(confirmedAfter, "confirmed after snapshot");
  const timestamp = normalizeTimestamp(now);
  const apply = db.transaction(() => {
    const change = getWorldChange(db, changeId);
    if (!change) return undefined;
    if (change.status === "applied") {
      if (!change.confirmedAfter || !sameSnapshot(change.confirmedAfter, after)) {
        throw new Error(`world change ${changeId} already has a different confirmed state`);
      }
      return change;
    }
    if (change.status !== "planned") {
      throw new Error(`world change ${changeId} cannot transition from ${change.status} to applied`);
    }
    db.prepare(
      `UPDATE world_changes
       SET status = 'applied', confirmed_after_json = ?, last_error = NULL, ts_updated = ?
       WHERE id = ?`,
    ).run(JSON.stringify(after), timestamp, changeId);
    refreshAppliedCount(db, change.transactionId, timestamp);
    return getWorldChange(db, changeId);
  });
  return apply();
}

/** Mark a planned change failed. Applied records are deliberately never downgraded. */
export function markChangeFailed(
  db: DB,
  changeId: number,
  error: string,
  now = Date.now(),
): boolean {
  return markPlannedChangeStatus(db, changeId, "failed", error, now);
}

/** Used by live reconciliation when a loaded block differs from both known states. */
export function markChangeConflict(
  db: DB,
  changeId: number,
  error: string,
  now = Date.now(),
): boolean {
  return markPlannedChangeStatus(db, changeId, "conflict", error, now);
}

/**
 * Persist an observed post-click state that differs from the intended state.
 * The change is terminal `conflict`, but `confirmedAfter` preserves the real
 * world mutation for audit/recovery instead of falsely calling it failed.
 */
export function markChangeConflictedAfter(
  db: DB,
  changeId: number,
  confirmedAfter: WorldBlockSnapshotInput,
  error: string,
  now = Date.now(),
): WorldChangeRow | undefined {
  assertPositiveId("change id", changeId);
  const after = normalizeSnapshot(confirmedAfter, "conflicted after snapshot");
  const normalizedError = normalizeError(error);
  const timestamp = normalizeTimestamp(now);
  const mark = db.transaction(() => {
    const change = getWorldChange(db, changeId);
    if (!change) return undefined;
    if (change.status === "conflict") {
      if (!change.confirmedAfter || !sameSnapshot(change.confirmedAfter, after)) {
        throw new Error(`world change ${changeId} already has a different conflicted state`);
      }
      return change;
    }
    if (change.status !== "planned") return undefined;
    db.prepare(
      `UPDATE world_changes
       SET status = 'conflict', confirmed_after_json = ?, last_error = ?, ts_updated = ?
       WHERE id = ?`,
    ).run(JSON.stringify(after), normalizedError, timestamp, changeId);
    db.prepare(
      `UPDATE world_transactions
       SET ts_updated = ?, last_error = COALESCE(last_error, ?)
       WHERE id = ?`,
    ).run(timestamp, normalizedError, change.transactionId);
    return getWorldChange(db, changeId);
  });
  return mark();
}

/** Complete an open transaction only after every planned mutation is resolved. */
export function completeTransaction(
  db: DB,
  transactionId: number,
  now = Date.now(),
): WorldTransactionDetail | undefined {
  assertPositiveId("transaction id", transactionId);
  const timestamp = normalizeTimestamp(now);
  const complete = db.transaction(() => {
    const transaction = getTransaction(db, transactionId);
    if (!transaction) return undefined;
    if (transaction.status !== "open") return transaction;
    const counts = getCounts(db, transactionId);
    if (counts.planned > 0) {
      throw new Error(`world transaction ${transactionId} still has ${counts.planned} planned changes`);
    }
    updateTerminalTransaction(db, transaction, counts, timestamp);
    return getTransaction(db, transactionId);
  });
  return complete();
}

/** Cancellation records an interrupted attempt without pretending planned work succeeded. */
export function cancelTransaction(
  db: DB,
  transactionId: number,
  error?: string,
  now = Date.now(),
): WorldTransactionDetail | undefined {
  assertPositiveId("transaction id", transactionId);
  const timestamp = normalizeTimestamp(now);
  const normalizedError = error === undefined ? null : normalizeError(error);
  const cancel = db.transaction(() => {
    const transaction = getTransaction(db, transactionId);
    if (!transaction) return undefined;
    if (transaction.status !== "open") return transaction;
    const counts = getCounts(db, transactionId);
    // A planned record may represent a mutation that happened immediately
    // before cancellation/process loss. Keep it open for the scoped live
    // inspection pass instead of claiming a terminal outcome.
    const status: WorldTransactionStatus = counts.planned > 0
      ? "open"
      : counts.applied > 0 || counts.conflict > 0
        ? "partial"
        : "cancelled";
    db.prepare(
      `UPDATE world_transactions
       SET status = ?, ts_updated = ?, last_error = COALESCE(?, last_error)
       WHERE id = ?`,
    ).run(status, timestamp, normalizedError, transactionId);
    return getTransaction(db, transactionId);
  });
  return cancel();
}

/**
 * Start or resume an explicit undo attempt. No world inspection or mutation
 * happens here; the caller must preview and verify each cell before invoking
 * the shared executor. An existing `undoing` attempt is idempotently reused.
 */
export function beginUndoTransaction(
  db: DB,
  transactionId: number,
  now = Date.now(),
): WorldTransactionDetail | undefined {
  assertPositiveId("transaction id", transactionId);
  const timestamp = normalizeTimestamp(now);
  const begin = db.transaction(() => {
    const transaction = getTransaction(db, transactionId);
    if (!transaction) return undefined;
    if (transaction.status === "undone" || transaction.status === "undoing") return transaction;
    if (transaction.status !== "completed" && transaction.status !== "partial" && transaction.status !== "undo_partial") {
      throw new Error(`world transaction ${transactionId} cannot be undone from ${transaction.status}`);
    }
    const counts = getCounts(db, transactionId);
    if (transaction.status === "undo_partial" && counts.applied === 0) return transaction;
    if (counts.planned > 0 || counts.reverting > 0) {
      if (transaction.status === "undo_partial") return transaction;
      throw new Error(`world transaction ${transactionId} has unresolved changes and cannot start undo`);
    }
    if (counts.applied === 0) {
      db.prepare(
        `UPDATE world_transactions SET status = 'undone', ts_updated = ?, last_error = NULL WHERE id = ?`,
      ).run(timestamp, transactionId);
    } else {
      db.prepare(
        `UPDATE world_transactions SET status = 'undoing', ts_updated = ? WHERE id = ?`,
      ).run(timestamp, transactionId);
    }
    return getTransaction(db, transactionId);
  });
  return begin();
}

/** Mark one original applied change as the cell currently being reverted. */
export function markChangeReverting(
  db: DB,
  changeId: number,
  now = Date.now(),
): WorldChangeRow | undefined {
  return markUndoChangeStatus(db, changeId, "reverting", now);
}

/** Mark one undo mutation as verified against the original before snapshot. */
export function markChangeReverted(
  db: DB,
  changeId: number,
  now = Date.now(),
): WorldChangeRow | undefined {
  return markUndoChangeStatus(db, changeId, "reverted", now);
}

/** Preserve an external edit or unsupported reversal as an undo conflict. */
export function markChangeUndoConflict(
  db: DB,
  changeId: number,
  error: string,
  now = Date.now(),
): WorldChangeRow | undefined {
  assertPositiveId("change id", changeId);
  const normalizedError = normalizeError(error);
  const timestamp = normalizeTimestamp(now);
  const mark = db.transaction(() => {
    const change = getWorldChange(db, changeId);
    if (!change) return undefined;
    if (change.status === "conflict") return change;
    if (change.status !== "reverting") return undefined;
    db.prepare(
      `UPDATE world_changes SET status = 'conflict', last_error = ?, ts_updated = ? WHERE id = ?`,
    ).run(normalizedError, timestamp, changeId);
    db.prepare(
      `UPDATE world_transactions SET status = 'undo_partial', last_error = ?, ts_updated = ? WHERE id = ?`,
    ).run(normalizedError, timestamp, change.transactionId);
    return getWorldChange(db, changeId);
  });
  return mark();
}

/** Finish an undo pass, retaining a partial state when any applied cell remains. */
export function finalizeUndoTransaction(
  db: DB,
  transactionId: number,
  now = Date.now(),
): WorldTransactionDetail | undefined {
  assertPositiveId("transaction id", transactionId);
  const timestamp = normalizeTimestamp(now);
  const finish = db.transaction(() => {
    const transaction = getTransaction(db, transactionId);
    if (!transaction) return undefined;
    if (transaction.status === "undone") return transaction;
    const counts = getCounts(db, transactionId);
    if (counts.planned > 0 || counts.reverting > 0) {
      db.prepare(
        `UPDATE world_transactions SET status = 'undoing', ts_updated = ? WHERE id = ?`,
      ).run(timestamp, transactionId);
    } else {
      const status: WorldTransactionStatus = counts.applied === 0 && counts.conflict === 0
        ? "undone"
        : "undo_partial";
      db.prepare(
        `UPDATE world_transactions SET status = ?, ts_updated = ?, last_error = ? WHERE id = ?`,
      ).run(status, timestamp, status === "undone" ? null : latestChangeError(db, transactionId), transactionId);
    }
    return getTransaction(db, transactionId);
  });
  return finish();
}

export function getTransaction(db: DB, transactionId: number): WorldTransactionDetail | undefined {
  assertPositiveId("transaction id", transactionId);
  const row = getTransactionRow(db, transactionId);
  if (!row) return undefined;
  return Object.freeze({
    ...toTransaction(row),
    changes: Object.freeze(getWorldChangesForTransaction(db, transactionId)),
  });
}

export function getWorldChange(db: DB, changeId: number): WorldChangeRow | undefined {
  assertPositiveId("change id", changeId);
  const row = db.prepare(
    `SELECT id, transaction_id, ordinal, x, y, z, action,
            before_json, intended_json, confirmed_after_json,
            status, last_error, ts_planned, ts_updated
     FROM world_changes WHERE id = ?`,
  ).get(changeId) as ChangeDbRow | undefined;
  return row ? toChange(row) : undefined;
}

export function listTransactions(
  db: DB,
  input: ListWorldTransactionsInput = {},
): WorldTransactionRow[] {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("transaction list limit must be an integer from 1 through 100");
  }
  if (input.status !== undefined && !TRANSACTION_STATUSES.has(input.status)) {
    throw new Error("unknown world transaction status");
  }
  const serverKey = input.serverKey === undefined ? undefined : normalizeWorldServerKey(input.serverKey);
  const dimension = input.dimension === undefined ? undefined : normalizeShortString(input.dimension, "dimension", 128);
  let rows: TransactionDbRow[];
  if (serverKey !== undefined && dimension !== undefined && input.status !== undefined) {
    rows = db.prepare(`${transactionSelect()} WHERE server_key = ? AND dimension = ? AND status = ? ORDER BY ts_created DESC, id DESC LIMIT ?`)
      .all(serverKey, dimension, input.status, limit) as TransactionDbRow[];
  } else if (serverKey !== undefined && dimension !== undefined) {
    rows = db.prepare(`${transactionSelect()} WHERE server_key = ? AND dimension = ? ORDER BY ts_created DESC, id DESC LIMIT ?`)
      .all(serverKey, dimension, limit) as TransactionDbRow[];
  } else if (serverKey !== undefined && input.status !== undefined) {
    rows = db.prepare(`${transactionSelect()} WHERE server_key = ? AND status = ? ORDER BY ts_created DESC, id DESC LIMIT ?`)
      .all(serverKey, input.status, limit) as TransactionDbRow[];
  } else if (serverKey !== undefined) {
    rows = db.prepare(`${transactionSelect()} WHERE server_key = ? ORDER BY ts_created DESC, id DESC LIMIT ?`)
      .all(serverKey, limit) as TransactionDbRow[];
  } else if (dimension !== undefined && input.status !== undefined) {
    rows = db.prepare(`${transactionSelect()} WHERE dimension = ? AND status = ? ORDER BY ts_created DESC, id DESC LIMIT ?`)
      .all(dimension, input.status, limit) as TransactionDbRow[];
  } else if (dimension !== undefined) {
    rows = db.prepare(`${transactionSelect()} WHERE dimension = ? ORDER BY ts_created DESC, id DESC LIMIT ?`)
      .all(dimension, limit) as TransactionDbRow[];
  } else if (input.status !== undefined) {
    rows = db.prepare(`${transactionSelect()} WHERE status = ? ORDER BY ts_created DESC, id DESC LIMIT ?`)
      .all(input.status, limit) as TransactionDbRow[];
  } else {
    rows = db.prepare(`${transactionSelect()} ORDER BY ts_created DESC, id DESC LIMIT ?`)
      .all(limit) as TransactionDbRow[];
  }
  return rows.map(toTransaction);
}

/**
 * Bounded cursor query used only by reconnect recovery. It includes complete
 * change details so callers never need to infer a mutation state from a list
 * summary, and it is scoped to one exact server/dimension pair.
 */
export function listOpenTransactionsForReconciliation(
  db: DB,
  input: ListOpenWorldTransactionsInput,
): WorldTransactionDetail[] {
  const serverKey = normalizeWorldServerKey(input.serverKey);
  const dimension = normalizeShortString(input.dimension, "dimension", 128);
  const afterId = input.afterId ?? 0;
  if (!Number.isSafeInteger(afterId) || afterId < 0) {
    throw new Error("reconciliation cursor must be a non-negative integer");
  }
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("reconciliation limit must be an integer from 1 through 100");
  }
  const rows = db.prepare(
    `${transactionSelect()}
     WHERE server_key = ? AND dimension = ? AND status = 'open' AND id > ?
     ORDER BY id ASC LIMIT ?`,
  ).all(serverKey, dimension, afterId, limit) as TransactionDbRow[];
  return rows.map((row) => getTransaction(db, row.id)!).filter(Boolean);
}

/**
 * Find one unresolved construction click for an exact live job scope.
 *
 * A construction job may be retried through a fresh task plan, but a planned
 * row from any prior plan can represent a packet sent immediately before a
 * crash. The new plan must wait for scoped live reconciliation rather than
 * creating a second mutation attempt at the same build.
 */
export function findUnresolvedConstructionAttempt(
  db: DB,
  input: FindUnresolvedConstructionAttemptInput,
): WorldTransactionDetail | undefined {
  const serverKey = normalizeWorldServerKey(input.serverKey);
  const dimension = normalizeShortString(input.dimension, "dimension", 128);
  const constructionJobId = optionalPositiveId("construction job id", input.constructionJobId);
  if (constructionJobId === null) throw new Error("construction job id must be a positive integer");
  const row = db.prepare(
    `${transactionSelect()} t
     WHERE t.server_key = ?
       AND t.dimension = ?
       AND t.kind = ?
       AND t.status = 'open'
       AND t.construction_job_id = ?
       AND EXISTS (
         SELECT 1 FROM world_changes c
         WHERE c.transaction_id = t.id AND c.status = 'planned'
       )
     ORDER BY t.id ASC
     LIMIT 1`,
  ).get(
    serverKey,
    dimension,
    CONSTRUCTION_TRANSACTION_KIND,
    constructionJobId,
  ) as TransactionDbRow | undefined;
  return row ? getTransaction(db, row.id) : undefined;
}

/**
 * Read the latest successfully applied construction mutation at every affected
 * coordinate. This is intentionally not a general raw audit listing: the
 * window query collapses arbitrary retry history before applying its bounded
 * result cap.
 *
 * In particular, a failed/conflicted cleanup never masks an earlier applied
 * scaffold placement. The caller can therefore re-read that live coordinate
 * and fail closed instead of guessing whether an identical block is still
 * SmartBot-owned.
 */
export function listConstructionMutationHistory(
  db: DB,
  input: ListConstructionMutationHistoryInput,
): ConstructionMutationHistory {
  const serverKey = normalizeWorldServerKey(input.serverKey);
  const dimension = normalizeShortString(input.dimension, "dimension", 128);
  const constructionJobId = optionalPositiveId("construction job id", input.constructionJobId);
  if (constructionJobId === null) throw new Error("construction job id must be a positive integer");
  const minOrdinal = input.minOrdinal ?? 0;
  if (!Number.isSafeInteger(minOrdinal) || minOrdinal < 0) {
    throw new Error("construction history minimum ordinal must be a non-negative integer");
  }
  const rows = db.prepare(
    `WITH latest_applied AS (
       SELECT c.id, c.transaction_id, c.ordinal, c.x, c.y, c.z, c.action,
              c.before_json, c.intended_json, c.confirmed_after_json,
              c.status, c.last_error, c.ts_planned, c.ts_updated,
              ROW_NUMBER() OVER (
                PARTITION BY c.x, c.y, c.z
                ORDER BY c.ts_updated DESC, c.id DESC
              ) AS position_rank
       FROM world_changes c
       JOIN world_transactions t ON t.id = c.transaction_id
       WHERE t.server_key = ?
         AND t.dimension = ?
         AND t.kind = ?
         AND t.construction_job_id = ?
         AND c.ordinal >= ?
         AND c.status = 'applied'
     )
     SELECT id, transaction_id, ordinal, x, y, z, action,
            before_json, intended_json, confirmed_after_json,
            status, last_error, ts_planned, ts_updated
     FROM latest_applied
     WHERE position_rank = 1
     ORDER BY ts_updated ASC, id ASC
     LIMIT ?`,
  ).all(
    serverKey,
    dimension,
    CONSTRUCTION_TRANSACTION_KIND,
    constructionJobId,
    minOrdinal,
    MAX_CONSTRUCTION_HISTORY_POSITIONS + 1,
  ) as ChangeDbRow[];
  return Object.freeze({
    changes: Object.freeze(rows.slice(0, MAX_CONSTRUCTION_HISTORY_POSITIONS).map(toChange)),
    truncated: rows.length > MAX_CONSTRUCTION_HISTORY_POSITIONS,
  });
}

export function countAppliedChanges(db: DB, transactionId: number): number {
  assertPositiveId("transaction id", transactionId);
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM world_changes WHERE transaction_id = ? AND status = 'applied'",
  ).get(transactionId) as { count: number };
  return row.count;
}

/** Validate and strip a live Prismarine-derived snapshot for journal comparison. */
export function normalizeWorldBlockSnapshot(
  input: WorldBlockSnapshotInput,
  label = "block snapshot",
): WorldBlockSnapshot {
  return normalizeSnapshot(input, label);
}

/**
 * Startup-only reconciliation that never guesses about a still-planned world
 * mutation. Live inspection is deliberately handled by the transaction
 * service once a bot is connected to the matching server and dimension.
 */
export function reconcileOpenTransactions(db: DB, now = Date.now()): number {
  const timestamp = normalizeTimestamp(now);
  const reconcile = db.transaction(() => {
    const rows = db.prepare(
      `${transactionSelect()} WHERE status = 'open' ORDER BY id ASC`,
    ).all() as TransactionDbRow[];
    let reconciled = 0;
    for (const row of rows) {
      const transaction = toTransaction(row);
      const counts = getCounts(db, transaction.id);
      if (counts.planned > 0) continue;
      updateTerminalTransaction(db, transaction, counts, timestamp);
      reconciled++;
    }
    return reconciled;
  });
  return reconcile();
}

function markPlannedChangeStatus(
  db: DB,
  changeId: number,
  status: "failed" | "conflict",
  error: string,
  now: number,
): boolean {
  assertPositiveId("change id", changeId);
  const normalizedError = normalizeError(error);
  const timestamp = normalizeTimestamp(now);
  const mark = db.transaction(() => {
    const change = getWorldChange(db, changeId);
    if (!change) return false;
    if (change.status === "applied") return false;
    if (change.status === status) return true;
    if (change.status !== "planned") return false;
    db.prepare(
      `UPDATE world_changes SET status = ?, last_error = ?, ts_updated = ? WHERE id = ?`,
    ).run(status, normalizedError, timestamp, changeId);
    db.prepare(
      `UPDATE world_transactions
       SET ts_updated = ?, last_error = COALESCE(last_error, ?)
       WHERE id = ?`,
    ).run(timestamp, normalizedError, change.transactionId);
    return true;
  });
  return mark();
}

function markUndoChangeStatus(
  db: DB,
  changeId: number,
  status: "reverting" | "reverted",
  now: number,
): WorldChangeRow | undefined {
  assertPositiveId("change id", changeId);
  const timestamp = normalizeTimestamp(now);
  const mark = db.transaction(() => {
    const change = getWorldChange(db, changeId);
    if (!change) return undefined;
    if (change.status === status) return change;
    const allowed = status === "reverting"
      ? change.status === "applied" || change.status === "reverting"
      : change.status === "reverting";
    if (!allowed) return undefined;
    db.prepare(
      `UPDATE world_changes SET status = ?, last_error = NULL, ts_updated = ? WHERE id = ?`,
    ).run(status, timestamp, changeId);
    return getWorldChange(db, changeId);
  });
  return mark();
}

function updateTerminalTransaction(
  db: DB,
  transaction: WorldTransactionRow,
  counts: Counts,
  timestamp: number,
): void {
  const status = terminalStatus(counts);
  const lastError = counts.failed > 0 || counts.conflict > 0
    ? latestChangeError(db, transaction.id)
    : null;
  db.prepare(
    `UPDATE world_transactions
     SET status = ?, applied_change_count = ?, ts_updated = ?, last_error = ?
     WHERE id = ?`,
  ).run(status, counts.applied, timestamp, lastError, transaction.id);
}

function terminalStatus(counts: Counts): WorldTransactionStatus {
  if (counts.total === 0 || counts.applied === counts.total) return "completed";
  if (counts.applied > 0 || counts.conflict > 0) return "partial";
  return "failed";
}

function refreshAppliedCount(db: DB, transactionId: number, timestamp: number): void {
  const applied = countAppliedChanges(db, transactionId);
  db.prepare(
    "UPDATE world_transactions SET applied_change_count = ?, ts_updated = ? WHERE id = ?",
  ).run(applied, timestamp, transactionId);
}

function getCounts(db: DB, transactionId: number): Counts {
  return db.prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'planned' THEN 1 ELSE 0 END), 0) AS planned,
       COALESCE(SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END), 0) AS applied,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END), 0) AS conflict,
       COALESCE(SUM(CASE WHEN status = 'reverting' THEN 1 ELSE 0 END), 0) AS reverting,
       COALESCE(SUM(CASE WHEN status = 'reverted' THEN 1 ELSE 0 END), 0) AS reverted
     FROM world_changes WHERE transaction_id = ?`,
  ).get(transactionId) as Counts;
}

function latestChangeError(db: DB, transactionId: number): string | null {
  const row = db.prepare(
    `SELECT last_error FROM world_changes
     WHERE transaction_id = ? AND last_error IS NOT NULL
     ORDER BY ordinal DESC, id DESC LIMIT 1`,
  ).get(transactionId) as { last_error: string } | undefined;
  return row?.last_error ?? null;
}

function getTransactionRow(db: DB, transactionId: number): TransactionDbRow | undefined {
  return db.prepare(`${transactionSelect()} WHERE id = ?`).get(transactionId) as TransactionDbRow | undefined;
}

function getWorldChangesForTransaction(db: DB, transactionId: number): WorldChangeRow[] {
  const rows = db.prepare(
    `SELECT id, transaction_id, ordinal, x, y, z, action,
            before_json, intended_json, confirmed_after_json,
            status, last_error, ts_planned, ts_updated
     FROM world_changes WHERE transaction_id = ? ORDER BY ordinal ASC, id ASC`,
  ).all(transactionId) as ChangeDbRow[];
  return rows.map(toChange);
}

function transactionSelect(): string {
  return `SELECT id, ts_created, ts_updated, server_key, dimension, label, kind,
    actor_username, actor_role, actor_source, status, task_plan_id,
    construction_job_id, budget_scope, correlation_json, requested_change_count,
    applied_change_count, last_error FROM world_transactions`;
}

function toTransaction(row: TransactionDbRow): WorldTransactionRow {
  const status = parseTransactionStatus(row.status);
  return Object.freeze({
    id: row.id,
    tsCreated: row.ts_created,
    tsUpdated: row.ts_updated,
    serverKey: row.server_key,
    dimension: row.dimension,
    label: row.label,
    kind: row.kind,
    actor: snapshotExecutionActor({
      username: row.actor_username,
      role: row.actor_role,
      source: row.actor_source,
    }),
    status,
    taskPlanId: row.task_plan_id,
    constructionJobId: row.construction_job_id,
    budgetScope: row.budget_scope,
    correlation: parseCorrelation(row.correlation_json),
    requestedChangeCount: row.requested_change_count,
    appliedChangeCount: row.applied_change_count,
    lastError: row.last_error,
  });
}

function toChange(row: ChangeDbRow): WorldChangeRow {
  const action = parseAction(row.action);
  const status = parseChangeStatus(row.status);
  return Object.freeze({
    id: row.id,
    transactionId: row.transaction_id,
    ordinal: row.ordinal,
    position: Object.freeze({ x: row.x, y: row.y, z: row.z }),
    action,
    before: parseSnapshot(row.before_json, "stored before snapshot"),
    intended: parseSnapshot(row.intended_json, "stored intended snapshot"),
    confirmedAfter: row.confirmed_after_json === null
      ? null
      : parseSnapshot(row.confirmed_after_json, "stored confirmed snapshot"),
    status,
    lastError: row.last_error,
    tsPlanned: row.ts_planned,
    tsUpdated: row.ts_updated,
  });
}

function normalizeBeginInput(input: BeginWorldTransactionInput): NormalizedBeginTransactionInput {
  return {
    serverKey: normalizeWorldServerKey(input.serverKey),
    dimension: normalizeShortString(input.dimension, "dimension", 128),
    label: input.label === undefined ? null : normalizeShortString(input.label, "label", MAX_LABEL_LENGTH),
    kind: normalizeShortString(input.kind, "kind", MAX_KIND_LENGTH),
    actor: snapshotExecutionActor(input.actor),
    taskPlanId: optionalPositiveId("task plan id", input.taskPlanId),
    constructionJobId: optionalPositiveId("construction job id", input.constructionJobId),
    budgetScope: input.budgetScope === undefined
      ? undefined
      : normalizeShortString(input.budgetScope, "budget scope", 128),
    correlation: normalizeCorrelation(input.correlation ?? {}),
  };
}

function normalizeConstructionAttemptInput(
  input: BeginConstructionAttemptInput,
): NormalizedConstructionAttemptInput {
  const normalized = normalizeBeginInput({
    serverKey: input.serverKey,
    dimension: input.dimension,
    label: input.label,
    kind: CONSTRUCTION_TRANSACTION_KIND,
    actor: input.actor,
    taskPlanId: input.taskPlanId,
    constructionJobId: input.constructionJobId,
    budgetScope: input.budgetScope,
    correlation: input.correlation,
  });
  if (normalized.constructionJobId === null) {
    // This is redundant for the TypeScript surface but protects every durable
    // caller crossing an untyped IPC/tool boundary.
    throw new Error("construction job id must be a positive integer");
  }
  return {
    ...normalized,
    kind: CONSTRUCTION_TRANSACTION_KIND,
    constructionJobId: normalized.constructionJobId,
  };
}

function normalizePlanInput(input: PlanWorldChangeInput): {
  transactionId: number;
  ordinal: number;
  position: BlockPosition;
  action: WorldChangeAction;
  before: WorldBlockSnapshot;
  intended: WorldBlockSnapshot;
  maxWorldChanges?: number;
} {
  assertPositiveId("transaction id", input.transactionId);
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error("change ordinal must be a non-negative integer");
  }
  if (!CHANGE_ACTIONS.has(input.action)) throw new Error("unknown world change action");
  const position = normalizePosition(input.position);
  const maxWorldChanges = input.maxWorldChanges === undefined
    ? undefined
    : normalizeNonNegativeInteger("max world changes", input.maxWorldChanges);
  return {
    transactionId: input.transactionId,
    ordinal: input.ordinal,
    position,
    action: input.action,
    before: normalizeSnapshot(input.before, "before snapshot"),
    intended: normalizeSnapshot(input.intended, "intended snapshot"),
    ...(maxWorldChanges === undefined ? {} : { maxWorldChanges }),
  };
}

function normalizeSnapshot(input: WorldBlockSnapshotInput, label: string): WorldBlockSnapshot {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const name = normalizeShortString(input.name, `${label} name`, 128);
  let stateId: number | undefined;
  if (input.stateId !== undefined) {
    if (!Number.isSafeInteger(input.stateId) || (input.stateId as number) < 0) {
      throw new Error(`${label} stateId must be a non-negative integer`);
    }
    stateId = input.stateId as number;
  }
  const properties = normalizeProperties(input.properties ?? {});
  let boundingBox: WorldBlockSnapshot["boundingBox"];
  if (input.boundingBox !== undefined) {
    if (typeof input.boundingBox !== "string" || !BOUNDING_BOXES.has(input.boundingBox as NonNullable<WorldBlockSnapshot["boundingBox"]>)) {
      throw new Error(`${label} boundingBox is not recognized`);
    }
    boundingBox = input.boundingBox as NonNullable<WorldBlockSnapshot["boundingBox"]>;
  }
  if (input.replaceable !== undefined && typeof input.replaceable !== "boolean") {
    throw new Error(`${label} replaceable must be boolean`);
  }
  if (input.diggable !== undefined && typeof input.diggable !== "boolean") {
    throw new Error(`${label} diggable must be boolean`);
  }
  const snapshot = Object.freeze({
    name,
    ...(stateId === undefined ? {} : { stateId }),
    properties,
    ...(boundingBox === undefined ? {} : { boundingBox }),
    ...(input.replaceable === undefined ? {} : { replaceable: input.replaceable }),
    ...(input.diggable === undefined ? {} : { diggable: input.diggable }),
  });
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json, "utf8") > MAX_SNAPSHOT_JSON_BYTES) {
    throw new Error(`${label} exceeds ${MAX_SNAPSHOT_JSON_BYTES} bytes`);
  }
  return snapshot;
}

function normalizeProperties(value: unknown): Readonly<Record<string, BlockPropertyValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("snapshot properties must be an object, not an array");
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  if (keys.length > MAX_PROPERTY_COUNT) {
    throw new Error(`snapshot has more than ${MAX_PROPERTY_COUNT} properties`);
  }
  const properties: Record<string, BlockPropertyValue> = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > MAX_PROPERTY_KEY_LENGTH) {
      throw new Error(`snapshot property key is invalid`);
    }
    const item = source[key];
    if (typeof item === "string") {
      if (item.length > MAX_PROPERTY_VALUE_LENGTH) {
        throw new Error(`snapshot property '${key}' exceeds ${MAX_PROPERTY_VALUE_LENGTH} characters`);
      }
      properties[key] = item;
    } else if (typeof item === "number" && Number.isFinite(item)) {
      properties[key] = item;
    } else if (typeof item === "boolean") {
      properties[key] = item;
    } else {
      throw new Error(`snapshot property '${key}' must be a finite primitive`);
    }
  }
  return Object.freeze(properties);
}

function parseSnapshot(json: string, label: string): WorldBlockSnapshot {
  try {
    return normalizeSnapshot(JSON.parse(json) as WorldBlockSnapshotInput, label);
  } catch (error) {
    throw new Error(`${label} is invalid: ${message(error)}`);
  }
}

function sameSnapshot(first: WorldBlockSnapshot, second: WorldBlockSnapshot): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function normalizePosition(value: unknown): BlockPosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("change position must be an object");
  }
  const position = value as { x?: unknown; y?: unknown; z?: unknown };
  for (const coordinate of [position.x, position.y, position.z]) {
    if (!Number.isSafeInteger(coordinate)) {
      throw new Error("change position must contain finite integer coordinates");
    }
  }
  return Object.freeze({ x: position.x as number, y: position.y as number, z: position.z as number });
}

function normalizeCorrelation(value: unknown): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("transaction correlation must be an object");
  }
  const normalized = normalizeJson(value, "correlation", 0) as Record<string, JsonValue>;
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > MAX_CORRELATION_JSON_BYTES) {
    throw new Error(`transaction correlation exceeds ${MAX_CORRELATION_JSON_BYTES} bytes`);
  }
  return deepFreeze(normalized) as Readonly<Record<string, JsonValue>>;
}

function parseCorrelation(json: string): Readonly<Record<string, unknown>> {
  try {
    const value = JSON.parse(json) as unknown;
    return normalizeCorrelation(value);
  } catch (error) {
    throw new Error(`stored transaction correlation is invalid: ${message(error)}`);
  }
}

function normalizeJson(value: unknown, label: string, depth: number): JsonValue {
  if (depth > 8) throw new Error(`${label} is nested too deeply`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 1_024) throw new Error(`${label} contains an oversized string`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error(`${label} contains too many array entries`);
    return value.map((item, index) => normalizeJson(item, `${label}[${index}]`, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    if (keys.length > 64) throw new Error(`${label} contains too many object keys`);
    const result: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (key.length === 0 || key.length > 128) throw new Error(`${label} contains an invalid key`);
      result[key] = normalizeJson(source[key], `${label}.${key}`, depth + 1);
    }
    return result;
  }
  throw new Error(`${label} contains a non-JSON value`);
}

function deepFreeze(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return Object.freeze(value) as JsonValue;
}

function parseTransactionStatus(value: string): WorldTransactionStatus {
  if (!TRANSACTION_STATUSES.has(value as WorldTransactionStatus)) {
    throw new Error(`stored world transaction has unknown status '${value}'`);
  }
  return value as WorldTransactionStatus;
}

function parseChangeStatus(value: string): WorldChangeStatus {
  if (!CHANGE_STATUSES.has(value as WorldChangeStatus)) {
    throw new Error(`stored world change has unknown status '${value}'`);
  }
  return value as WorldChangeStatus;
}

function parseAction(value: string): WorldChangeAction {
  if (!CHANGE_ACTIONS.has(value as WorldChangeAction)) {
    throw new Error(`stored world change has unknown action '${value}'`);
  }
  return value as WorldChangeAction;
}

function normalizeShortString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`${label} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

/** Match `makeServerKey`'s host normalization for already-composed keys. */
export function normalizeWorldServerKey(value: unknown): string {
  return normalizeShortString(value, "server key", 256).toLowerCase();
}

function normalizeError(value: unknown): string {
  return normalizeShortString(value, "change error", MAX_ERROR_LENGTH);
}

function optionalPositiveId(label: string, value: unknown): number | null {
  if (value === undefined) return null;
  assertPositiveId(label, value);
  return value;
}

function assertPositiveId(label: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function normalizeNonNegativeInteger(label: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function normalizeTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("transaction timestamp must be a non-negative integer");
  }
  return value as number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
