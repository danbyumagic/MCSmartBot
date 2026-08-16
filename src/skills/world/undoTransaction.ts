import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { snapshotBlock, type BlockSnapshot } from "../../world/blockSnapshot.js";
import { digAt, placeAt } from "../../world/blockExecutor.js";
import type { BlockPosition, BlockMutationResult } from "../../world/types.js";
import type {
  WorldBlockSnapshot,
  WorldChangeRow,
  WorldTransactionDetail,
} from "../../world/transactions/types.js";
import type { WorldTransactionService } from "../../world/transactions/service.js";
import type { SkillErrorCode, SkillResult } from "../types.js";

const MAX_PREVIEW_CHANGES = 128;

export interface UndoPreviewChange {
  readonly changeId: number;
  readonly ordinal: number;
  readonly action: WorldChangeRow["action"];
  readonly position: BlockPosition;
  readonly disposition: "ready" | "already-reverted" | "conflict" | "unavailable" | "unsupported" | "ignored";
  readonly requiredItem?: string;
  readonly summary: string;
}

export interface UndoPreview {
  readonly transactionId: number;
  readonly transactionStatus: WorldTransactionDetail["status"];
  readonly changes: readonly UndoPreviewChange[];
  readonly readyCount: number;
  readonly alreadyRevertedCount: number;
  readonly conflictCount: number;
  readonly unavailableCount: number;
  readonly unsupportedCount: number;
  readonly ignoredCount: number;
  readonly truncated: boolean;
}

export interface UndoRuntimeDependencies {
  readonly transactions: WorldTransactionService;
  readonly serverKey: string;
  readonly bot: Bot;
}

export interface UndoInput {
  readonly transactionId: number;
  readonly signal?: AbortSignal;
  /** A caller-provided storage label is retained for honest diagnostics. */
  readonly storageName?: string;
}

export interface UndoReconciliationInput {
  readonly transactions: WorldTransactionService;
  readonly serverKey: string;
  readonly dimension: string;
  readonly inspect: (position: BlockPosition) => WorldBlockSnapshot | null | undefined;
  readonly limit?: number;
}

export interface UndoReconciliationResult {
  readonly transactionsVisited: number;
  readonly reverted: number;
  readonly conflicts: number;
  readonly unavailable: number;
  readonly finalized: number;
}

/**
 * Preview never mutates the world or the journal. It only considers original
 * applied rows; conflict rows are intentionally preserved as immutable audit
 * history and are never silently retried.
 */
export function previewUndoTransaction(
  deps: UndoRuntimeDependencies,
  transactionId: number,
): UndoPreview | SkillResult {
  const transaction = deps.transactions.get(transactionId);
  if (!transaction) {
    return failure("NOT_CONFIGURED", `world transaction ${transactionId} does not exist`, false);
  }
  const access = checkTransactionAccess(deps, transaction);
  if (access) return access;
  let transactionChanges: UndoPreviewChange[] = [];
  let readyCount = 0;
  let alreadyRevertedCount = 0;
  let conflictCount = 0;
  let unavailableCount = 0;
  let unsupportedCount = 0;
  let ignoredCount = 0;
  let truncated = false;

  for (const change of [...transaction.changes].reverse()) {
    if (transactionChanges.length >= MAX_PREVIEW_CHANGES) {
      truncated = true;
      break;
    }
    if (change.status === "reverted") {
      ignoredCount++;
      transactionChanges.push(changeSummary(change, "ignored", "already marked reverted"));
      continue;
    }
    if (change.status === "conflict" || change.confirmedAfter === null) {
      conflictCount++;
      transactionChanges.push(changeSummary(change, "conflict", "preserved conflict; external state is not overwritten"));
      continue;
    }
    if (change.status !== "applied") {
      ignoredCount++;
      transactionChanges.push(changeSummary(change, "ignored", `change is ${change.status}`));
      continue;
    }
    const live = readLiveSnapshot(deps.bot, change.position);
    if (!live) {
      unavailableCount++;
      transactionChanges.push(changeSummary(change, "unavailable", "live block data is unavailable"));
      continue;
    }
    if (matchesDurableSnapshot(live, change.before)) {
      alreadyRevertedCount++;
      transactionChanges.push(changeSummary(change, "already-reverted", "live block already matches the original state"));
      continue;
    }
    if (!matchesDurableSnapshot(live, change.confirmedAfter)) {
      conflictCount++;
      transactionChanges.push(changeSummary(change, "conflict", "live block differs from the recorded post-mutation state"));
      continue;
    }
    if (!isReversibleChange(change)) {
      unsupportedCount++;
      transactionChanges.push(changeSummary(change, "unsupported", `cannot safely reverse action ${change.action}`));
      continue;
    }
    readyCount++;
    transactionChanges.push(changeSummary(
      change,
      "ready",
      change.action === "place"
        ? `will remove ${change.intended.name}`
        : `will restore ${change.before.name}`,
      change.action === "place" ? undefined : change.before.name,
    ));
  }

  return Object.freeze({
    transactionId,
    transactionStatus: transaction.status,
    changes: Object.freeze(transactionChanges),
    readyCount,
    alreadyRevertedCount,
    conflictCount,
    unavailableCount,
    unsupportedCount,
    ignoredCount,
    truncated,
  });
}

