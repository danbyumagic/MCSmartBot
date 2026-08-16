import type { DB } from "../memory/db.js";
import { hashBuildSource } from "../construction/buildOps/compiler.js";
import { parseBuildSource } from "../construction/buildOps/schema.js";
import {
  fingerprintBlueprintExecution,
  getBlueprint,
  getBlueprintSource,
} from "../construction/store.js";
import {
  parsePersistedExecutionActor,
  snapshotExecutionActor,
  type ExecutionActor,
  type ExecutionSource,
} from "../permissions/executionActor.js";
import {
  canonicalizeMissionSource,
  hashMissionSource,
  parseMissionDefinition,
} from "./schema.js";
import {
  MAX_MISSION_LINKS_PER_RUN,
  MAX_MISSION_LIST_RESULTS,
  MAX_MISSION_SOURCE_BYTES,
  MISSION_EXPANDED_TASKS_METADATA_KEY,
  MISSION_NAMED_BLUEPRINT_FINGERPRINT_METADATA_KEY,
  MISSION_SCHEMA,
  type MissionBuildStep,
  type MissionDefinition,
  type MissionDefinitionCreator,
  type MissionDefinitionDetail,
  type MissionExpandedTaskMetadata,
  type MissionDefinitionRow,
  type MissionDefinitionSummary,
  type MissionJsonValue,
  type MissionLimits,
  type MissionRunDetail,
  type MissionRunRow,
  type MissionRunStatus,
  type MissionRunSummary,
  type MissionStepLinkRow,
} from "./types.js";

export const MAX_MISSION_COMPILE_REPORT_BYTES = 32 * 1024;
export const MAX_MISSION_CORRELATION_BYTES = 16 * 1024;
/**
 * Resolved expansion metadata includes schema-normalized task params. A
 * MissionScript source itself may be 64 KiB, so a smaller per-link cap would
 * make a valid source impossible to materialize durably.
 */
export const MAX_MISSION_LINK_METADATA_BYTES = MAX_MISSION_SOURCE_BYTES;
export const MAX_MISSION_TRANSACTION_SCOPE_LENGTH = 128;
export const MAX_MISSION_ERROR_LENGTH = 1_024;

const MISSION_STATUSES = new Set<MissionRunStatus>([
  "pending", "running", "paused", "completed", "failed", "cancelled",
]);
const MISSION_TRANSITIONS: Readonly<Record<MissionRunStatus, readonly MissionRunStatus[]>> = {
  pending: ["running", "paused", "failed", "cancelled"],
  running: ["paused", "completed", "failed", "cancelled"],
  paused: ["pending", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export class MissionStoreError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "NAME_CONFLICT"
      | "NOT_FOUND"
      | "IMMUTABLE"
      | "INVALID_TRANSITION"
      | "PERSISTENCE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "MissionStoreError";
  }
}

export interface SaveMissionDefinitionInput {
  readonly definition: unknown;
  readonly creator: ExecutionActor;
  /** Existing names are replaced only when the caller explicitly opts in. */
  readonly replace?: boolean;
  readonly enabled?: boolean;
}

export interface CreateMissionRunInput {
  /** A saved definition captures its current canonical source at this moment. */
  readonly definitionId?: number;
  /** Required for an ad-hoc run; must match definitionId exactly when both are supplied. */
  readonly definition?: unknown;
  readonly actor: ExecutionActor;
  readonly compileReport?: Readonly<Record<string, MissionJsonValue>>;
  readonly transactionCorrelation?: Readonly<Record<string, MissionJsonValue>>;
  readonly deadlineAt?: number;
}

export interface MissionStepLinkInput {
  readonly logicalStepId: string;
  readonly logicalPosition: number;
  readonly expandedStartPosition: number;
  readonly expandedStepCount: number;
  readonly constructionJobId?: number;
  /**
   * Immutable compiler provenance. It must include the resolved expanded task
   * descriptors under `MISSION_EXPANDED_TASKS_METADATA_KEY`.
   */
  readonly compileMetadata: Readonly<Record<string, MissionJsonValue>>;
}

export interface ListMissionDefinitionsInput {
  readonly enabled?: boolean;
  readonly limit?: number;
}

export interface ListMissionRunsInput {
  readonly definitionId?: number;
  readonly taskPlanId?: number;
  readonly status?: MissionRunStatus;
  readonly limit?: number;
}

/**
 * Internal restart-recovery cursor. This intentionally is not part of the
 * user-facing list API: callers advance by durable run ID until every active
 * run has been reconciled, rather than silently stopping at a recent-result
 * display cap.
 */
export interface ListActiveMissionRunsInput {
  /** Exclusive durable run-ID cursor. */
  readonly afterId?: number;
  readonly limit?: number;
}

/**
 * Task 13 uses this inside its outer SQLite transaction after it has inserted
 * the task plan. A run can be linked only once, while still pending.
 */
export function attachMissionRunTaskPlan(
  db: DB,
  missionRunId: number,
  taskPlanId: number,
  now = Date.now(),
): MissionRunDetail | undefined {
  const runId = positiveId(missionRunId, "mission run id");
  const planId = positiveId(taskPlanId, "task plan id");
  const timestamp = normalizeTimestamp(now, "now");
  const attach = db.transaction(() => {
    const plan = db.prepare(
      `SELECT p.id, p.status, a.actor_username, a.actor_role, a.actor_source
       FROM task_plans p
       LEFT JOIN task_plan_actors a ON a.plan_id = p.id
       WHERE p.id = ?`,
    ).get(planId) as {
      id: number;
      status: string;
      actor_username: string | null;
      actor_role: string | null;
      actor_source: string | null;
    } | undefined;
    if (!plan) throw new MissionStoreError("NOT_FOUND", `task plan ${planId} does not exist`);
    if (plan.status !== "pending") {
      throw new MissionStoreError("IMMUTABLE", `task plan ${planId} must be pending before a mission can link it`);
    }
    const run = getMissionRun(db, runId);
    if (!run) return undefined;
    if (plan.actor_username === null || plan.actor_role === null || plan.actor_source === null) {
      throw new MissionStoreError("PERSISTENCE_FAILED", `task plan ${planId} is missing actor provenance`);
    }
    const planActor = parsePersistedExecutionActor({
      username: plan.actor_username,
      role: plan.actor_role,
      source: plan.actor_source,
    });
    if (
      planActor.username !== run.actor.username ||
      planActor.role !== run.actor.role ||
      planActor.source !== run.actor.source
    ) {
      throw new MissionStoreError("IMMUTABLE", "mission run and task plan actors must match exactly");
    }
    const result = db.prepare(
      `UPDATE mission_runs
       SET task_plan_id = ?, ts_updated = ?
       WHERE id = ? AND status = 'pending' AND task_plan_id IS NULL`,
    ).run(planId, timestamp, runId);
    if (result.changes === 0) {
      throw new MissionStoreError(
        "IMMUTABLE",
        `mission run ${runId} can be linked to a task plan only once while pending`,
      );
    }
    return getMissionRun(db, runId)!;
  });
  try {
    return attach();
  } catch (error) {
    if (isSqliteConstraint(error)) {
      throw new MissionStoreError("PERSISTENCE_FAILED", `task plan ${planId} is already linked to another mission run`);
    }
    throw error;
  }
}

