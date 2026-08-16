import { createHash } from "node:crypto";
import type { DB } from "../memory/db.js";
import {
  snapshotExecutionActor,
  type ExecutionActor,
  type ExecutionSource,
} from "../permissions/executionActor.js";
import type { BuildRotation } from "./site.js";
import type { PlacementHint } from "./buildOps/types.js";

export const MAX_RAW_BLUEPRINT_BLOCKS = 256;
export const MAX_COMPILED_BLUEPRINT_BLOCKS = 4_096;
/** Enough for bounded source envelopes while rejecting pathological sparse JSON. */
export const MAX_BLUEPRINT_SOURCE_BYTES = 32_768;

export interface BlueprintBlock {
  x: number;
  y: number;
  z: number;
  block: string;
  /**
   * A compiler-vetted, one-cell placement instruction. This stays attached to
   * the durable cell rather than introducing a second wire format for the
   * normal one-item/one-cell build model.
   */
  hint?: PlacementHint;
}

/**
 * One survival inventory use and every world cell it is expected to create.
 *
 * `blocks_json` intentionally remains the durable, cell-oriented wire format
 * for legacy/private blueprints. These units are normalized in memory so a
 * future verified multi-cell item (such as a door) can consume one item while
 * still requiring two independently verified world cells.
 */
export interface BlueprintPlacementUnit {
  /** Relative cell at which the item is placed. */
  anchor: BlueprintBlock;
  /** Inventory item consumed by exactly one placement attempt. */
  item: string;
  /** Every relative world cell that must match after that placement. */
  expectedCells: BlueprintBlock[];
  /** Honored only by the live-verified one-cell placement adapter. */
  hint?: PlacementHint;
}

export interface BlueprintInput {
  name: string;
  blocks: BlueprintBlock[];
}

export interface BlueprintRow {
  id: number;
  tsCreated: number;
  tsUpdated: number;
  name: string;
  /** Flat durable cells retained for old callers and serialized storage. */
  blocks: BlueprintBlock[];
  /** In-memory material/progress model; legacy cells normalize one-to-one. */
  placementUnits: BlueprintPlacementUnit[];
}

/** Trusted compiler-only registration path; callers cannot choose its larger cap. */
export interface TrustedCompiledBlueprintInput {
  name: string;
  blocks: BlueprintBlock[];
  sourceSchema: string;
  targetVersion: string;
  /** Canonical parsed JSON source retained verbatim for auditing/editing. */
  sourceJson: string;
  sourceHash: string;
  compileReportJson: string;
  creator: ExecutionActor;
}

export interface BlueprintSourceRow {
  blueprintId: number;
  tsCreated: number;
  tsUpdated: number;
  schema: string;
  targetVersion: string;
  sourceJson: string;
  sourceHash: string;
  compileReportJson: string;
  creator: BlueprintSourceCreator;
}

/**
 * Content identity captured by a mission compiler before it materializes a
 * named build.  The blueprint row itself remains mutable while it has no
 * active jobs, so its ID alone is not a safe execution snapshot.
 */
export interface BlueprintExecutionFingerprint {
  readonly blueprintId: number;
  readonly blueprintName: string;
  readonly cellsHash: string;
  readonly sourceHash: string | null;
  readonly targetVersion: string | null;
}

/**
 * Hash the canonical execution-relevant durable blueprint state.  Sort the
 * serialized cells defensively: callers normally receive normalized cells,
 * but the fingerprint must not depend on an incidental storage order.
 */
export function fingerprintBlueprintExecution(
  blueprint: Pick<BlueprintRow, "id" | "name" | "blocks">,
  source: Pick<BlueprintSourceRow, "sourceHash" | "targetVersion"> | null,
): BlueprintExecutionFingerprint {
  const cells = blueprint.blocks.map((block) => JSON.stringify([
    block.x,
    block.y,
    block.z,
    block.block,
    block.hint?.facing ?? null,
    block.hint?.half ?? null,
  ])).sort();
  return Object.freeze({
    blueprintId: blueprint.id,
    blueprintName: blueprint.name,
    cellsHash: createHash("sha256").update(JSON.stringify(cells)).digest("hex"),
    sourceHash: source?.sourceHash ?? null,
    targetVersion: source?.targetVersion ?? null,
  });
}

/** Persisted source provenance omits a role so future execution must reauthorize it. */
export interface BlueprintSourceCreator {
  username: string;
  source: ExecutionSource;
}

export type ConstructionStatus =
  | "pending"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * The only bulk status changes a plan controller may make. In particular,
 * it cannot mark an arbitrary linked job completed or move it back to
 * pending; completion and blocking remain execution-owned states.
 */
export type ConstructionPlanLifecycleStatus =
  | "paused"
  | "running"
  | "failed"
  | "cancelled";

/**
 * A terminal task plan is durable evidence that its linked construction
 * attempt cannot remain runnable. This is intentionally narrower than the
 * ordinary plan lifecycle helper above: it is for recovery coordinators that
 * are repairing state after an event listener or process lifetime was lost.
 */
export type ConstructionTerminalTaskPlanStatus = "completed" | "failed" | "cancelled";

/** The build verifier is the only authority that may mark a job completed. */
export const UNVERIFIED_CONSTRUCTION_COMPLETION_ERROR =
  "task plan completed without a verified construction completion";

/** Keep restart scans bounded while allowing the coordinator to page to EOF. */
export const MAX_TERMINAL_MISSION_BUILD_RECONCILIATION_BATCH = 100;

