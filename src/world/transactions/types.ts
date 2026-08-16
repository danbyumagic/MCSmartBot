import type { BlockPropertyValue } from "../blockSnapshot.js";
import type { BlockPosition } from "../types.js";
import type { ExecutionActor } from "../../permissions/executionActor.js";

export type WorldTransactionStatus =
  | "open"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "undoing"
  | "undone"
  | "undo_partial";

export type WorldChangeStatus =
  | "planned"
  | "applied"
  | "failed"
  | "conflict"
  | "reverting"
  | "reverted";

export type WorldChangeAction = "place" | "dig" | "replace";

/**
 * The durable portion of a live block snapshot. Coordinates are stored in the
 * change row, so retained JSON contains only stable block-state primitives.
 */
export interface WorldBlockSnapshot {
  readonly name: string;
  readonly stateId?: number;
  readonly properties: Readonly<Record<string, BlockPropertyValue>>;
  readonly boundingBox?: "block" | "empty" | "unknown";
  readonly replaceable?: boolean;
  readonly diggable?: boolean;
}

/** Permissive input shape normalized into `WorldBlockSnapshot` at the DB edge. */
export interface WorldBlockSnapshotInput {
  name: unknown;
  stateId?: unknown;
  properties?: unknown;
  boundingBox?: unknown;
  replaceable?: unknown;
  diggable?: unknown;
}

export interface BeginWorldTransactionInput {
  serverKey: string;
  dimension: string;
  label?: string;
  kind: string;
  actor: ExecutionActor;
  taskPlanId?: number;
  constructionJobId?: number;
  /** Shared only by transactions that belong to the same bounded execution. */
  budgetScope?: string;
  correlation?: Record<string, unknown>;
}

/**
 * Identity for one resumable survival-construction attempt.
 *
 * A construction job may be resumed many times, but an *open* attempt is
 * always scoped to this exact server, dimension, job, and task plan. The
 * immutable actor is checked when an existing attempt is reused rather than
 * letting a different caller inherit its journal.
 */
export interface BeginConstructionAttemptInput {
  serverKey: string;
  dimension: string;
  constructionJobId: number;
  /** Undefined is deliberately represented as SQL NULL in the exact key. */
  taskPlanId?: number;
  actor: ExecutionActor;
  label?: string;
  /** Shared only by transactions that belong to the same bounded execution. */
  budgetScope?: string;
  correlation?: Record<string, unknown>;
}

export interface PlanWorldChangeInput {
  transactionId: number;
  ordinal: number;
  position: BlockPosition;
  action: WorldChangeAction;
  before: WorldBlockSnapshotInput;
  intended: WorldBlockSnapshotInput;
  /** The execution-wide cap; enforced atomically with insertion when present. */
  maxWorldChanges?: number;
}

export interface WorldTransactionRow {
  readonly id: number;
  readonly tsCreated: number;
  readonly tsUpdated: number;
  readonly serverKey: string;
  readonly dimension: string;
  readonly label: string | null;
  readonly kind: string;
  readonly actor: ExecutionActor;
  readonly status: WorldTransactionStatus;
  readonly taskPlanId: number | null;
  readonly constructionJobId: number | null;
  readonly budgetScope: string;
  readonly correlation: Readonly<Record<string, unknown>>;
  readonly requestedChangeCount: number;
  readonly appliedChangeCount: number;
  readonly lastError: string | null;
}

export interface WorldChangeRow {
  readonly id: number;
  readonly transactionId: number;
  readonly ordinal: number;
  readonly position: BlockPosition;
  readonly action: WorldChangeAction;
  readonly before: WorldBlockSnapshot;
  readonly intended: WorldBlockSnapshot;
  readonly confirmedAfter: WorldBlockSnapshot | null;
  readonly status: WorldChangeStatus;
  readonly lastError: string | null;
  readonly tsPlanned: number;
  readonly tsUpdated: number;
}

export interface WorldTransactionDetail extends WorldTransactionRow {
  readonly changes: readonly WorldChangeRow[];
}

export interface ListWorldTransactionsInput {
  serverKey?: string;
  dimension?: string;
  status?: WorldTransactionStatus;
  limit?: number;
}

/** Internal, cursor-based detail query for scoped reconnect reconciliation. */
export interface ListOpenWorldTransactionsInput {
  serverKey: string;
  dimension: string;
  afterId?: number;
  limit?: number;
}

/**
 * Narrow safety lookup used before resuming a construction job under a new
 * durable task plan. An unresolved planned click belongs to the job, not just
 * the plan that happened to issue it.
 */
export interface FindUnresolvedConstructionAttemptInput {
  serverKey: string;
  dimension: string;
  constructionJobId: number;
}

/**
 * Latest confirmed construction mutation at each coordinate after the supplied
 * ordinal. This is deliberately a position-bounded view, rather than a raw
 * journal listing: repeated attempts cannot make a safe resume scan grow with
 * every historical row.
 *
 * A failed or conflicted cleanup does not count as a confirmed removal, so an
 * earlier applied scaffold placement remains visible to callers as a safety
 * candidate.
 */
export interface ListConstructionMutationHistoryInput {
  serverKey: string;
  dimension: string;
  constructionJobId: number;
  minOrdinal?: number;
}

export interface ConstructionMutationHistory {
  /** One latest successfully applied mutation per world coordinate. */
  readonly changes: readonly WorldChangeRow[];
  /** More distinct coordinates existed than the store's fixed safe scan cap. */
  readonly truncated: boolean;
}