interface DefinitionDbRow {
  id: number;
  ts_created: number;
  ts_updated: number;
  name: string;
  schema: string;
  source_json: string;
  source_hash: string;
  creator_username: string;
  creator_source: string;
  enabled: number;
}

interface RunDbRow {
  id: number;
  ts_created: number;
  ts_updated: number;
  definition_id: number | null;
  source_schema: string;
  source_json: string;
  source_hash: string;
  actor_username: string;
  actor_role: string;
  actor_source: string;
  limits_json: string;
  compile_report_json: string;
  task_plan_id: number | null;
  transaction_scope: string;
  transaction_correlation_json: string;
  deadline_at: number;
  status: string;
  ts_started: number | null;
  ts_finished: number | null;
  last_error: string | null;
}

interface LinkDbRow {
  id: number;
  mission_run_id: number;
  logical_step_id: string;
  logical_position: number;
  expanded_start_position: number;
  expanded_step_count: number;
  construction_job_id: number | null;
  compile_metadata_json: string;
}

/**
 * Validate and canonicalize before any write. Existing definitions never
 * change unless `replace` is explicit, while old mission runs retain their
 * own source snapshot.
 */
export function saveMissionDefinition(
  db: DB,
  input: SaveMissionDefinitionInput,
  now = Date.now(),
): MissionDefinitionDetail {
  const definition = parseDefinition(input.definition);
  const sourceJson = canonicalizeMissionSource(definition);
  const sourceHash = hashMissionSource(definition);
  const creator = snapshotActor(input.creator, "definition creator");
  const timestamp = normalizeTimestamp(now, "now");
  if (input.replace !== undefined && typeof input.replace !== "boolean") {
    throw invalid("definition replace must be boolean");
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw invalid("definition enabled must be boolean");
  }

  const save = db.transaction(() => {
    const existing = db.prepare(
      `${definitionSelect()} WHERE name = ? COLLATE NOCASE`,
    ).get(definition.name) as DefinitionDbRow | undefined;
    if (existing) {
      if (!input.replace) {
        throw new MissionStoreError(
          "NAME_CONFLICT",
          `mission definition '${definition.name}' already exists; set replace:true to update it`,
        );
      }
      db.prepare(
        `UPDATE mission_definitions
         SET ts_updated = ?, name = ?, schema = ?, source_json = ?, source_hash = ?,
             creator_username = ?, creator_source = ?, enabled = ?
         WHERE id = ?`,
      ).run(
        timestamp, definition.name, MISSION_SCHEMA, sourceJson, sourceHash,
        creator.username, creator.source,
        (input.enabled ?? persistedBoolean(existing.enabled, "mission definition enabled")) ? 1 : 0,
        existing.id,
      );
      return getMissionDefinition(db, existing.id)!;
    }
    const result = db.prepare(
      `INSERT INTO mission_definitions (
        ts_created, ts_updated, name, schema, source_json, source_hash,
        creator_username, creator_source, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      timestamp, timestamp, definition.name, MISSION_SCHEMA, sourceJson, sourceHash,
      creator.username, creator.source, input.enabled === false ? 0 : 1,
    );
    return getMissionDefinition(db, Number(result.lastInsertRowid))!;
  });
  return save();
}

export function getMissionDefinition(db: DB, id: number): MissionDefinitionDetail | undefined {
  const normalizedId = positiveId(id, "mission definition id");
  const row = db.prepare(
    `${definitionSelect()} WHERE id = ?`,
  ).get(normalizedId) as DefinitionDbRow | undefined;
  return row ? toMissionDefinitionDetail(row) : undefined;
}

export function getMissionDefinitionByName(db: DB, name: string): MissionDefinitionDetail | undefined {
  const normalizedName = normalizeName(name, "mission definition name");
  const row = db.prepare(
    `${definitionSelect()} WHERE name = ? COLLATE NOCASE`,
  ).get(normalizedName) as DefinitionDbRow | undefined;
  return row ? toMissionDefinitionDetail(row) : undefined;
}

/** Returns source-free, count-bounded projections suitable for UI/list callers. */
export function listMissionDefinitions(
  db: DB,
  input: ListMissionDefinitionsInput = {},
): MissionDefinitionSummary[] {
  const limit = normalizeListLimit(input.limit);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw invalid("definition enabled filter must be boolean");
  }
  const rows = input.enabled === undefined
    ? db.prepare(
      `SELECT id, ts_created, ts_updated, name, schema, source_hash,
              creator_username, creator_source, enabled
       FROM mission_definitions ORDER BY name COLLATE NOCASE ASC, id ASC LIMIT ?`,
    ).all(limit) as Array<Omit<DefinitionDbRow, "source_json">>
    : db.prepare(
      `SELECT id, ts_created, ts_updated, name, schema, source_hash,
              creator_username, creator_source, enabled
       FROM mission_definitions WHERE enabled = ?
       ORDER BY name COLLATE NOCASE ASC, id ASC LIMIT ?`,
    ).all(input.enabled ? 1 : 0, limit) as Array<Omit<DefinitionDbRow, "source_json">>;
  return rows.map(toMissionDefinitionSummary);
}

export function setMissionDefinitionEnabled(
  db: DB,
  id: number,
  enabled: boolean,
  now = Date.now(),
): MissionDefinitionDetail | undefined {
  const definitionId = positiveId(id, "mission definition id");
  if (typeof enabled !== "boolean") throw invalid("definition enabled must be boolean");
  const timestamp = normalizeTimestamp(now, "now");
  const result = db.prepare(
    `UPDATE mission_definitions SET enabled = ?, ts_updated = ? WHERE id = ?`,
  ).run(enabled ? 1 : 0, timestamp, definitionId);
  return result.changes === 0 ? undefined : getMissionDefinition(db, definitionId);
}

/**
 * Insert a pending run with its own immutable source/hash. It deliberately
 * does not create a task plan or execute anything; Task 13 owns that atomic
 * materialization boundary.
 */
export function createMissionRun(
  db: DB,
  input: CreateMissionRunInput,
  now = Date.now(),
): MissionRunDetail {
  const timestamp = normalizeTimestamp(now, "now");
  const actor = snapshotActor(input.actor, "run actor");
  const captured = resolveRunDefinition(db, input);
  const compileReportJson = canonicalJsonRecord(
    input.compileReport ?? {},
    "compile report",
    MAX_MISSION_COMPILE_REPORT_BYTES,
  );
  const correlationJson = canonicalJsonRecord(
    input.transactionCorrelation ?? {},
    "transaction correlation",
    MAX_MISSION_CORRELATION_BYTES,
  );
  const deadlineAt = input.deadlineAt === undefined
    ? timestamp + captured.definition.limits.maxRuntimeMinutes * 60_000
    : normalizeTimestamp(input.deadlineAt, "deadlineAt");
  if (deadlineAt <= timestamp) throw invalid("deadlineAt must be after run creation");
  const maximumDeadline = timestamp + captured.definition.limits.maxRuntimeMinutes * 60_000;
  if (deadlineAt > maximumDeadline) {
    throw invalid("deadlineAt may not exceed the mission runtime limit");
  }
  const create = db.transaction(() => {
    // The temporary value is private to this SQLite transaction. It becomes
    // `mission:<id>` before callers can observe the committed run.
    const temporaryScope = "mission:pending";
    const result = db.prepare(
      `INSERT INTO mission_runs (
        ts_created, ts_updated, definition_id, source_schema, source_json, source_hash,
        actor_username, actor_role, actor_source, limits_json, compile_report_json,
        task_plan_id, transaction_scope, transaction_correlation_json, deadline_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      timestamp, timestamp, captured.definitionId, MISSION_SCHEMA,
      captured.sourceJson, captured.sourceHash,
      actor.username, actor.role, actor.source,
      canonicalJsonRecord(captured.definition.limits, "mission limits", 1_024),
      compileReportJson, null, temporaryScope, correlationJson, deadlineAt,
    );
    const id = Number(result.lastInsertRowid);
    db.prepare("UPDATE mission_runs SET transaction_scope = ? WHERE id = ?")
      .run(`mission:${id}`, id);
    return getMissionRun(db, id)!;
  });
  return create();
}

/**
 * Attach the complete, ordered logical-to-expanded mapping exactly once while
 * the run is still pending. This leaves Task 13 free to create one durable
 * task plan in its own outer DB transaction.
 */
export function appendMissionStepLinks(
  db: DB,
  missionRunId: number,
  links: readonly MissionStepLinkInput[],
  now = Date.now(),
): MissionRunDetail {
  const runId = positiveId(missionRunId, "mission run id");
  const timestamp = normalizeTimestamp(now, "now");
  const add = db.transaction(() => {
    const run = getMissionRun(db, runId);
    if (!run) throw new MissionStoreError("NOT_FOUND", `mission run ${runId} does not exist`);
    if (run.status !== "pending") {
      throw new MissionStoreError("IMMUTABLE", "mission step links can be added only while a run is pending");
    }
    const existing = db.prepare(
      "SELECT COUNT(*) AS count FROM mission_step_links WHERE mission_run_id = ?",
    ).get(runId) as { count: number };
    if (existing.count !== 0) {
      throw new MissionStoreError("IMMUTABLE", "mission step links are immutable once recorded");
    }
    const normalized = normalizeLinks(db, links, run);
    const insert = db.prepare(
      `INSERT INTO mission_step_links (
        mission_run_id, logical_step_id, logical_position,
        expanded_start_position, expanded_step_count, construction_job_id, compile_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const link of normalized) {
      insert.run(
        runId, link.logicalStepId, link.logicalPosition,
        link.expandedStartPosition, link.expandedStepCount, link.constructionJobId,
        link.compileMetadataJson,
      );
    }
    db.prepare("UPDATE mission_runs SET ts_updated = ? WHERE id = ?").run(timestamp, runId);
    return getMissionRun(db, runId)!;
  });
  try {
    return add();
  } catch (error) {
    if (isSqliteConstraint(error)) {
      throw new MissionStoreError("PERSISTENCE_FAILED", "mission step links could not be recorded safely");
    }
    throw error;
  }
}

export function getMissionRun(db: DB, id: number): MissionRunDetail | undefined {
  const runId = positiveId(id, "mission run id");
  const row = db.prepare(`${runSelect()} WHERE id = ?`).get(runId) as RunDbRow | undefined;
  return row ? toMissionRunDetail(db, row) : undefined;
}

export function getMissionRunByTaskPlan(db: DB, taskPlanId: number): MissionRunDetail | undefined {
  const planId = positiveId(taskPlanId, "task plan id");
  const row = db.prepare(`${runSelect()} WHERE task_plan_id = ?`).get(planId) as RunDbRow | undefined;
  return row ? toMissionRunDetail(db, row) : undefined;
}

/** Returns source-free, count-bounded run projections. */
export function listMissionRuns(
  db: DB,
  input: ListMissionRunsInput = {},
): MissionRunSummary[] {
  const limit = normalizeListLimit(input.limit);
  const predicates: string[] = [];
  const values: Array<string | number> = [];
  if (input.definitionId !== undefined) {
    predicates.push("definition_id = ?");
    values.push(positiveId(input.definitionId, "definition id"));
  }
  if (input.taskPlanId !== undefined) {
    predicates.push("task_plan_id = ?");
    values.push(positiveId(input.taskPlanId, "task plan id"));
  }
  if (input.status !== undefined) {
    if (!MISSION_STATUSES.has(input.status)) throw invalid("mission run status is invalid");
    predicates.push("status = ?");
    values.push(input.status);
  }
  const where = predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`;
  const rows = db.prepare(
    `SELECT id, ts_created, ts_updated, definition_id, source_schema, source_hash,
            actor_username, actor_role, actor_source, task_plan_id, deadline_at,
            status, ts_started, ts_finished, last_error
     FROM mission_runs${where} ORDER BY ts_created DESC, id DESC LIMIT ?`,
  ).all(...values, limit) as Array<Omit<RunDbRow,
    "source_json" | "limits_json" | "compile_report_json" | "transaction_scope" | "transaction_correlation_json">>;
  return rows.map(toMissionRunSummary);
}

/**
 * Read active runs in deterministic ID order for startup reconciliation.
 * Results remain batch-bounded, but callers can page until exhaustion so an
 * old active mission cannot be hidden behind more than 100 newer runs.
 */
export function listActiveMissionRuns(
  db: DB,
  input: ListActiveMissionRunsInput = {},
): MissionRunSummary[] {
  const afterId = input.afterId === undefined
    ? 0
    : nonNegativeInteger(input.afterId, "active mission run cursor");
  const limit = normalizeListLimit(input.limit);
  const rows = db.prepare(
    `SELECT id, ts_created, ts_updated, definition_id, source_schema, source_hash,
            actor_username, actor_role, actor_source, task_plan_id, deadline_at,
            status, ts_started, ts_finished, last_error
     FROM mission_runs
     WHERE status IN ('pending', 'running', 'paused') AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
  ).all(afterId, limit) as Array<Omit<RunDbRow,
    "source_json" | "limits_json" | "compile_report_json" | "transaction_scope" | "transaction_correlation_json">>;
  return rows.map(toMissionRunSummary);
}

/** Explicit directed lifecycle transition; terminal run states cannot revive. */
export function transitionMissionRun(
  db: DB,
  missionRunId: number,
  status: MissionRunStatus,
  options: { readonly error?: string } = {},
  now = Date.now(),
): MissionRunDetail | undefined {
  const runId = positiveId(missionRunId, "mission run id");
  if (!MISSION_STATUSES.has(status)) throw invalid("target mission run status is invalid");
  const timestamp = normalizeTimestamp(now, "now");
  const error = options.error === undefined
    ? null
    : normalizeShortString(options.error, "mission run error", MAX_MISSION_ERROR_LENGTH);
  const transition = db.transaction(() => {
    const current = getMissionRun(db, runId);
    if (!current) return undefined;
    if (!MISSION_TRANSITIONS[current.status].includes(status)) {
      throw new MissionStoreError(
        "INVALID_TRANSITION",
        `mission run ${runId} cannot transition from ${current.status} to ${status}`,
      );
    }
    if (current.status === "pending" && status === "running") {
      assertRunMaterialized(db, current);
    }
    const terminal = status === "completed" || status === "failed" || status === "cancelled";
    const result = db.prepare(
      `UPDATE mission_runs
       SET status = ?, ts_updated = ?,
           ts_started = CASE WHEN ? = 'running' THEN COALESCE(ts_started, ?) ELSE ts_started END,
           ts_finished = CASE WHEN ? = 1 THEN ? ELSE ts_finished END,
           last_error = ?
       WHERE id = ? AND status = ?`,
    ).run(status, timestamp, status, timestamp, terminal ? 1 : 0, timestamp, error, runId, current.status);
    if (result.changes === 0) {
      throw new MissionStoreError("PERSISTENCE_FAILED", `mission run ${runId} changed during transition`);
    }
    return getMissionRun(db, runId)!;
  });
  return transition();
}

function resolveRunDefinition(
  db: DB,
  input: CreateMissionRunInput,
): { definitionId: number | null; definition: MissionDefinition; sourceJson: string; sourceHash: string } {
  const supplied = input.definition === undefined ? undefined : parseDefinition(input.definition);
  if (input.definitionId === undefined) {
    if (!supplied) throw invalid("mission run requires definitionId or definition");
    return {
      definitionId: null,
      definition: supplied,
      sourceJson: canonicalizeMissionSource(supplied),
      sourceHash: hashMissionSource(supplied),
    };
  }
  const id = positiveId(input.definitionId, "mission definition id");
  const saved = getMissionDefinition(db, id);
  if (!saved) throw new MissionStoreError("NOT_FOUND", `mission definition ${id} does not exist`);
  if (!saved.enabled) throw new MissionStoreError("IMMUTABLE", `mission definition '${saved.name}' is disabled`);
  if (supplied) {
    const sourceHash = hashMissionSource(supplied);
    if (sourceHash !== saved.sourceHash) {
      throw invalid("run definition does not match the saved definition ID");
    }
  }
  return {
    definitionId: saved.id,
    definition: saved.definition,
    sourceJson: saved.sourceJson,
    sourceHash: saved.sourceHash,
  };
}

function normalizeLinks(
  db: DB,
  links: readonly MissionStepLinkInput[],
  run: MissionRunDetail,
): Array<{
  logicalStepId: string;
  logicalPosition: number;
  expandedStartPosition: number;
  expandedStepCount: number;
  constructionJobId: number | null;
  compileMetadataJson: string;
}> {
  if (!Array.isArray(links) || links.length === 0 || links.length > MAX_MISSION_LINKS_PER_RUN) {
    throw invalid(`mission run requires 1-${MAX_MISSION_LINKS_PER_RUN} step links`);
  }
  const source = parseRunSource(run);
  if (links.length !== source.steps.length) {
    throw invalid("mission step link count must match the mission source step count");
  }
  let nextExpanded = 0;
  const seenConstructionJobs = new Set<number>();
  return links.map((link, index) => {
    if (!isRecord(link)) throw invalid("mission step link must be an object");
    const expectedStep = source.steps[index];
    const logicalStepId = normalizeStepId(link.logicalStepId);
    const logicalPosition = nonNegativeInteger(link.logicalPosition, "logical position");
    const expandedStartPosition = nonNegativeInteger(link.expandedStartPosition, "expanded start position");
    const expandedStepCount = positiveId(link.expandedStepCount, "expanded step count");
    if (!expectedStep || logicalStepId !== expectedStep.id || logicalPosition !== index) {
      throw invalid("mission step links must follow the source's logical step order and IDs");
    }
    if (expandedStartPosition !== nextExpanded) {
      throw invalid("expanded step links must be contiguous and ordered from position zero");
    }
    nextExpanded += expandedStepCount;
    if (nextExpanded > run.limits.maxExpandedSteps) {
      throw invalid("expanded step links exceed the mission expanded-step limit");
    }
    const constructionJobId = link.constructionJobId === undefined
      ? null
      : positiveId(link.constructionJobId, "construction job id");
    if (expectedStep.op === "build" && constructionJobId === null) {
      throw invalid(`build step '${expectedStep.id}' requires a construction job link`);
    }
    if (expectedStep.op !== "build" && constructionJobId !== null) {
      throw invalid(`non-build step '${expectedStep.id}' may not reference a construction job`);
    }
    if (constructionJobId !== null) {
      if (seenConstructionJobs.has(constructionJobId)) {
        throw invalid("a construction job may be linked to only one logical mission step");
      }
      seenConstructionJobs.add(constructionJobId);
      const job = getConstructionJobLink(db, constructionJobId);
      if (!job) {
        throw new MissionStoreError("NOT_FOUND", `construction job ${constructionJobId} does not exist`);
      }
      const existing = db.prepare(
        "SELECT mission_run_id FROM mission_step_links WHERE construction_job_id = ?",
      ).get(constructionJobId) as { mission_run_id: number } | undefined;
      if (existing) {
        throw new MissionStoreError(
          "IMMUTABLE",
          `construction job ${constructionJobId} is already linked to mission run ${existing.mission_run_id}`,
        );
      }
    }
    const compileMetadataJson = canonicalJsonRecord(
      link.compileMetadata,
      "step link compile metadata",
      MAX_MISSION_LINK_METADATA_BYTES,
    );
    const compileMetadata = parseJsonRecord(
      compileMetadataJson,
      "step link compile metadata",
      MAX_MISSION_LINK_METADATA_BYTES,
    );
    readExpandedTaskMetadata(
      compileMetadata,
      expectedStep,
      constructionJobId,
      expandedStepCount,
      invalidFailure,
    );
    if (constructionJobId !== null && expectedStep.op === "build") {
      const job = getConstructionJobLink(db, constructionJobId);
      if (!job) {
        throw new MissionStoreError("NOT_FOUND", `construction job ${constructionJobId} does not exist`);
      }
      assertConstructionJobMatchesBuildStep(db, job, expectedStep, compileMetadata, invalidFailure);
    }
    return {
      ...link,
      logicalStepId,
      logicalPosition,
      expandedStartPosition,
      expandedStepCount,
      constructionJobId,
      compileMetadataJson,
    };
  });
}

/**
 * The compiler records the fully parsed task descriptors in immutable link
 * metadata. This is deliberately separate from raw MissionScript params:
 * individual skill schemas may add defaults during Task 13 compilation.
 */
function readExpandedTaskMetadata(
  metadata: Readonly<Record<string, MissionJsonValue>>,
  logical: MissionDefinition["steps"][number],
  constructionJobId: number | null,
  expectedCount: number,
  fail: (message: string) => never,
): readonly MissionExpandedTaskMetadata[] {
  const rawTasks = metadata[MISSION_EXPANDED_TASKS_METADATA_KEY];
  if (!Array.isArray(rawTasks) || rawTasks.length !== expectedCount) {
    return fail(
      `step '${logical.id}' compile metadata must contain exactly ${expectedCount} resolved expanded task${expectedCount === 1 ? "" : "s"}`,
    );
  }
  const tasks = rawTasks.map((raw, index) => {
    if (!isRecord(raw)) return fail(`step '${logical.id}' resolved task ${index} must be an object`);
    const keys = Object.keys(raw).sort();
    if (keys.length !== 3 || keys[0] !== "maxAttempts" || keys[1] !== "params" || keys[2] !== "skill") {
      return fail(`step '${logical.id}' resolved task ${index} must contain only skill, params, and maxAttempts`);
    }
    const skill = raw.skill;
    const params = raw.params;
    const maxAttempts = raw.maxAttempts;
    if (typeof skill !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(skill)) {
      return fail(`step '${logical.id}' resolved task ${index} has an invalid skill name`);
    }
    if (!isRecord(params)) return fail(`step '${logical.id}' resolved task ${index} params must be an object`);
    if (
      typeof maxAttempts !== "number" || !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 || maxAttempts > 10
    ) {
      return fail(`step '${logical.id}' resolved task ${index} maxAttempts must be 1-10`);
    }
    return Object.freeze({
      skill,
      params: params as Readonly<Record<string, MissionJsonValue>>,
      maxAttempts: maxAttempts as number,
    });
  });
  if (tasks.some((task) => task.maxAttempts !== logical.maxAttempts)) {
    return fail(`step '${logical.id}' resolved task retry limits must equal the logical maxAttempts`);
  }

  if (logical.op === "skill") {
    const task = tasks[0];
    if (!task || task.skill !== logical.skill || !jsonSubset(logical.params, task.params)) {
      return fail(`step '${logical.id}' resolved skill task does not preserve the logical skill and params`);
    }
    return tasks;
  }
  if (logical.op === "clear") {
    const task = tasks[0];
    const sourceParams = clearTaskSourceParams(logical);
    if (!task || task.skill !== "clearRegion" || !jsonSubset(sourceParams, task.params)) {
      return fail(`step '${logical.id}' resolved clear task does not preserve the logical clear request`);
    }
    return tasks;
  }

  const prepare = tasks[0];
  const build = tasks[1];
  if (
    !prepare || !build || prepare.skill !== "prepareBlueprintMaterials" || build.skill !== "buildBlueprint" ||
    !sameJobId(prepare.params.jobId, constructionJobId) ||
    !sameJobId(build.params.jobId, constructionJobId)
  ) {
    return fail(`step '${logical.id}' resolved build tasks do not match its construction job`);
  }
  return tasks;
}

function clearTaskSourceParams(
  step: Extract<MissionDefinition["steps"][number], { readonly op: "clear" }>,
): Readonly<Record<string, MissionJsonValue>> {
  return Object.freeze({
    from: Object.freeze({ x: step.from[0], y: step.from[1], z: step.from[2] }),
    to: Object.freeze({ x: step.to[0], y: step.to[1], z: step.to[2] }),
    includeContainers: step.includeContainers,
  });
}

/** Require every explicit MissionScript value to survive schema defaulting unchanged. */
function jsonSubset(expected: MissionJsonValue, actual: MissionJsonValue): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(expected, actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length &&
      expected.every((value, index) => jsonSubset(value, actual[index]!));
  }
  if (!isRecord(actual)) return false;
  return Object.entries(expected).every(([key, value]) =>
    Object.prototype.hasOwnProperty.call(actual, key) && jsonSubset(value, actual[key] as MissionJsonValue),
  );
}

function definitionSelect(): string {
  return `SELECT id, ts_created, ts_updated, name, schema, source_json, source_hash,
                 creator_username, creator_source, enabled
          FROM mission_definitions`;
}

function runSelect(): string {
  return `SELECT id, ts_created, ts_updated, definition_id, source_schema, source_json, source_hash,
                 actor_username, actor_role, actor_source, limits_json, compile_report_json,
                 task_plan_id, transaction_scope, transaction_correlation_json, deadline_at,
                 status, ts_started, ts_finished, last_error
          FROM mission_runs`;
}

function linkSelect(): string {
  return `SELECT id, mission_run_id, logical_step_id, logical_position,
                 expanded_start_position, expanded_step_count, construction_job_id, compile_metadata_json
          FROM mission_step_links`;
}

function toMissionDefinitionDetail(row: DefinitionDbRow): MissionDefinitionDetail {
  const definition = parsePersistedDefinition(row);
  return {
    ...toMissionDefinitionRow(row),
    definition,
  };
}

function toMissionDefinitionRow(row: DefinitionDbRow): MissionDefinitionRow {
  const schema = persistedSchema(row.schema, "mission definition schema");
  const creator = persistedCreator(row.creator_username, row.creator_source);
  const enabled = persistedBoolean(row.enabled, "mission definition enabled");
  return {
    id: positiveId(row.id, "mission definition id"),
    tsCreated: normalizeTimestamp(row.ts_created, "definition created timestamp"),
    tsUpdated: normalizeTimestamp(row.ts_updated, "definition updated timestamp"),
    name: normalizeName(row.name, "mission definition name"),
    schema,
    sourceJson: normalizeSourceJson(row.source_json),
    sourceHash: normalizeHash(row.source_hash),
    creator,
    enabled,
  };
}

function toMissionDefinitionSummary(row: Omit<DefinitionDbRow, "source_json">): MissionDefinitionSummary {
  return {
    id: positiveId(row.id, "mission definition id"),
    tsCreated: normalizeTimestamp(row.ts_created, "definition created timestamp"),
    tsUpdated: normalizeTimestamp(row.ts_updated, "definition updated timestamp"),
    name: normalizeName(row.name, "mission definition name"),
    schema: persistedSchema(row.schema, "mission definition schema"),
    sourceHash: normalizeHash(row.source_hash),
    creator: persistedCreator(row.creator_username, row.creator_source),
    enabled: persistedBoolean(row.enabled, "mission definition enabled"),
  };
}

function toMissionRunDetail(db: DB, row: RunDbRow): MissionRunDetail {
  const run = toMissionRunRow(row);
  const links = db.prepare(
    `${linkSelect()} WHERE mission_run_id = ? ORDER BY logical_position ASC, id ASC`,
  ).all(run.id) as LinkDbRow[];
  return {
    ...run,
    stepLinks: links.map(toMissionStepLinkRow),
  };
}

function toMissionRunRow(row: RunDbRow): MissionRunRow {
  const sourceSchema = persistedSchema(row.source_schema, "mission run source schema");
  const sourceJson = normalizeSourceJson(row.source_json);
  const definition = parseMissionDefinition(JSON.parse(sourceJson));
  const sourceHash = normalizeHash(row.source_hash);
  if (hashMissionSource(definition) !== sourceHash) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission run source hash does not match its immutable source");
  }
  const limits = parseLimits(row.limits_json);
  if (canonicalJsonRecord(definition.limits, "mission limits", 1_024) !== canonicalJsonRecord(limits, "mission limits", 1_024)) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission run limits do not match its immutable source");
  }
  const status = persistedStatus(row.status);
  const started = nullableTimestamp(row.ts_started, "run started timestamp");
  const finished = nullableTimestamp(row.ts_finished, "run finished timestamp");
  return {
    id: positiveId(row.id, "mission run id"),
    tsCreated: normalizeTimestamp(row.ts_created, "run created timestamp"),
    tsUpdated: normalizeTimestamp(row.ts_updated, "run updated timestamp"),
    definitionId: nullablePositiveId(row.definition_id, "mission definition id"),
    sourceSchema,
    sourceJson,
    sourceHash,
    actor: parsePersistedExecutionActor({
      username: row.actor_username,
      role: row.actor_role,
      source: row.actor_source,
    }),
    limits,
    compileReport: parseJsonRecord(row.compile_report_json, "compile report", MAX_MISSION_COMPILE_REPORT_BYTES),
    taskPlanId: nullablePositiveId(row.task_plan_id, "task plan id"),
    transactionScope: normalizeShortString(
      row.transaction_scope,
      "transaction scope",
      MAX_MISSION_TRANSACTION_SCOPE_LENGTH,
    ),
    transactionCorrelation: parseJsonRecord(
      row.transaction_correlation_json,
      "transaction correlation",
      MAX_MISSION_CORRELATION_BYTES,
    ),
    deadlineAt: normalizeTimestamp(row.deadline_at, "mission deadline"),
    status,
    tsStarted: started,
    tsFinished: finished,
    lastError: row.last_error === null
      ? null
      : normalizeShortString(row.last_error, "mission run error", MAX_MISSION_ERROR_LENGTH),
  };
}

function toMissionRunSummary(
  row: Omit<RunDbRow,
    "source_json" | "limits_json" | "compile_report_json" | "transaction_scope" | "transaction_correlation_json">,
): MissionRunSummary {
  return {
    id: positiveId(row.id, "mission run id"),
    tsCreated: normalizeTimestamp(row.ts_created, "run created timestamp"),
    tsUpdated: normalizeTimestamp(row.ts_updated, "run updated timestamp"),
    definitionId: nullablePositiveId(row.definition_id, "mission definition id"),
    sourceSchema: persistedSchema(row.source_schema, "mission run source schema"),
    sourceHash: normalizeHash(row.source_hash),
    actor: parsePersistedExecutionActor({
      username: row.actor_username,
      role: row.actor_role,
      source: row.actor_source,
    }),
    taskPlanId: nullablePositiveId(row.task_plan_id, "task plan id"),
    deadlineAt: normalizeTimestamp(row.deadline_at, "mission deadline"),
    status: persistedStatus(row.status),
    tsStarted: nullableTimestamp(row.ts_started, "run started timestamp"),
    tsFinished: nullableTimestamp(row.ts_finished, "run finished timestamp"),
    lastError: row.last_error === null
      ? null
      : normalizeShortString(row.last_error, "mission run error", MAX_MISSION_ERROR_LENGTH),
  };
}

function toMissionStepLinkRow(row: LinkDbRow): MissionStepLinkRow {
  return {
    id: positiveId(row.id, "mission step link id"),
    missionRunId: positiveId(row.mission_run_id, "mission run id"),
    logicalStepId: normalizeStepId(row.logical_step_id),
    logicalPosition: nonNegativeInteger(row.logical_position, "logical position"),
    expandedStartPosition: nonNegativeInteger(row.expanded_start_position, "expanded start position"),
    expandedStepCount: positiveId(row.expanded_step_count, "expanded step count"),
    constructionJobId: nullablePositiveId(row.construction_job_id, "construction job id"),
    compileMetadata: parseJsonRecord(
      row.compile_metadata_json,
      "step link compile metadata",
      MAX_MISSION_LINK_METADATA_BYTES,
    ),
  };
}

function parsePersistedDefinition(row: DefinitionDbRow): MissionDefinition {
  const sourceJson = normalizeSourceJson(row.source_json);
  const definition = parseMissionDefinition(JSON.parse(sourceJson));
  if (definition.name !== normalizeName(row.name, "mission definition name")) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission definition name does not match its source");
  }
  if (hashMissionSource(definition) !== normalizeHash(row.source_hash)) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission definition source hash does not match its source");
  }
  return definition;
}

function parseRunSource(run: MissionRunDetail): MissionDefinition {
  try {
    return parseMissionDefinition(JSON.parse(run.sourceJson));
  } catch (error) {
    throw new MissionStoreError("PERSISTENCE_FAILED", `mission run source cannot be parsed: ${errorMessage(error)}`);
  }
}

/** A pending row cannot begin execution until Task 13 has persisted one plan and every logical link. */
function assertRunMaterialized(db: DB, run: MissionRunDetail): void {
  if (run.taskPlanId === null) {
    throw new MissionStoreError("IMMUTABLE", "mission run cannot start before it is linked to a task plan");
  }
  const source = parseRunSource(run);
  if (run.stepLinks.length !== source.steps.length) {
    throw new MissionStoreError("IMMUTABLE", "mission run cannot start before every logical step is linked");
  }
  let expectedExpandedPosition = 0;
  for (const [index, link] of run.stepLinks.entries()) {
    const step = source.steps[index];
    if (
      !step ||
      link.logicalStepId !== step.id ||
      link.logicalPosition !== index ||
      link.expandedStartPosition !== expectedExpandedPosition ||
      link.expandedStepCount < 1
    ) {
      throw new MissionStoreError("PERSISTENCE_FAILED", "mission run has an incomplete or corrupt step mapping");
    }
    if ((step.op === "build") !== (link.constructionJobId !== null)) {
      throw new MissionStoreError("PERSISTENCE_FAILED", "mission build link/job mapping is incomplete or corrupt");
    }
    if (link.constructionJobId !== null) {
      const job = getConstructionJobLink(db, link.constructionJobId);
      if (!job || job.last_plan_id !== run.taskPlanId) {
        throw new MissionStoreError("PERSISTENCE_FAILED", "mission construction job is not linked to the mission task plan");
      }
      if (step.op === "build") {
        assertConstructionJobMatchesBuildStep(db, job, step, link.compileMetadata, persistenceFailure);
      }
    }
    expectedExpandedPosition += link.expandedStepCount;
  }
  if (expectedExpandedPosition > run.limits.maxExpandedSteps) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission run mapping exceeds its expanded-step limit");
  }
  const plan = db.prepare(
    `SELECT p.status, a.actor_username, a.actor_role, a.actor_source
     FROM task_plans p
     LEFT JOIN task_plan_actors a ON a.plan_id = p.id
     WHERE p.id = ?`,
  ).get(run.taskPlanId) as {
    status: string;
    actor_username: string | null;
    actor_role: string | null;
    actor_source: string | null;
  } | undefined;
  if (!plan || (plan.status !== "pending" && plan.status !== "running")) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission task plan is missing or not executable");
  }
  if (plan.actor_username === null || plan.actor_role === null || plan.actor_source === null) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission task plan is missing actor provenance");
  }
  const planActor = parsePersistedExecutionActor({
    username: plan.actor_username,
    role: plan.actor_role,
    source: plan.actor_source,
  });
  if (
    planActor.username !== run.actor.username ||
    planActor.role !== run.actor.role ||
    planActor.source !== run.actor.source
  ) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission task plan actor does not match the immutable run actor");
  }
  const stepRows = db.prepare(
    "SELECT position, skill, params_json, max_attempts FROM task_steps WHERE plan_id = ? ORDER BY position ASC",
  ).all(run.taskPlanId) as Array<{
    position: number;
    skill: string;
    params_json: string;
    max_attempts: number;
  }>;
  if (stepRows.length !== expectedExpandedPosition || stepRows.some((step, index) => step.position !== index)) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission task plan steps do not match the expanded mapping");
  }
  for (const [index, link] of run.stepLinks.entries()) {
    const logical = source.steps[index]!;
    const expanded = stepRows.slice(
      link.expandedStartPosition,
      link.expandedStartPosition + link.expandedStepCount,
    );
    assertExpandedTaskMapping(logical, link, expanded);
  }
}

function assertExpandedTaskMapping(
  logical: MissionDefinition["steps"][number],
  link: MissionStepLinkRow,
  expanded: readonly { position: number; skill: string; params_json: string; max_attempts: number }[],
): void {
  const expectedTasks = readExpandedTaskMetadata(
    link.compileMetadata,
    logical,
    link.constructionJobId,
    link.expandedStepCount,
    persistenceFailure,
  );
  if (expanded.length !== expectedTasks.length) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission task count does not match its resolved expansion metadata");
  }
  for (const [position, expected] of expectedTasks.entries()) {
    const actual = expanded[position];
    if (
      !actual || actual.skill !== expected.skill || actual.max_attempts !== expected.maxAttempts ||
      !sameJsonRecord(actual.params_json, expected.params, "mission expanded task parameters")
    ) {
      throw new MissionStoreError("PERSISTENCE_FAILED", "mission task does not match its resolved expansion metadata");
    }
  }
}

function parseTaskParams(json: string, label: string): Readonly<Record<string, MissionJsonValue>> {
  try {
    const parsed = JSON.parse(json) as unknown;
    const canonical = canonicalJson(parsed, label, 0, { count: 0 });
    if (!isRecord(canonical)) throw new Error("must be an object");
    return canonical;
  } catch (error) {
    throw new MissionStoreError("PERSISTENCE_FAILED", `invalid persisted ${label}: ${errorMessage(error)}`);
  }
}

function sameJsonRecord(json: string, expected: Readonly<Record<string, MissionJsonValue>>, label: string): boolean {
  const params = parseTaskParams(json, label);
  return stableJson(params) === stableJson(expected);
}

function sameJobId(value: MissionJsonValue | undefined, expected: number | null): boolean {
  return expected !== null && value === expected;
}

function getConstructionJobLink(
  db: DB,
  constructionJobId: number,
): {
  id: number;
  blueprint_id: number;
  blueprint_name: string;
  origin_x: number;
  origin_y: number;
  origin_z: number;
  rotation: number;
  last_plan_id: number | null;
  source_json: string | null;
  source_hash: string | null;
} | undefined {
  return db.prepare(
    `SELECT j.id, j.blueprint_id, b.name AS blueprint_name,
            j.origin_x, j.origin_y, j.origin_z, j.rotation, j.last_plan_id,
            source.source_json, source.source_hash
     FROM construction_jobs j
     JOIN blueprints b ON b.id = j.blueprint_id
     LEFT JOIN blueprint_sources source ON source.blueprint_id = b.id
     WHERE j.id = ?`,
  ).get(constructionJobId) as {
    id: number;
    blueprint_id: number;
    blueprint_name: string;
    origin_x: number;
    origin_y: number;
    origin_z: number;
    rotation: number;
    last_plan_id: number | null;
    source_json: string | null;
    source_hash: string | null;
  } | undefined;
}

function assertConstructionJobMatchesBuildStep(
  db: DB,
  job: NonNullable<ReturnType<typeof getConstructionJobLink>>,
  step: MissionBuildStep,
  metadata: Readonly<Record<string, MissionJsonValue>>,
  fail: (message: string) => never,
): void {
  if (
    job.origin_x !== step.origin[0] ||
    job.origin_y !== step.origin[1] ||
    job.origin_z !== step.origin[2] ||
    job.rotation !== step.rotation
  ) {
    return fail(`construction job ${job.id} origin or rotation does not match build step '${step.id}'`);
  }
  if ("blueprintName" in step) {
    if (job.blueprint_name !== step.blueprintName) {
      return fail(`construction job ${job.id} blueprint does not match build step '${step.id}'`);
    }
    const expected = readNamedBlueprintFingerprint(metadata, step, fail);
    if (expected.blueprintId !== job.blueprint_id || expected.blueprintName !== job.blueprint_name) {
      return fail(`construction job ${job.id} identity does not match named build step '${step.id}'`);
    }
    const blueprint = getBlueprint(db, job.blueprint_id);
    if (!blueprint) {
      return fail(`construction job ${job.id} references a missing named blueprint`);
    }
    const actual = fingerprintBlueprintExecution(blueprint, getBlueprintSource(db, blueprint.id) ?? null);
    if (
      actual.blueprintId !== expected.blueprintId ||
      actual.blueprintName !== expected.blueprintName ||
      actual.cellsHash !== expected.cellsHash ||
      actual.sourceHash !== expected.sourceHash ||
      actual.targetVersion !== expected.targetVersion
    ) {
      return fail(`construction job ${job.id} named blueprint changed after mission compilation`);
    }
    return;
  }
  if (typeof job.source_json !== "string" || typeof job.source_hash !== "string") {
    return fail(`inline build step '${step.id}' requires a durable compiled blueprint source`);
  }
  try {
    const persisted = parseBuildSource(JSON.parse(job.source_json));
    const persistedHash = hashBuildSource(persisted);
    const expectedHash = hashBuildSource(step.definition);
    if (persistedHash !== job.source_hash || persistedHash !== expectedHash) {
      return fail(`construction job ${job.id} source does not match inline build step '${step.id}'`);
    }
  } catch (error) {
    return fail(`construction job ${job.id} has an invalid compiled source: ${errorMessage(error)}`);
  }
}

interface NamedBlueprintFingerprintMetadata {
  readonly blueprintId: number;
  readonly blueprintName: string;
  readonly cellsHash: string;
  readonly sourceHash: string | null;
  readonly targetVersion: string | null;
}

/** Validate the compiler-owned snapshot before treating it as a durable pin. */
function readNamedBlueprintFingerprint(
  metadata: Readonly<Record<string, MissionJsonValue>>,
  step: Extract<MissionBuildStep, { readonly blueprintName: string }>,
  fail: (message: string) => never,
): NamedBlueprintFingerprintMetadata {
  const raw = metadata[MISSION_NAMED_BLUEPRINT_FINGERPRINT_METADATA_KEY];
  if (!isRecord(raw)) {
    return fail(`named build step '${step.id}' is missing its immutable blueprint fingerprint`);
  }
  const blueprintId = raw.blueprintId;
  const blueprintName = raw.blueprintName;
  const cellsHash = raw.cellsHash;
  const sourceHash = raw.sourceHash;
  const targetVersion = raw.targetVersion;
  if (typeof blueprintId !== "number" || !Number.isSafeInteger(blueprintId) || blueprintId <= 0) {
    return fail(`named build step '${step.id}' has an invalid immutable blueprint fingerprint`);
  }
  if (typeof blueprintName !== "string" || blueprintName !== step.blueprintName) {
    return fail(`named build step '${step.id}' has an invalid immutable blueprint fingerprint`);
  }
  if (typeof cellsHash !== "string" || !/^[a-f0-9]{64}$/.test(cellsHash)) {
    return fail(`named build step '${step.id}' has an invalid immutable blueprint fingerprint`);
  }
  if (sourceHash !== null && (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash))) {
    return fail(`named build step '${step.id}' has an invalid immutable blueprint fingerprint`);
  }
  if (targetVersion !== null && (typeof targetVersion !== "string" || targetVersion.length < 1 || targetVersion.length > 64)) {
    return fail(`named build step '${step.id}' has an invalid immutable blueprint fingerprint`);
  }
  return Object.freeze({ blueprintId, blueprintName, cellsHash, sourceHash, targetVersion });
}

function persistenceFailure(message: string): never {
  throw new MissionStoreError("PERSISTENCE_FAILED", message);
}

function parseDefinition(input: unknown): MissionDefinition {
  try {
    return parseMissionDefinition(input);
  } catch (error) {
    throw new MissionStoreError("INVALID_INPUT", `invalid mission definition: ${errorMessage(error)}`);
  }
}

function parseLimits(json: string): MissionLimits {
  const value = parseJsonRecord(json, "mission limits", 1_024);
  const parsed = parseDefinition({
    schema: MISSION_SCHEMA,
    name: "limits-validation",
    limits: value,
    steps: [{ id: "validation", op: "skill", skill: "validation", params: {} }],
  });
  return parsed.limits;
}

function snapshotActor(actor: ExecutionActor, label: string): ExecutionActor {
  try {
    return snapshotExecutionActor(actor);
  } catch (error) {
    throw invalid(`invalid ${label}: ${errorMessage(error)}`);
  }
}

function persistedCreator(username: unknown, source: unknown): MissionDefinitionCreator {
  try {
    const actor = snapshotExecutionActor({ username, role: "viewer", source });
    return { username: actor.username, source: actor.source };
  } catch (error) {
    throw new MissionStoreError("PERSISTENCE_FAILED", `invalid persisted mission creator: ${errorMessage(error)}`);
  }
}

function canonicalJsonRecord(value: unknown, label: string, maxBytes: number): string {
  const canonical = canonicalJson(value, label, 0, { count: 0 });
  if (!isRecord(canonical)) throw invalid(`${label} must be a JSON object`);
  const json = stableJson(canonical);
  if (new TextEncoder().encode(json).byteLength > maxBytes) {
    throw invalid(`${label} may not exceed ${maxBytes} bytes`);
  }
  return json;
}

function parseJsonRecord(json: unknown, label: string, maxBytes: number): Readonly<Record<string, MissionJsonValue>> {
  if (typeof json !== "string") throw new MissionStoreError("PERSISTENCE_FAILED", `${label} JSON is not a string`);
  if (new TextEncoder().encode(json).byteLength > maxBytes) {
    throw new MissionStoreError("PERSISTENCE_FAILED", `${label} JSON exceeds its byte cap`);
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    const canonical = canonicalJson(parsed, label, 0, { count: 0 });
    if (!isRecord(canonical)) throw invalid(`${label} must be a JSON object`);
    return canonical;
  } catch (error) {
    if (error instanceof MissionStoreError) throw error;
    throw new MissionStoreError("PERSISTENCE_FAILED", `invalid persisted ${label}: ${errorMessage(error)}`);
  }
}

function canonicalJson(
  value: unknown,
  label: string,
  depth: number,
  state: { count: number },
): MissionJsonValue {
  if (depth > 32) throw invalid(`${label} nesting may not exceed 32 levels`);
  state.count++;
  if (state.count > 4_096) throw invalid(`${label} may not contain more than 4096 JSON values`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(`${label} may not contain non-finite numbers`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry, label, depth + 1, state));
  if (!isRecord(value)) throw invalid(`${label} must contain JSON data only`);
  const entries = Object.keys(value).sort().map((key) => {
    if (key.length > 256) throw invalid(`${label} key may not exceed 256 characters`);
    return [key, canonicalJson(value[key], label, depth + 1, state)] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<string, MissionJsonValue>>;
}

function stableJson(value: MissionJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Readonly<Record<string, MissionJsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key]!)}`).join(",")}}`;
}

function normalizeSourceJson(value: unknown): string {
  if (typeof value !== "string") throw new MissionStoreError("PERSISTENCE_FAILED", "mission source is not JSON text");
  if (new TextEncoder().encode(value).byteLength > MAX_MISSION_SOURCE_BYTES) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission source exceeds its byte cap");
  }
  return value;
}

function normalizeHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission source hash is invalid");
  }
  return value;
}

function persistedSchema(value: unknown, label: string): typeof MISSION_SCHEMA {
  if (value !== MISSION_SCHEMA) throw new MissionStoreError("PERSISTENCE_FAILED", `${label} is invalid`);
  return MISSION_SCHEMA;
}

function persistedStatus(value: unknown): MissionRunStatus {
  if (typeof value !== "string" || !MISSION_STATUSES.has(value as MissionRunStatus)) {
    throw new MissionStoreError("PERSISTENCE_FAILED", "mission run status is invalid");
  }
  return value as MissionRunStatus;
}

function persistedBoolean(value: unknown, label: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new MissionStoreError("PERSISTENCE_FAILED", `${label} is invalid`);
}

function normalizeListLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_MISSION_LIST_RESULTS) {
    throw invalid(`list limit must be a safe integer from 1-${MAX_MISSION_LIST_RESULTS}`);
  }
  return value;
}

function positiveId(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${label} must be a positive safe integer`);
  }
  return value;
}

function nullablePositiveId(value: unknown, label: string): number | null {
  return value === null ? null : positiveId(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeTimestamp(value: unknown, label: string): number {
  return positiveId(value, label);
}

function nullableTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : normalizeTimestamp(value, label);
}

function normalizeName(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 120) throw invalid(`${label} must be 1-120 characters`);
  return normalized;
}

function normalizeStepId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw invalid("logical step ID is invalid");
  }
  return value;
}

function normalizeShortString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw invalid(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw invalid(`${label} must be 1-${maximum} characters`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): MissionStoreError {
  return new MissionStoreError("INVALID_INPUT", message);
}

function invalidFailure(message: string): never {
  throw invalid(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSqliteConstraint(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}