/** Execute a resumable, conflict-aware undo pass using the shared verified executor. */
export async function undoWorldTransaction(
  deps: UndoRuntimeDependencies,
  input: UndoInput,
): Promise<SkillResult> {
  const signal = input.signal ?? new AbortController().signal;
  const transaction = deps.transactions.get(input.transactionId);
  if (!transaction) return failure("NOT_CONFIGURED", `world transaction ${input.transactionId} does not exist`, false);
  const access = checkTransactionAccess(deps, transaction);
  if (access) return access;

  let started: WorldTransactionDetail | undefined;
  try {
    started = deps.transactions.beginUndo(input.transactionId);
  } catch (error) {
    return failure("STALE_STATE", message(error), false, { transactionId: input.transactionId });
  }
  if (!started) return failure("NOT_CONFIGURED", `world transaction ${input.transactionId} does not exist`, false);
  if (started.status === "undone") {
    return success("transaction is already undone", { transaction: compactTransaction(started), undone: true });
  }

  let reverted = 0;
  let conflicts = 0;
  let skipped = 0;
  let unavailable = 0;
  let interrupted = false;
  let materialMissing: string | undefined;
  for (const change of [...started.changes].reverse()) {
    if (change.status !== "applied" && change.status !== "reverting") {
      if (change.status === "conflict") conflicts++;
      else skipped++;
      continue;
    }
    if (signal.aborted) {
      interrupted = true;
      break;
    }
    const live = readLiveSnapshot(deps.bot, change.position);
    if (!live) {
      unavailable++;
      break;
    }
    if (matchesDurableSnapshot(live, change.before)) {
      deps.transactions.markReverting(change.id);
      deps.transactions.markReverted(change.id);
      reverted++;
      continue;
    }
    if (!change.confirmedAfter || !matchesDurableSnapshot(live, change.confirmedAfter)) {
      deps.transactions.markReverting(change.id);
      deps.transactions.markUndoConflict(change.id, "undo refused: live block differs from the recorded post-mutation state");
      conflicts++;
      continue;
    }
    if (!isReversibleChange(change)) {
      deps.transactions.markReverting(change.id);
      deps.transactions.markUndoConflict(change.id, `undo refused: unsupported action ${change.action}`);
      conflicts++;
      continue;
    }
    const marked = deps.transactions.markReverting(change.id);
    if (!marked) {
      skipped++;
      continue;
    }
    const result = await reverseChange(deps.bot, change, signal);
    if (result.ok) {
      const after = readLiveSnapshot(deps.bot, change.position);
      if (after && matchesDurableSnapshot(after, change.before)) {
        deps.transactions.markReverted(change.id);
        reverted++;
      } else if (!after) {
        unavailable++;
        break;
      } else {
        deps.transactions.markUndoConflict(change.id, "undo verification found an unexpected restored state");
        conflicts++;
      }
      continue;
    }
    const after = readLiveSnapshot(deps.bot, change.position);
    if (after && matchesDurableSnapshot(after, change.before)) {
      deps.transactions.markReverted(change.id);
      reverted++;
    } else if (!after) {
      unavailable++;
      break;
    } else if (result.code === "NO_MATERIAL") {
      materialMissing = change.before.name;
      // Keep the row reverting so a later explicit owner retry can supply the
      // material. A missing item is not evidence of an external world edit.
      break;
    } else if (signal.aborted || result.code === "INTERRUPTED") {
      interrupted = true;
      break;
    } else {
      deps.transactions.markUndoConflict(change.id, result.summary);
      conflicts++;
    }
  }

  const final = deps.transactions.finalizeUndo(input.transactionId);
  const details = {
    transaction: compactTransaction(final ?? deps.transactions.get(input.transactionId)),
    reverted,
    conflicts,
    skipped,
    unavailable,
    ...(input.storageName === undefined ? {} : { storageName: input.storageName }),
    ...(materialMissing === undefined ? {} : { materialMissing }),
  } satisfies Record<string, unknown>;
  if (interrupted) {
    return {
      ok: false,
      summary: `undo interrupted after reverting ${reverted} change${reverted === 1 ? "" : "s"}`,
      code: "INTERRUPTED",
      recoverable: true,
      details,
    };
  }
  if (unavailable > 0) {
    return {
      ok: false,
      summary: `undo paused because live world data became unavailable after reverting ${reverted} change${reverted === 1 ? "" : "s"}`,
      code: "WORLD_UNAVAILABLE",
      recoverable: true,
      details,
    };
  }
  if (materialMissing !== undefined) {
    return {
      ok: false,
      summary: `undo needs ${materialMissing}; no carried material was available and no implicit item was created`,
      code: "NO_MATERIAL",
      recoverable: true,
      details,
    };
  }
  if (conflicts > 0) {
    return {
      ok: false,
      summary: `undo stopped with ${conflicts} preserved conflict${conflicts === 1 ? "" : "s"}`,
      code: "STALE_STATE",
      recoverable: false,
      details,
    };
  }
  return success(`undid ${reverted} world change${reverted === 1 ? "" : "s"}`, details);
}