/** A terminal mission-owned task plan that still has an unsettled build job. */
export interface TerminalMissionConstructionPlan {
  readonly planId: number;
  readonly taskPlanStatus: ConstructionTerminalTaskPlanStatus;
  readonly taskPlanError: string | null;
}

export interface ListTerminalMissionConstructionPlansInput {
  /** Exclusive task-plan ID cursor for durable restart recovery. */
  readonly afterPlanId?: number;
  readonly limit?: number;
}

/** MissionScript can expand to at most 64 durable task steps, so this leaves
 * room for every construction job in one bounded materialization call. */
export const MAX_CONSTRUCTION_JOB_LINK_BATCH = 64;

/**
 * Conditional write guard for a construction job. Durable builders pass their
 * task-plan ID when available so a stale attempt cannot update a newer plan's
 * job after a pause/resume or replacement schedule.
 */
export interface ConstructionJobStatusCondition {
  /** The job must currently be in one of these states for the write to apply. */
  expectedStatuses: readonly ConstructionStatus[];
  /** When present, the current linked task plan must match exactly. */
  expectedPlanId?: number;
  /**
   * Require that the job is still unlinked to every task plan. This is the
   * direct-invocation counterpart to `expectedPlanId`: callers must never set
   * both guards, because a plan-linked job is no longer owned by the direct
   * attempt that observed it.
   */
  expectedNoPlan?: true;
}

export interface SetConstructionStatusIfCurrentInput extends ConstructionJobStatusCondition {
  jobId: number;
  status: ConstructionStatus;
  error?: string;
}

export interface UpdateConstructionProgressIfCurrentInput extends ConstructionJobStatusCondition {
  jobId: number;
  placedCount: number;
}

const CONSTRUCTION_STATUSES = new Set<ConstructionStatus>([
  "pending", "running", "paused", "blocked", "completed", "failed", "cancelled",
]);

/**
 * Compatibility transitions used by control-plane callers. Execution code
 * should prefer `setConstructionStatusIfCurrent` with an exact `running`
 * guard, because pause/resume is intentionally an explicit `paused → running`
 * control-plane transition.
 */
const DEFAULT_CONSTRUCTION_STATUS_SOURCES: Readonly<Record<ConstructionStatus, readonly ConstructionStatus[]>> = {
  // A controller may resume a paused plan in place (`paused → running`) or,
  // when its durable task plan cannot resume, intentionally create a fresh
  // plan (`paused → pending → running`). In-flight builders never target
  // `pending`; they use the stricter conditional primitive below.
  pending: ["pending", "paused", "blocked", "failed"],
  running: ["pending", "running", "paused"],
  paused: ["pending", "running", "blocked", "paused"],
  blocked: ["running", "blocked"],
  completed: ["running", "completed"],
  failed: ["pending", "running", "failed"],
  cancelled: ["pending", "running", "paused", "blocked", "failed", "cancelled"],
};

export interface ConstructionJobInput {
  blueprintId: number;
  dimension?: string;
  originX: number;
  originY: number;
  originZ: number;
  storageName?: string;
  rotation?: BuildRotation;
}

export interface ConstructionJobRow {
  id: number;
  tsCreated: number;
  tsUpdated: number;
  blueprintId: number;
  blueprintName: string;
  dimension: string;
  originX: number;
  originY: number;
  originZ: number;
  rotation: BuildRotation;
  storageName: string | null;
  status: ConstructionStatus;
  placedCount: number;
  totalCount: number;
  lastPlanId: number | null;
  lastError: string | null;
}

/**
 * Convert legacy cell rows into ordinary single-item placement units without
 * modifying their persisted `blocks_json` representation.
 */
export function normalizeBlueprintPlacementUnits(
  blocks: readonly BlueprintBlock[],
): BlueprintPlacementUnit[] {
  return blocks.map((block) => {
    const anchor = cloneBlueprintBlock(block);
    return {
      anchor,
      item: anchor.block,
      expectedCells: [cloneBlueprintBlock(anchor)],
      ...(anchor.hint === undefined ? {} : { hint: clonePlacementHint(anchor.hint) }),
    };
  });
}

/** Material planning counts item placements, never expected world cells. */
export function countPlacementUnitMaterials(
  units: readonly BlueprintPlacementUnit[],
): Map<string, number> {
  const materials = new Map<string, number>();
  for (const unit of units) {
    materials.set(unit.item, (materials.get(unit.item) ?? 0) + 1);
  }
  return materials;
}

/** Progress and verification still report every expected world cell exactly. */
export function countExpectedWorldCells(
  units: readonly BlueprintPlacementUnit[],
): number {
  return units.reduce((total, unit) => total + unit.expectedCells.length, 0);
}

interface ValidateBlocksOptions {
  /** Raw user-authored blueprints deliberately cannot introduce state hints. */
  readonly allowHints: boolean;
  /** Included in error messages so corrupted persisted data is actionable. */
  readonly label: string;
}

/**
 * Normalize the only durable blueprint-cell shape. `mapBlueprint` uses this
 * same validator as writes: malformed JSON data therefore fails closed before
 * it reaches any construction executor.
 */
