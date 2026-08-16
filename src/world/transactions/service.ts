import type {
  BlockMutationEvent,
  BlockMutationConflict,
  BlockMutationFailure,
  BlockMutationHooks,
  BlockMutationHookFailure,
} from "../blockExecutor.js";
import type { BlockPosition } from "../types.js";
import type { DB } from "../../memory/db.js";
import {
  WorldChangeBudgetError,
  CONSTRUCTION_TRANSACTION_KIND,
  beginOrReuseConstructionAttempt,
  beginTransaction,
  beginUndoTransaction,
  cancelTransaction,
  completeTransaction,
  findUnresolvedConstructionAttempt,
  getTransaction,
  listOpenTransactionsForReconciliation,
  listTransactions,
  listConstructionMutationHistory,
  markChangeApplied,
  markChangeConflict,
  markChangeConflictedAfter,
  markChangeFailed,
  markChangeReverted,
  markChangeReverting,
  markChangeUndoConflict,
  normalizeWorldBlockSnapshot,
  normalizeWorldServerKey,
  countReservedWorldChanges,
  planChange,
  finalizeUndoTransaction,
} from "./store.js";
import type {
  BeginConstructionAttemptInput,
  BeginWorldTransactionInput,
  ConstructionMutationHistory,
  FindUnresolvedConstructionAttemptInput,
  ListConstructionMutationHistoryInput,
  WorldBlockSnapshot,
  WorldBlockSnapshotInput,
  WorldChangeRow,
  WorldTransactionDetail,
  WorldTransactionRow,
  ListWorldTransactionsInput,
} from "./types.js";

export interface MutationHookInput {
  transactionId: number;
  /** Deterministic ordinal chosen by the operation that owns the transaction. */
  ordinal: number;
  maxWorldChanges?: number;
}

/**
 * A construction ordinal is a deterministic construction-mutation address,
 * not the number of mutations attempted during this invocation. Callers may
 * namespace a canonical placement-unit index by phase (primary/scaffold/
 * cleanup/repair); deferred work and a resumed process must pass the same
 * ordinal for the same mutation phase.
 */
export interface ConstructionMutationHookInput extends MutationHookInput {}

/** A whole operation preflight. Per-change planning still enforces this atomically. */
export interface WorldChangeBudgetPreflightInput {
  transactionId: number;
  maxWorldChanges?: number;
  requestedChanges: number;
}

export type WorldChangeBudgetPreflightResult =
  | {
    readonly ok: true;
    readonly reserved: number;
    readonly requested: number;
    readonly limit?: number;
  }
  | {
    readonly ok: false;
    readonly code: "BUDGET_EXCEEDED";
    readonly summary: string;
    readonly recoverable: false;
    readonly details: Readonly<Record<string, number>>;
  };

export interface ReconcileLiveTransactionsInput {
  serverKey: string;
  dimension: string;
  /** Return null/undefined for unloaded or otherwise unavailable world data. */
  inspect(position: BlockPosition): WorldBlockSnapshotInput | null | undefined;
  /** Cursor returned by a previous bounded reconciliation pass. */
  afterTransactionId?: number;
  limit?: number;
}

export interface ReconcileLiveTransactionsResult {
  transactionsVisited: number;
  applied: number;
  failed: number;
  conflicts: number;
  unavailable: number;
  finalized: number;
  nextTransactionId: number | null;
}

export interface WorldTransactionService {
  begin(input: BeginWorldTransactionInput): WorldTransactionDetail;
  /**
   * Atomically create/reuse the one open `kind: construction` transaction for
   * this exact server, dimension, construction job, and task plan.
   */
  beginOrReuseConstructionAttempt(input: BeginConstructionAttemptInput): WorldTransactionDetail;
  /**
   * Read the oldest ambiguous planned change for this exact construction job,
   * regardless of which prior task plan owns it. The builder uses this only
   * for a structured blocked result; begin/reuse repeats the invariant
   * atomically before insertion.
   */
  findUnresolvedConstructionAttempt(
    input: FindUnresolvedConstructionAttemptInput,
  ): WorldTransactionDetail | undefined;
  /** Position-deduplicated applied history for fail-closed scaffold safety checks. */
  listConstructionMutationHistory(
    input: ListConstructionMutationHistoryInput,
  ): ConstructionMutationHistory;
  /**
   * Reject an entire requested operation before its first mutation when the
   * execution-wide limit cannot hold all of its candidates. The per-change
   * hook remains an atomic race guard.
   */
  preflightWorldChanges(input: WorldChangeBudgetPreflightInput): WorldChangeBudgetPreflightResult;
  createMutationHooks(input: MutationHookInput): BlockMutationHooks;
  /**
   * Construction-only hook entrypoint with stable canonical placement ordinal
   * semantics. It refuses an unrelated or terminal transaction up front.
   */
  createConstructionMutationHooks(input: ConstructionMutationHookInput): BlockMutationHooks;
  complete(transactionId: number): WorldTransactionDetail | undefined;
  cancel(transactionId: number, error?: string): WorldTransactionDetail | undefined;
  get(transactionId: number): WorldTransactionDetail | undefined;
  list(input?: ListWorldTransactionsInput): WorldTransactionRow[];
  beginUndo(transactionId: number): WorldTransactionDetail | undefined;
  markReverting(changeId: number): WorldChangeRow | undefined;
  markReverted(changeId: number): WorldChangeRow | undefined;
  markUndoConflict(changeId: number, error: string): WorldChangeRow | undefined;
  finalizeUndo(transactionId: number): WorldTransactionDetail | undefined;
  reconcileLive(input: ReconcileLiveTransactionsInput): ReconcileLiveTransactionsResult;
}