/** Reconcile only already-started undo rows after reconnect; never retries a mutation. */
export function reconcileUndoingTransactions(input: UndoReconciliationInput): UndoReconciliationResult {
  const limit = input.limit ?? 100;
  const candidates = [
    ...input.transactions.list({ serverKey: input.serverKey, dimension: input.dimension, status: "undoing", limit }),
    ...input.transactions.list({ serverKey: input.serverKey, dimension: input.dimension, status: "undo_partial", limit }),
  ];
  let reverted = 0;
  let conflicts = 0;
  let unavailable = 0;
  let finalized = 0;
  for (const row of candidates) {
    const detail = input.transactions.get(row.id);
    if (!detail) continue;
    for (const change of detail.changes) {
      if (change.status !== "reverting") continue;
      const live = input.inspect(change.position);
      if (!live) {
        unavailable++;
        continue;
      }
      if (matchesDurableSnapshot(live, change.before)) {
        input.transactions.markReverted(change.id);
        reverted++;
      } else if (change.confirmedAfter && matchesDurableSnapshot(live, change.confirmedAfter)) {
        // The original post-state remains; leave the reverting row for an
        // explicit owner retry rather than silently issuing a second mutation.
        continue;
      } else {
        input.transactions.markUndoConflict(change.id, "undo reconciliation found an external or unknown block state");
        conflicts++;
      }
    }
    const final = input.transactions.finalizeUndo(detail.id);
    if (final && (final.status === "undone" || final.status === "undo_partial")) finalized++;
  }
  return { transactionsVisited: candidates.length, reverted, conflicts, unavailable, finalized };
}