function validateBlocks(
  value: unknown,
  maximum: number,
  options: ValidateBlocksOptions,
): BlueprintBlock[] {
  if (!Array.isArray(value)) throw new Error(`${options.label} blocks must be an array`);
  if (value.length === 0) throw new Error("blueprint requires at least one block");
  if (value.length > maximum) throw new Error(`blueprint may contain at most ${maximum} blocks`);
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error(`${options.label} block entries must be objects`);
    const x = entry.x;
    const y = entry.y;
    const z = entry.z;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z)) {
      throw new Error("blueprint coordinates must be safe integers");
    }
    if (typeof entry.block !== "string") throw new Error("blueprint block name must be a string");
    const block = entry.block.trim().toLowerCase();
    if (!block) throw new Error("blueprint block name cannot be empty");
    const key = `${x},${y},${z}`;
    if (seen.has(key)) throw new Error(`duplicate blueprint coordinate ${key}`);
    seen.add(key);
    const hint = normalizePlacementHint(entry.hint, block, options);
    return {
      x: x as number,
      y: y as number,
      z: z as number,
      block,
      ...(hint === undefined ? {} : { hint }),
    };
  }).sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
}

function validateBlueprintName(value: unknown): string {
  if (typeof value !== "string") throw new Error("blueprint name must be a string");
  const name = value.trim();
  if (!name || name.length > 120) throw new Error("blueprint name must be 1-120 characters");
  return name;
}

export function upsertBlueprint(
  db: DB,
  input: BlueprintInput,
  now = Date.now(),
): BlueprintRow {
  const name = validateBlueprintName(input.name);
  const blocks = validateBlocks(input.blocks, MAX_RAW_BLUEPRINT_BLOCKS, {
    allowHints: false,
    label: "raw blueprint",
  });
  const existing = getBlueprintByName(db, name);
  if (existing) {
    assertBlueprintMutable(db, existing);
    if (getBlueprintSource(db, existing.id)) {
      throw new Error(`blueprint '${name}' is source-backed and must be updated through trusted compilation`);
    }
  }
  db.prepare(
    `INSERT INTO blueprints (ts_created, ts_updated, name, blocks_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       ts_updated = excluded.ts_updated,
       blocks_json = excluded.blocks_json`,
  ).run(now, now, name, JSON.stringify(blocks));
  const row = getBlueprintByName(db, name);
  if (!row) throw new Error(`blueprint '${name}' missing after upsert`);
  return row;
}

/**
 * Persist compiler-vetted cells and their immutable source envelope in one
 * SQLite transaction. Raw callers never reach this 4,096-cell code path.
 */
export function registerCompiledBlueprint(
  db: DB,
  input: TrustedCompiledBlueprintInput,
  now = Date.now(),
): BlueprintRow {
  const name = validateBlueprintName(input.name);
  const blocks = validateBlocks(input.blocks, MAX_COMPILED_BLUEPRINT_BLOCKS, {
    allowHints: true,
    label: "compiled blueprint",
  });
  const source = validateCompiledSourceInput(input);
  const transaction = db.transaction(() => {
    const existing = getBlueprintByName(db, name);
    if (existing) assertBlueprintMutable(db, existing);
    db.prepare(
      `INSERT INTO blueprints (ts_created, ts_updated, name, blocks_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         ts_updated = excluded.ts_updated,
         blocks_json = excluded.blocks_json`,
    ).run(now, now, name, JSON.stringify(blocks));
    const blueprint = getBlueprintByName(db, name);
    if (!blueprint) throw new Error(`blueprint '${name}' missing after trusted registration`);
    db.prepare(
      `INSERT INTO blueprint_sources
         (blueprint_id, ts_created, ts_updated, source_schema, target_version,
          source_json, source_hash, compile_report_json, creator_username, creator_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(blueprint_id) DO UPDATE SET
         ts_updated = excluded.ts_updated,
         source_schema = excluded.source_schema,
         target_version = excluded.target_version,
         source_json = excluded.source_json,
         source_hash = excluded.source_hash,
         compile_report_json = excluded.compile_report_json,
         creator_username = excluded.creator_username,
         creator_source = excluded.creator_source`,
    ).run(
      blueprint.id,
      now,
      now,
      source.schema,
      source.targetVersion,
      source.sourceJson,
      source.sourceHash,
      source.compileReportJson,
      source.creator.username,
      source.creator.source,
    );
    return getBlueprint(db, blueprint.id)!;
  });
  return transaction();
}

export function getBlueprint(db: DB, id: number): BlueprintRow | undefined {
  const row = db.prepare(
    `SELECT id, ts_created, ts_updated, name, blocks_json
     FROM blueprints WHERE id = ?`,
  ).get(id) as {
    id: number;
    ts_created: number;
    ts_updated: number;
    name: string;
    blocks_json: string;
  } | undefined;
  return row ? mapBlueprint(row) : undefined;
}

export function getBlueprintByName(db: DB, name: string): BlueprintRow | undefined {
  const row = db.prepare(
    `SELECT id, ts_created, ts_updated, name, blocks_json
     FROM blueprints WHERE name = ?`,
  ).get(name) as {
    id: number;
    ts_created: number;
    ts_updated: number;
    name: string;
    blocks_json: string;
  } | undefined;
  return row ? mapBlueprint(row) : undefined;
}

export function listBlueprints(db: DB): BlueprintRow[] {
  const rows = db.prepare(
    `SELECT id, ts_created, ts_updated, name, blocks_json
     FROM blueprints ORDER BY name COLLATE NOCASE`,
  ).all() as Array<{
    id: number;
    ts_created: number;
    ts_updated: number;
    name: string;
    blocks_json: string;
  }>;
  return rows.map(mapBlueprint);
}