/**
 * Bridges the pure verified executor to SQLite without letting either layer
 * retain Mineflayer objects. A fresh hook closure owns exactly one change ID.
 */
export function createWorldTransactionService(deps: {
  db: DB;
  now?: () => number;
}): WorldTransactionService {
  const now = deps.now ?? Date.now;

  function preflightWorldChanges(
    input: WorldChangeBudgetPreflightInput,
  ): WorldChangeBudgetPreflightResult {
    if (!Number.isSafeInteger(input.transactionId) || input.transactionId <= 0) {
      throw new Error("world transaction id must be a positive integer");
    }
    if (!Number.isSafeInteger(input.requestedChanges) || input.requestedChanges < 0) {
      throw new Error("requested world changes must be a non-negative integer");
    }
    if (input.maxWorldChanges !== undefined &&
        (!Number.isSafeInteger(input.maxWorldChanges) || input.maxWorldChanges < 0)) {
      throw new Error("max world changes must be a non-negative integer");
    }
    const transaction = getTransaction(deps.db, input.transactionId);
    if (!transaction) throw new Error(`world transaction ${input.transactionId} does not exist`);
    const reserved = countReservedWorldChanges(deps.db, {
      serverKey: transaction.serverKey,
      budgetScope: transaction.budgetScope,
    });
    if (input.maxWorldChanges === undefined ||
        reserved + input.requestedChanges <= input.maxWorldChanges) {
      return Object.freeze({
        ok: true,
        reserved,
        requested: input.requestedChanges,
        ...(input.maxWorldChanges === undefined ? {} : { limit: input.maxWorldChanges }),
      });
    }
    const error = new WorldChangeBudgetError(
      input.maxWorldChanges,
      reserved,
      input.requestedChanges,
    );
    return Object.freeze({
      ok: false,
      code: "BUDGET_EXCEEDED",
      summary: error.message,
      recoverable: false,
      details: Object.freeze({
        limit: error.limit,
        reserved: error.reserved,
        requested: error.requested,
      }),
    });
  }

  function createMutationHooks(input: MutationHookInput): BlockMutationHooks {
    let changeId: number | undefined;
    let planned = false;
    const hooks: BlockMutationHooks = {
      planned: (event: BlockMutationEvent): void | BlockMutationHookFailure => {
        if (planned) {
          throw new Error(`world change ordinal ${input.ordinal} was planned more than once`);
        }
        try {
          const change = planChange(deps.db, {
            transactionId: input.transactionId,
            ordinal: input.ordinal,
            position: event.position,
            action: event.action,
            before: event.before,
            intended: event.intended,
            maxWorldChanges: input.maxWorldChanges,
          }, now());
          changeId = change.id;
          planned = true;
          return;
        } catch (error) {
          if (error instanceof WorldChangeBudgetError) {
            return Object.freeze({
              ok: false as const,
              code: "BUDGET_EXCEEDED" as const,
              summary: error.message,
              recoverable: false,
              details: { limit: error.limit, reserved: error.reserved },
            });
          }
          throw error;
        }
      },
      applied: (event: BlockMutationEvent): void => {
        if (changeId === undefined) {
          throw new Error("cannot apply an unplanned world change");
        }
        const applied = markChangeApplied(deps.db, changeId, event.intended, now());
        if (!applied) throw new Error(`world change ${changeId} disappeared before it could be confirmed`);
      },
      conflicted: (event: BlockMutationConflict): void => {
        if (changeId === undefined) return;
        const conflicted = markChangeConflictedAfter(
          deps.db,
          changeId,
          event.after,
          event.summary,
          now(),
        );
        if (!conflicted) {
          throw new Error(`world change ${changeId} disappeared before its observed conflict could persist`);
        }
      },
      failed: (event: BlockMutationFailure) => {
        // A planned-hook budget rejection intentionally has no change ID and
        // no failed callback. This guard also keeps unexpected executor paths
        // from fabricating an orphaned journal row.
        if (changeId === undefined) return;
        markChangeFailed(deps.db, changeId, event.summary, now());
      },
    };
    return Object.freeze(hooks);
  }

  function createConstructionMutationHooks(
    input: ConstructionMutationHookInput,
  ): BlockMutationHooks {
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
      throw new Error("construction mutation ordinal must be a non-negative integer");
    }
    const transaction = getTransaction(deps.db, input.transactionId);
    if (!transaction) throw new Error(`world transaction ${input.transactionId} does not exist`);
    if (transaction.kind !== CONSTRUCTION_TRANSACTION_KIND || transaction.constructionJobId === null) {
      throw new Error(`world transaction ${input.transactionId} is not a construction attempt`);
    }
    if (transaction.status !== "open") {
      throw new Error(`world transaction ${input.transactionId} is not open`);
    }
    return createMutationHooks(input);
  }

  function reconcileLive(input: ReconcileLiveTransactionsInput): ReconcileLiveTransactionsResult {
    const result: ReconcileLiveTransactionsResult = {
      transactionsVisited: 0,
      applied: 0,
      failed: 0,
      conflicts: 0,
      unavailable: 0,
      finalized: 0,
      nextTransactionId: null,
    };
    const pageLimit = input.limit ?? 100;
    const serverKey = normalizeWorldServerKey(input.serverKey);
    const dimension = input.dimension.trim();
    const transactions = listOpenTransactionsForReconciliation(deps.db, {
      serverKey,
      dimension,
      afterId: input.afterTransactionId,
      limit: pageLimit,
    });
    for (const summary of transactions) {
      // The database filter is intentionally repeated here as an invariant:
      // reconnecting one profile can never inspect/update another server.
      if (summary.serverKey !== serverKey || summary.dimension !== dimension) continue;
      result.transactionsVisited++;
      const transaction = getTransaction(deps.db, summary.id);
      if (!transaction) continue;
      for (const change of transaction.changes) {
        if (change.status !== "planned") continue;
        let observed: WorldBlockSnapshotInput | null | undefined;
        try {
          observed = input.inspect(change.position);
        } catch {
          result.unavailable++;
          continue;
        }
        if (!observed) {
          result.unavailable++;
          continue;
        }
        let live: WorldBlockSnapshot;
        try {
          live = normalizeWorldBlockSnapshot(observed, "live block snapshot");
        } catch {
          // Treat malformed/partial world data as unavailable rather than
          // turning it into a destructive conflict decision.
          result.unavailable++;
          continue;
        }
        if (transactionSnapshotMatches(change.intended, live)) {
          markChangeApplied(deps.db, change.id, live, now());
          result.applied++;
        } else if (transactionSnapshotMatches(change.before, live)) {
          markChangeFailed(deps.db, change.id, "reconciled after restart: live block still matches the before state", now());
          result.failed++;
        } else {
          markChangeConflict(deps.db, change.id, "reconciled after restart: live block matches neither before nor intended state", now());
          result.conflicts++;
        }
      }
      const refreshed = getTransaction(deps.db, summary.id);
      if (!refreshed || refreshed.changes.some((change) => change.status === "planned")) continue;
      const completed = completeTransaction(deps.db, summary.id, now());
      if (completed && completed.status !== "open") result.finalized++;
    }
    if (transactions.length === pageLimit) {
      result.nextTransactionId = transactions.at(-1)?.id ?? null;
    }
    return Object.freeze(result);
  }

  return Object.freeze({
    begin: (input: BeginWorldTransactionInput) => beginTransaction(deps.db, input, now()),
    beginOrReuseConstructionAttempt: (input: BeginConstructionAttemptInput) =>
      beginOrReuseConstructionAttempt(deps.db, input, now()),
    findUnresolvedConstructionAttempt: (input: FindUnresolvedConstructionAttemptInput) =>
      findUnresolvedConstructionAttempt(deps.db, input),
    listConstructionMutationHistory: (input: ListConstructionMutationHistoryInput) =>
      listConstructionMutationHistory(deps.db, input),
    preflightWorldChanges,
    createMutationHooks,
    createConstructionMutationHooks,
    complete: (transactionId: number) => completeTransaction(deps.db, transactionId, now()),
    cancel: (transactionId: number, error?: string) => cancelTransaction(deps.db, transactionId, error, now()),
    get: (transactionId: number) => getTransaction(deps.db, transactionId),
    list: (input?: ListWorldTransactionsInput) => listTransactions(deps.db, input),
    beginUndo: (transactionId: number) => beginUndoTransaction(deps.db, transactionId, now()),
    markReverting: (changeId: number) => markChangeReverting(deps.db, changeId, now()),
    markReverted: (changeId: number) => markChangeReverted(deps.db, changeId, now()),
    markUndoConflict: (changeId: number, error: string) => markChangeUndoConflict(deps.db, changeId, error, now()),
    finalizeUndo: (transactionId: number) => finalizeUndoTransaction(deps.db, transactionId, now()),
    reconcileLive,
  });
}

/**
 * Intended placement often knows only an item name. Compare every field that
 * was recorded, while permitting the live snapshot to contain extra state.
 */
export function transactionSnapshotMatches(
  expected: WorldBlockSnapshot,
  live: WorldBlockSnapshot,
): boolean {
  if (expected.name !== live.name) return false;
  if (expected.stateId !== undefined && expected.stateId !== live.stateId) return false;
  for (const [key, value] of Object.entries(expected.properties)) {
    if (live.properties[key] !== value) return false;
  }
  return true;
}