function reverseChange(bot: Bot, change: WorldChangeRow, signal: AbortSignal): Promise<BlockMutationResult> {
  const expectedCurrent = (snapshot: BlockSnapshot): boolean =>
    Boolean(change.confirmedAfter && matchesDurableSnapshot(snapshot, change.confirmedAfter));
  if (change.action === "place") {
    return digAt(bot as never, {
      position: change.position,
      expected: expectedCurrent,
      signal,
    });
  }
  return placeAt(bot as never, {
    position: change.position,
    item: change.before.name,
    expected: expectedCurrent,
    expectedAfter: (snapshot) => matchesDurableSnapshot(snapshot, change.before),
    ...(Object.keys(change.before.properties).length === 0
      ? {}
      : { intendedProperties: change.before.properties }),
    allowReplace: !change.before.replaceable,
    signal,
  });
}

function checkTransactionAccess(
  deps: UndoRuntimeDependencies,
  transaction: WorldTransactionDetail,
): SkillResult | undefined {
  if (transaction.serverKey !== deps.serverKey) {
    return failure("PERMISSION_DENIED", "transaction belongs to a different server", false);
  }
  const dimension = deps.bot.game?.dimension;
  if (!dimension || dimension !== transaction.dimension) {
    return failure("WORLD_UNAVAILABLE", "transaction belongs to a different or unavailable dimension", true, {
      transactionDimension: transaction.dimension,
      liveDimension: dimension ?? null,
    });
  }
  return undefined;
}

function isReversibleChange(change: WorldChangeRow): boolean {
  if (change.action !== "place" && change.action !== "dig" && change.action !== "replace") return false;
  if (change.action !== "place" && change.before.name === "air") return false;
  return true;
}

function readLiveSnapshot(bot: Bot, position: BlockPosition): BlockSnapshot | undefined {
  try {
    const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
    return block ? snapshotBlock(block, position) : undefined;
  } catch {
    return undefined;
  }
}

function matchesDurableSnapshot(
  live: ComparableSnapshot,
  expected: WorldBlockSnapshot | null | undefined,
): boolean {
  if (!expected || live.name !== expected.name) return false;
  if (expected.stateId !== undefined && live.stateId !== expected.stateId) return false;
  if (expected.boundingBox !== undefined && live.boundingBox !== expected.boundingBox) return false;
  if (expected.replaceable !== undefined && live.replaceable !== expected.replaceable) return false;
  if (expected.diggable !== undefined && live.diggable !== expected.diggable) return false;
  return Object.entries(expected.properties).every(([key, value]) => live.properties[key] === value);
}

type ComparableSnapshot = Pick<WorldBlockSnapshot, "name" | "properties"> & {
  readonly stateId?: number;
  readonly boundingBox?: WorldBlockSnapshot["boundingBox"];
  readonly replaceable?: boolean;
  readonly diggable?: boolean;
};

function changeSummary(
  change: WorldChangeRow,
  disposition: UndoPreviewChange["disposition"],
  summary: string,
  requiredItem?: string,
): UndoPreviewChange {
  return Object.freeze({
    changeId: change.id,
    ordinal: change.ordinal,
    action: change.action,
    position: change.position,
    disposition,
    ...(requiredItem === undefined ? {} : { requiredItem }),
    summary,
  });
}

function compactTransaction(transaction: WorldTransactionDetail | undefined): Record<string, unknown> | undefined {
  if (!transaction) return undefined;
  return {
    id: transaction.id,
    status: transaction.status,
    requestedChangeCount: transaction.requestedChangeCount,
    appliedChangeCount: transaction.appliedChangeCount,
    ...(transaction.lastError === null ? {} : { lastError: transaction.lastError }),
  };
}

function success(summary: string, details: Record<string, unknown>): SkillResult {
  return { ok: true, summary, details, data: details };
}

function failure(
  code: SkillErrorCode,
  summary: string,
  recoverable: boolean,
  details?: Record<string, unknown>,
): SkillResult {
  return { ok: false, code, summary, recoverable, ...(details === undefined ? {} : { details }) };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