export function getBlueprintSource(db: DB, blueprintId: number): BlueprintSourceRow | undefined {
  const row = db.prepare(
    `SELECT blueprint_id, ts_created, ts_updated, source_schema, target_version,
            source_json, source_hash, compile_report_json, creator_username, creator_source
     FROM blueprint_sources WHERE blueprint_id = ?`,
  ).get(blueprintId) as BlueprintSourceDbRow | undefined;
  return row ? mapBlueprintSource(row) : undefined;
}

export function getBlueprintSourceByName(db: DB, name: string): BlueprintSourceRow | undefined {
  const blueprint = getBlueprintByName(db, name);
  return blueprint ? getBlueprintSource(db, blueprint.id) : undefined;
}

export function createConstructionJob(
  db: DB,
  input: ConstructionJobInput,
  now = Date.now(),
): ConstructionJobRow {
  const blueprint = getBlueprint(db, input.blueprintId);
  if (!blueprint) throw new Error(`no blueprint ${input.blueprintId}`);
  const result = db.prepare(
    `INSERT INTO construction_jobs
       (ts_created, ts_updated, blueprint_id, dimension, origin_x, origin_y,
        origin_z, rotation, storage_name, status, total_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    now,
    now,
    blueprint.id,
    input.dimension ?? "overworld",
    input.originX,
    input.originY,
    input.originZ,
    input.rotation ?? 0,
    input.storageName ?? null,
    countExpectedWorldCells(blueprint.placementUnits),
  );
  return getConstructionJob(db, Number(result.lastInsertRowid))!;
}

export function getConstructionJob(db: DB, id: number): ConstructionJobRow | undefined {
  const row = db.prepare(
    `SELECT j.id, j.ts_created, j.ts_updated, j.blueprint_id,
            b.name AS blueprint_name, j.dimension, j.origin_x, j.origin_y,
            j.origin_z, j.rotation, j.storage_name, j.status, j.placed_count,
            j.total_count, j.last_plan_id, j.last_error
     FROM construction_jobs j
     JOIN blueprints b ON b.id = j.blueprint_id
     WHERE j.id = ?`,
  ).get(id) as ConstructionDbRow | undefined;
  return row ? mapJob(row) : undefined;
}

export function getConstructionJobByPlan(
  db: DB,
  planId: number,
): ConstructionJobRow | undefined {
  return listConstructionJobsByPlan(db, planId)[0];
}

/**
 * A task plan can own more than one build (for example, a mixed mission).
 * Keep the legacy singular reader above for ordinary construction callers,
 * but make new plan-level work deterministic and plural.
 */
export function listConstructionJobsByPlan(
  db: DB,
  planId: number,
): ConstructionJobRow[] {
  assertPositiveConstructionPlanId(planId);
  const rows = db.prepare(
    `SELECT j.id, j.ts_created, j.ts_updated, j.blueprint_id,
            b.name AS blueprint_name, j.dimension, j.origin_x, j.origin_y,
            j.origin_z, j.rotation, j.storage_name, j.status, j.placed_count,
            j.total_count, j.last_plan_id, j.last_error
     FROM construction_jobs j
     JOIN blueprints b ON b.id = j.blueprint_id
     WHERE j.last_plan_id = ?
     ORDER BY j.id ASC`,
  ).all(planId) as ConstructionDbRow[];
  return rows.map(mapJob);
}

/**
 * Find terminal mission plans that still own an unsettled construction job.
 * This deliberately joins `mission_runs` instead of trusting an in-memory
 * listener or the nonterminal mission-run list: a crash can persist a run's
 * terminal state before its job transition is observed. The caller pages by
 * plan ID until exhaustion.
 */
export function listTerminalMissionConstructionPlans(
  db: DB,
  input: ListTerminalMissionConstructionPlansInput = {},
): TerminalMissionConstructionPlan[] {
  const afterPlanId = input.afterPlanId === undefined
    ? 0
    : normalizeNonNegativeConstructionPlanId(input.afterPlanId, "terminal mission plan cursor");
  const limit = input.limit === undefined
    ? MAX_TERMINAL_MISSION_BUILD_RECONCILIATION_BATCH
    : normalizeTerminalMissionPlanReconciliationLimit(input.limit);
  const rows = db.prepare(
    `SELECT p.id AS plan_id, p.status AS task_plan_status, p.last_error AS task_plan_error
     FROM task_plans p
     JOIN mission_runs mission ON mission.task_plan_id = p.id
     WHERE p.id > ?
       AND p.status IN ('completed', 'failed', 'cancelled')
       AND EXISTS (
         SELECT 1
         FROM construction_jobs job
         WHERE job.last_plan_id = p.id
           AND job.status IN ('pending', 'running', 'paused', 'blocked')
       )
     ORDER BY p.id ASC
     LIMIT ?`,
  ).all(afterPlanId, limit) as Array<{
    plan_id: number;
    task_plan_status: ConstructionTerminalTaskPlanStatus;
    task_plan_error: string | null;
  }>;
  return rows.map((row) => ({
    planId: row.plan_id,
    taskPlanStatus: row.task_plan_status,
    taskPlanError: row.task_plan_error,
  }));
}

export function findResumableConstructionJob(
  db: DB,
  input: {
    blueprintId: number;
    dimension: string;
    originX: number;
    originY: number;
    originZ: number;
    rotation: BuildRotation;
  },
): ConstructionJobRow | undefined {
  const row = db.prepare(
    `SELECT j.id, j.ts_created, j.ts_updated, j.blueprint_id,
            b.name AS blueprint_name, j.dimension, j.origin_x, j.origin_y,
            j.origin_z, j.rotation, j.storage_name, j.status, j.placed_count,
            j.total_count, j.last_plan_id, j.last_error
     FROM construction_jobs j
     JOIN blueprints b ON b.id = j.blueprint_id
     WHERE j.blueprint_id = ?
       AND j.dimension = ?
       AND j.origin_x = ?
       AND j.origin_y = ?
       AND j.origin_z = ?
       AND j.rotation = ?
       AND j.status IN ('pending', 'running', 'paused', 'blocked', 'failed')
     ORDER BY j.ts_created DESC
     LIMIT 1`,
  ).get(
    input.blueprintId,
    input.dimension,
    input.originX,
    input.originY,
    input.originZ,
    input.rotation,
  ) as ConstructionDbRow | undefined;
  return row ? mapJob(row) : undefined;
}

export function markConstructionPlan(
  db: DB,
  jobId: number,
  planId: number,
  now = Date.now(),
): boolean {
  assertPositiveConstructionJobId(jobId);
  assertPositiveConstructionPlanId(planId);
  assertConstructionTimestamp(now);
  // Scheduling a fresh plan is only valid before the job has started. In
  // particular, a pause/cancel racing with plan creation must win rather than
  // being rewritten to `running` by this delayed store write.
  const result = db.prepare(
    `UPDATE construction_jobs
     SET status = 'running', last_plan_id = ?, last_error = NULL, ts_updated = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(planId, now, jobId);
  return result.changes > 0;
}

/**
 * Atomically attach a bounded group of freshly-created jobs to one newly
 * persisted task plan. This is deliberately stricter than the legacy
 * single-job `markConstructionPlan`: every supplied job must still be
 * pending and unlinked, and the target plan must be pending with immutable
 * actor provenance. A failed validation leaves every job untouched.
 *
 * Mission materialization may call this inside a larger SQLite transaction;
 * better-sqlite3 nests this helper as a savepoint, preserving the outer
 * all-or-nothing run/job/plan write.
 */
export function linkPendingConstructionJobsToPlan(
  db: DB,
  jobIds: readonly number[],
  planId: number,
  now = Date.now(),
): ConstructionJobRow[] {
  const ids = normalizeConstructionJobIds(jobIds);
  assertPositiveConstructionPlanId(planId);
  assertConstructionTimestamp(now);
  const placeholders = ids.map(() => "?").join(", ");
  const link = db.transaction(() => {
    const plan = db.prepare(
      `SELECT p.id
       FROM task_plans p
       JOIN task_plan_actors actor ON actor.plan_id = p.id
       WHERE p.id = ? AND p.status = 'pending'`,
    ).get(planId) as { id: number } | undefined;
    if (!plan) {
      throw new Error(
        `construction jobs can only link to a pending task plan with actor provenance (plan ${planId})`,
      );
    }

    const candidates = db.prepare(
      `SELECT id, status, last_plan_id
       FROM construction_jobs
       WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<{
      id: number;
      status: ConstructionStatus;
      last_plan_id: number | null;
    }>;
    if (candidates.length !== ids.length) {
      throw new Error("cannot link construction jobs that do not exist");
    }
    if (candidates.some((job) => job.status !== "pending" || job.last_plan_id !== null)) {
      throw new Error("construction jobs must be pending and unlinked before they can join a task plan");
    }

    const result = db.prepare(
      `UPDATE construction_jobs
       SET status = 'running', last_plan_id = ?, last_error = NULL, ts_updated = ?
       WHERE id IN (${placeholders})
         AND status = 'pending'
         AND last_plan_id IS NULL`,
    ).run(planId, now, ...ids);
    if (result.changes !== ids.length) {
      // A concurrent control-plane write won between validation and update.
      // Throwing rolls back the whole batch, including any earlier rows.
      throw new Error("construction job link lost its pending/unlinked state");
    }

    const linked = new Map(listConstructionJobsByPlan(db, planId).map((job) => [job.id, job]));
    return ids.map((id) => {
      const job = linked.get(id);
      if (!job) throw new Error(`construction job ${id} disappeared after linking`);
      return job;
    });
  });
  return link();
}

/**
 * Apply a safe plan-level lifecycle transition to every job owned by that
 * exact plan. Completed jobs remain completed; a paused/cancelled job cannot
 * be revived by a stale controller for another plan.
 */
export function setConstructionJobsStatusByPlan(
  db: DB,
  planId: number,
  status: ConstructionPlanLifecycleStatus,
  error?: string,
  now = Date.now(),
): ConstructionJobRow[] {
  assertPositiveConstructionPlanId(planId);
  const normalizedStatus = normalizeConstructionPlanLifecycleStatus(status);
  const normalizedError = error === undefined ? null : normalizeConstructionError(error);
  assertConstructionTimestamp(now);
  const expectedStatuses = DEFAULT_CONSTRUCTION_STATUS_SOURCES[normalizedStatus];
  const placeholders = expectedStatuses.map(() => "?").join(", ");
  const transition = db.transaction(() => {
    db.prepare(
      `UPDATE construction_jobs
       SET status = ?, last_error = ?, ts_updated = ?
       WHERE last_plan_id = ?
         AND status IN (${placeholders})`,
    ).run(normalizedStatus, normalizedError, now, planId, ...expectedStatuses);
    return listConstructionJobsByPlan(db, planId);
  });
  return transition();
}

/**
 * Reconcile jobs linked to a terminal task plan after a missed durable event
 * (for example, process restart). Completed jobs stay completed, but every
 * other non-cancelled job is terminalized so a failed/cancelled plan cannot
 * leave a runnable construction attempt behind. A completed task plan is
 * never proof of a completed build: incomplete jobs become failed unless the
 * live build verifier had already recorded `completed`.
 */
export function reconcileConstructionJobsForTerminalTaskPlan(
  db: DB,
  planId: number,
  taskPlanStatus: ConstructionTerminalTaskPlanStatus,
  error: string | undefined = undefined,
  now = Date.now(),
): ConstructionJobRow[] {
  assertPositiveConstructionPlanId(planId);
  assertConstructionTimestamp(now);
  const transition = db.transaction(() => {
    if (taskPlanStatus === "cancelled") {
      // Cancellation is idempotent and may safely absorb every incomplete
      // job, while a verified completed build remains immutable history.
      db.prepare(
        `UPDATE construction_jobs
         SET status = 'cancelled', last_error = ?, ts_updated = ?
         WHERE last_plan_id = ?
           AND status IN ('pending', 'running', 'paused', 'blocked', 'failed', 'cancelled')`,
      ).run(error === undefined ? null : normalizeConstructionError(error), now, planId);
    } else {
      const resolvedError = taskPlanStatus === "completed"
        ? error ?? UNVERIFIED_CONSTRUCTION_COMPLETION_ERROR
        : error ?? "linked task plan failed";
      db.prepare(
        `UPDATE construction_jobs
         SET status = 'failed', last_error = ?, ts_updated = ?
         WHERE last_plan_id = ?
           AND status IN ('pending', 'running', 'paused', 'blocked', 'failed')`,
      ).run(normalizeConstructionError(resolvedError), now, planId);
    }
    return listConstructionJobsByPlan(db, planId);
  });
  return transition();
}

export function updateConstructionProgress(
  db: DB,
  jobId: number,
  placedCount: number,
  now = Date.now(),
): boolean {
  return updateConstructionProgressIfCurrent(db, {
    jobId,
    placedCount,
    expectedStatuses: ["running"],
  }, now);
}

/**
 * Atomically update construction progress only while the same active attempt
 * remains runnable. A paused/cancelled job deliberately retains its last
 * confirmed count even if a stale asynchronous skill returns afterward.
 */
export function updateConstructionProgressIfCurrent(
  db: DB,
  input: UpdateConstructionProgressIfCurrentInput,
  now = Date.now(),
): boolean {
  const condition = normalizeConstructionJobCondition(input);
  const placedCount = normalizeConstructionPlacedCount(input.placedCount);
  assertConstructionTimestamp(now);
  const { where, parameters } = constructionJobConditionSql(condition);
  const result = db.prepare(
    `UPDATE construction_jobs
     SET placed_count = ?, ts_updated = ?
     WHERE ${where}`,
  ).run(placedCount, now, ...parameters);
  return result.changes > 0;
}

/**
 * Apply a status only if its durable current state still matches the caller's
 * expected execution state. This is the builder-facing primitive: use
 * `expectedStatuses: ["running"]` for all in-flight lifecycle writes so a
 * concurrent pause/cancel cannot be overwritten by running/completed/failed.
 */
export function setConstructionStatusIfCurrent(
  db: DB,
  input: SetConstructionStatusIfCurrentInput,
  now = Date.now(),
): boolean {
  const condition = normalizeConstructionJobCondition(input);
  const status = normalizeConstructionStatus(input.status);
  const error = input.error === undefined ? null : normalizeConstructionError(input.error);
  assertConstructionTimestamp(now);
  const { where, parameters } = constructionJobConditionSql(condition);
  const result = db.prepare(
    `UPDATE construction_jobs
     SET status = ?, last_error = ?, ts_updated = ?
     WHERE ${where}`,
  ).run(status, error, now, ...parameters);
  return result.changes > 0;
}

/**
 * Backward-compatible control-plane transition helper. Its legal source
 * states prevent terminal/cancelled jobs from being revived accidentally;
 * execution code must use `setConstructionStatusIfCurrent` for its stricter
 * `running` condition.
 */
export function setConstructionStatus(
  db: DB,
  jobId: number,
  status: ConstructionStatus,
  error?: string,
  now = Date.now(),
): boolean {
  const normalizedStatus = normalizeConstructionStatus(status);
  return setConstructionStatusIfCurrent(db, {
    jobId,
    status: normalizedStatus,
    error,
    expectedStatuses: DEFAULT_CONSTRUCTION_STATUS_SOURCES[normalizedStatus],
  }, now);
}

function normalizeConstructionJobCondition(
  input: ConstructionJobStatusCondition & { jobId: number },
): {
  jobId: number;
  expectedStatuses: readonly ConstructionStatus[];
  expectedPlanId?: number;
  expectedNoPlan?: true;
} {
  assertPositiveConstructionJobId(input.jobId);
  if (!Array.isArray(input.expectedStatuses) || input.expectedStatuses.length === 0) {
    throw new Error("construction status condition requires at least one expected status");
  }
  if (input.expectedStatuses.length > CONSTRUCTION_STATUSES.size) {
    throw new Error("construction status condition has too many expected statuses");
  }
  const seen = new Set<ConstructionStatus>();
  const expectedStatuses = input.expectedStatuses.map((status) => {
    const normalized = normalizeConstructionStatus(status);
    if (seen.has(normalized)) {
      throw new Error("construction status condition contains a duplicate status");
    }
    seen.add(normalized);
    return normalized;
  });
  const expectedPlanId = input.expectedPlanId;
  if (expectedPlanId !== undefined) assertPositiveConstructionPlanId(expectedPlanId);
  const expectedNoPlan = input.expectedNoPlan;
  if (expectedNoPlan !== undefined && expectedNoPlan !== true) {
    throw new Error("construction status condition expectedNoPlan must be true when present");
  }
  if (expectedPlanId !== undefined && expectedNoPlan === true) {
    throw new Error("construction status condition cannot require both a plan and no plan");
  }
  return {
    jobId: input.jobId,
    expectedStatuses: Object.freeze(expectedStatuses),
    ...(expectedPlanId === undefined ? {} : { expectedPlanId }),
    ...(expectedNoPlan === true ? { expectedNoPlan: true as const } : {}),
  };
}

function constructionJobConditionSql(condition: {
  jobId: number;
  expectedStatuses: readonly ConstructionStatus[];
  expectedPlanId?: number;
  expectedNoPlan?: true;
}): { where: string; parameters: readonly (number | ConstructionStatus)[] } {
  const statusPlaceholders = condition.expectedStatuses.map(() => "?").join(", ");
  return {
    where: `id = ? AND status IN (${statusPlaceholders})` +
      (condition.expectedPlanId !== undefined
        ? " AND last_plan_id = ?"
        : condition.expectedNoPlan === true
          ? " AND last_plan_id IS NULL"
          : ""),
    parameters: [
      condition.jobId,
      ...condition.expectedStatuses,
      ...(condition.expectedPlanId === undefined ? [] : [condition.expectedPlanId]),
    ],
  };
}

function normalizeConstructionStatus(value: unknown): ConstructionStatus {
  if (!CONSTRUCTION_STATUSES.has(value as ConstructionStatus)) {
    throw new Error("unknown construction status");
  }
  return value as ConstructionStatus;
}

function normalizeConstructionPlanLifecycleStatus(value: unknown): ConstructionPlanLifecycleStatus {
  if (value !== "paused" && value !== "running" && value !== "failed" && value !== "cancelled") {
    throw new Error("unknown construction plan lifecycle status");
  }
  return value;
}

function normalizeConstructionPlacedCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("construction placed count must be a non-negative integer");
  }
  return value as number;
}

function normalizeConstructionError(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("construction error must be a string no longer than 4096 characters");
  }
  return value;
}

function assertPositiveConstructionJobId(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("construction job id must be a positive integer");
  }
}

function normalizeConstructionJobIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("construction job link requires at least one job id");
  }
  if (value.length > MAX_CONSTRUCTION_JOB_LINK_BATCH) {
    throw new Error(`construction job link accepts at most ${MAX_CONSTRUCTION_JOB_LINK_BATCH} job ids`);
  }
  const seen = new Set<number>();
  return value.map((id) => {
    assertPositiveConstructionJobId(id);
    if (seen.has(id)) throw new Error("construction job link contains a duplicate job id");
    seen.add(id);
    return id;
  });
}

function assertPositiveConstructionPlanId(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("construction plan id must be a positive integer");
  }
}

function normalizeNonNegativeConstructionPlanId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function normalizeTerminalMissionPlanReconciliationLimit(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAX_TERMINAL_MISSION_BUILD_RECONCILIATION_BATCH
  ) {
    throw new Error(
      `terminal mission plan reconciliation limit must be 1-${MAX_TERMINAL_MISSION_BUILD_RECONCILIATION_BATCH}`,
    );
  }
  return value as number;
}

function assertConstructionTimestamp(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("construction timestamp must be a non-negative integer");
  }
}

function mapBlueprint(row: {
  id: number;
  ts_created: number;
  ts_updated: number;
  name: string;
  blocks_json: string;
}): BlueprintRow {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.blocks_json);
  } catch {
    throw new Error(`blueprint '${row.name}' has invalid persisted blocks JSON`);
  }
  const blocks = validateBlocks(decoded, MAX_COMPILED_BLUEPRINT_BLOCKS, {
    // A source-backed compiled blueprint persists hints. Legacy raw cells do
    // not contain them, and malformed values below fail before execution.
    allowHints: true,
    label: `persisted blueprint '${row.name}'`,
  });
  return {
    id: row.id,
    tsCreated: row.ts_created,
    tsUpdated: row.ts_updated,
    name: row.name,
    blocks,
    placementUnits: normalizeBlueprintPlacementUnits(blocks),
  };
}

function cloneBlueprintBlock(block: BlueprintBlock): BlueprintBlock {
  return {
    x: block.x,
    y: block.y,
    z: block.z,
    block: block.block,
    ...(block.hint === undefined ? {} : { hint: clonePlacementHint(block.hint) }),
  };
}

const HINT_FACINGS = new Set<NonNullable<PlacementHint["facing"]>>([
  "north", "south", "east", "west",
]);
const HINT_HALVES = new Set<NonNullable<PlacementHint["half"]>>(["top", "bottom"]);
const ONE_CELL_HINTED_BLOCK = /^[a-z0-9_]+_stairs$/;

/**
 * Keep the durable hint vocabulary exactly aligned with the verified v1
 * placement adapter. This protects both direct trusted-store callers and
 * corrupted database rows from introducing arbitrary state instructions.
 */
function normalizePlacementHint(
  value: unknown,
  block: string,
  options: ValidateBlocksOptions,
): PlacementHint | undefined {
  if (value === undefined) return undefined;
  if (!options.allowHints) {
    throw new Error("raw blueprints cannot include placement hints; use trusted BuildOps compilation");
  }
  if (!isRecord(value)) throw new Error(`${options.label} placement hint must be an object`);
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== "facing" && key !== "half")) {
    throw new Error(`${options.label} placement hint contains unsupported properties`);
  }
  if (!ONE_CELL_HINTED_BLOCK.test(block)) {
    throw new Error(`${options.label} placement hints are supported only for one-cell *_stairs blocks`);
  }

  const facing = value.facing;
  const half = value.half;
  if (facing !== undefined && (typeof facing !== "string" || !HINT_FACINGS.has(facing as NonNullable<PlacementHint["facing"]>))) {
    throw new Error(`${options.label} placement hint facing must be north, south, east, or west`);
  }
  if (half !== undefined && (typeof half !== "string" || !HINT_HALVES.has(half as NonNullable<PlacementHint["half"]>))) {
    throw new Error(`${options.label} placement hint half must be top or bottom`);
  }
  return {
    ...(facing === undefined ? {} : { facing: facing as NonNullable<PlacementHint["facing"]> }),
    ...(half === undefined ? {} : { half: half as NonNullable<PlacementHint["half"]> }),
  };
}

function clonePlacementHint(hint: PlacementHint): PlacementHint {
  return {
    ...(hint.facing === undefined ? {} : { facing: hint.facing }),
    ...(hint.half === undefined ? {} : { half: hint.half }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBlueprintMutable(db: DB, blueprint: Pick<BlueprintRow, "id" | "name">): void {
  const active = db.prepare(
    `SELECT COUNT(*) AS count FROM construction_jobs
     WHERE blueprint_id = ?
       AND status NOT IN ('completed', 'cancelled')`,
  ).get(blueprint.id) as { count: number };
  if (active.count > 0) {
    throw new Error(`blueprint '${blueprint.name}' has active construction jobs`);
  }
}

function validateCompiledSourceInput(input: TrustedCompiledBlueprintInput): {
  schema: string;
  targetVersion: string;
  sourceJson: string;
  sourceHash: string;
  compileReportJson: string;
  creator: ExecutionActor;
} {
  const schema = validateBoundedText("source schema", input.sourceSchema, 128);
  const targetVersion = validateBoundedText("target version", input.targetVersion, 64);
  const sourceJson = validateJsonText("canonical source", input.sourceJson, MAX_BLUEPRINT_SOURCE_BYTES);
  const sourceHash = validateBoundedText("source hash", input.sourceHash, 128);
  if (!/^[a-f0-9]{64}$/i.test(sourceHash)) throw new Error("source hash must be a SHA-256 hex digest");
  const compileReportJson = validateJsonText("compile report", input.compileReportJson, MAX_BLUEPRINT_SOURCE_BYTES);
  return {
    schema,
    targetVersion,
    sourceJson,
    sourceHash: sourceHash.toLowerCase(),
    compileReportJson,
    creator: snapshotExecutionActor(input.creator),
  };
}

function validateBoundedText(label: string, value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximum) {
    throw new Error(`${label} must be 1-${maximum} UTF-8 bytes`);
  }
  return normalized;
}

function validateJsonText(label: string, value: unknown, maximum: number): string {
  const normalized = validateBoundedText(label, value, maximum);
  try {
    JSON.parse(normalized);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  return normalized;
}

interface BlueprintSourceDbRow {
  blueprint_id: number;
  ts_created: number;
  ts_updated: number;
  source_schema: string;
  target_version: string;
  source_json: string;
  source_hash: string;
  compile_report_json: string;
  creator_username: string;
  creator_source: ExecutionSource;
}

function mapBlueprintSource(row: BlueprintSourceDbRow): BlueprintSourceRow {
  return {
    blueprintId: row.blueprint_id,
    tsCreated: row.ts_created,
    tsUpdated: row.ts_updated,
    schema: row.source_schema,
    targetVersion: row.target_version,
    sourceJson: row.source_json,
    sourceHash: row.source_hash,
    compileReportJson: row.compile_report_json,
    // Source rows intentionally record no stale role; execution must resolve
    // the current authorization for this username before use.
    creator: { username: row.creator_username, source: row.creator_source },
  };
}

interface ConstructionDbRow {
  id: number;
  ts_created: number;
  ts_updated: number;
  blueprint_id: number;
  blueprint_name: string;
  dimension: string;
  origin_x: number;
  origin_y: number;
  origin_z: number;
  rotation: BuildRotation;
  storage_name: string | null;
  status: ConstructionStatus;
  placed_count: number;
  total_count: number;
  last_plan_id: number | null;
  last_error: string | null;
}

function mapJob(row: ConstructionDbRow): ConstructionJobRow {
  return {
    id: row.id,
    tsCreated: row.ts_created,
    tsUpdated: row.ts_updated,
    blueprintId: row.blueprint_id,
    blueprintName: row.blueprint_name,
    dimension: row.dimension,
    originX: row.origin_x,
    originY: row.origin_y,
    originZ: row.origin_z,
    rotation: row.rotation,
    storageName: row.storage_name,
    status: row.status,
    placedCount: row.placed_count,
    totalCount: row.total_count,
    lastPlanId: row.last_plan_id,
    lastError: row.last_error,
  };
}
