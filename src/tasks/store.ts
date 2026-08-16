import type { DB } from "../memory/db.js";
import type { SkillErrorCode, SkillResult } from "../skills/types.js";
import {
  parsePersistedExecutionActor,
  snapshotExecutionActor,
  type ExecutionActor,
} from "../permissions/executionActor.js";
import { sameMinecraftUsername } from "../bot/playerIdentity.js";

export type TaskPlanStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStepStatus =
  | "pending"
  | "running"
  | "retry_wait"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskStepInput {
  skill: string;
  params: Record<string, unknown>;
  maxAttempts?: number;
}

export interface TaskPlanActorRow {
  planId: number;
  actor: ExecutionActor;
  tsAuthorized: number;
}

export interface TaskPlanRow {
  id: number;
  tsCreated: number;
  tsUpdated: number;
  title: string;
  status: TaskPlanStatus;
  lastError: string | null;
}

export interface TaskStepRow {
  id: number;
  planId: number;
  position: number;
  skill: string;
  params: Record<string, unknown>;
  status: TaskStepStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  lastErrorCode: SkillErrorCode | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
}

export interface TaskPlanDetail extends TaskPlanRow {
  /** Null only for a pre-v15 plan that has not yet been recovered. */
  actor: ExecutionActor | null;
  actorAuthorizedAt: number | null;
  steps: TaskStepRow[];
}

export function createTaskPlan(
  db: DB,
  input: { title: string; steps: TaskStepInput[]; actor: ExecutionActor },
): TaskPlanDetail {
  const create = db.transaction(() => {
    const ts = Date.now();
    const actor = snapshotExecutionActor(input.actor);
    const result = db.prepare(
      `INSERT INTO task_plans (ts_created, ts_updated, title, status)
       VALUES (?, ?, ?, 'pending')`,
    ).run(ts, ts, input.title);
    const planId = Number(result.lastInsertRowid);
    db.prepare(
      `INSERT INTO task_plan_actors
        (plan_id, actor_username, actor_role, actor_source, ts_authorized)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(planId, actor.username, actor.role, actor.source, ts);
    const insert = db.prepare(
      `INSERT INTO task_steps
        (plan_id, position, skill, params_json, status, max_attempts)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    );
    input.steps.forEach((step, position) => {
      insert.run(
        planId,
        position,
        step.skill,
        JSON.stringify(step.params),
        step.maxAttempts ?? 3,
      );
    });
    return getTaskPlan(db, planId)!;
  });
  return create();
}

export function findMatchingActiveTaskPlan(
  db: DB,
  input: { title: string; steps: TaskStepInput[]; actor: ExecutionActor },
): TaskPlanDetail | undefined {
  const expectedActor = snapshotExecutionActor(input.actor);
  const candidates = db.prepare(
    `SELECT id FROM task_plans
     WHERE title = ? AND status IN ('pending', 'running', 'paused')
     ORDER BY ts_created DESC`,
  ).all(input.title) as Array<{ id: number }>;
  for (const candidate of candidates) {
    const plan = getTaskPlan(db, candidate.id);
    if (!plan || plan.steps.length !== input.steps.length || !plan.actor) continue;
    if (
      !sameMinecraftUsername(plan.actor.username, expectedActor.username) ||
      plan.actor.role !== expectedActor.role ||
      plan.actor.source !== expectedActor.source
    ) continue;
    const matches = plan.steps.every((step, index) => {
      const expected = input.steps[index];
      return expected !== undefined &&
        step.skill === expected.skill &&
        JSON.stringify(step.params) === JSON.stringify(expected.params) &&
        step.maxAttempts === (expected.maxAttempts ?? 3);
    });
    if (matches) return plan;
  }
  return undefined;
}

export function getTaskPlan(db: DB, id: number): TaskPlanDetail | undefined {
  const row = db.prepare(
    `SELECT id, ts_created, ts_updated, title, status, last_error
     FROM task_plans WHERE id = ?`,
  ).get(id) as {
    id: number;
    ts_created: number;
    ts_updated: number;
    title: string;
    status: TaskPlanStatus;
    last_error: string | null;
  } | undefined;
  if (!row) return undefined;
  const actor = getTaskPlanActor(db, id);
  return {
    id: row.id,
    tsCreated: row.ts_created,
    tsUpdated: row.ts_updated,
    title: row.title,
    status: row.status,
    lastError: row.last_error,
    actor: actor?.actor ?? null,
    actorAuthorizedAt: actor?.tsAuthorized ?? null,
    steps: getTaskSteps(db, id),
  };
}

/** Returns durable actor provenance when the plan was created on schema v15+. */
export function getTaskPlanActor(db: DB, planId: number): TaskPlanActorRow | undefined {
  const row = db.prepare(
    `SELECT plan_id, actor_username, actor_role, actor_source, ts_authorized
     FROM task_plan_actors WHERE plan_id = ?`,
  ).get(planId) as {
    plan_id: number;
    actor_username: string;
    actor_role: string;
    actor_source: string;
    ts_authorized: number;
  } | undefined;
  if (!row) return undefined;
  return {
    planId: row.plan_id,
    actor: parsePersistedExecutionActor({
      username: row.actor_username,
      role: row.actor_role,
      source: row.actor_source,
    }),
    tsAuthorized: row.ts_authorized,
  };
}

/**
 * Attach deterministic recovery provenance to a legacy plan exactly once.
 * INSERT OR IGNORE preserves a concurrent or already-persisted creator actor.
 */
export function ensureTaskPlanActor(
  db: DB,
  planId: number,
  actor: ExecutionActor,
  now = Date.now(),
): TaskPlanActorRow {
  const snapshot = snapshotExecutionActor(actor);
  const attach = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO task_plan_actors
        (plan_id, actor_username, actor_role, actor_source, ts_authorized)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(planId, snapshot.username, snapshot.role, snapshot.source, now);
    const persisted = getTaskPlanActor(db, planId);
    if (!persisted) throw new Error(`task plan ${planId} is missing actor provenance`);
    return persisted;
  });
  return attach();
}

export function getTaskSteps(db: DB, planId: number): TaskStepRow[] {
  const rows = db.prepare(
    `SELECT id, plan_id, position, skill, params_json, status, attempts,
            max_attempts, next_attempt_at, last_error_code, last_error, result_json
     FROM task_steps WHERE plan_id = ? ORDER BY position ASC`,
  ).all(planId) as Array<{
    id: number;
    plan_id: number;
    position: number;
    skill: string;
    params_json: string;
    status: TaskStepStatus;
    attempts: number;
    max_attempts: number;
    next_attempt_at: number | null;
    last_error_code: SkillErrorCode | null;
    last_error: string | null;
    result_json: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    planId: row.plan_id,
    position: row.position,
    skill: row.skill,
    params: JSON.parse(row.params_json) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, unknown>)
      : null,
  }));
}

export function claimNextTaskStep(db: DB, now = Date.now()): TaskStepRow | undefined {
  const claim = db.transaction(() => {
    const row = db.prepare(
      `SELECT s.id
       FROM task_steps s
       JOIN task_plans p ON p.id = s.plan_id
       WHERE p.status IN ('pending', 'running')
         AND s.status IN ('pending', 'retry_wait')
         AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= ?)
         -- A linked MissionScript plan is executable only after its immutable
         -- mission run reaches running. This makes partial lifecycle
         -- recovery fail closed instead of letting a briefly-resumed task
         -- plan run while its construction jobs/run metadata are still held.
         AND NOT EXISTS (
           SELECT 1 FROM mission_runs mission
           WHERE mission.task_plan_id = p.id
             AND mission.status != 'running'
         )
         AND NOT EXISTS (
           SELECT 1 FROM task_steps earlier
           WHERE earlier.plan_id = s.plan_id
             AND earlier.position < s.position
             AND earlier.status != 'completed'
         )
       ORDER BY p.ts_created ASC, p.id ASC, s.position ASC
       LIMIT 1`,
    ).get(now) as { id: number } | undefined;
    if (!row) return undefined;
    const step = getTaskStep(db, row.id);
    if (!step) return undefined;
    db.prepare(
      `UPDATE task_steps
       SET status = 'running', attempts = attempts + 1, next_attempt_at = NULL
       WHERE id = ?`,
    ).run(step.id);
    db.prepare(
      `UPDATE task_plans SET status = 'running', ts_updated = ? WHERE id = ?`,
    ).run(now, step.planId);
    return getTaskStep(db, step.id);
  });
  return claim();
}

export function completeTaskStep(db: DB, stepId: number, result: SkillResult): void {
  const complete = db.transaction(() => {
    const step = getTaskStep(db, stepId);
    if (!step) return;
    db.prepare(
      `UPDATE task_steps
       SET status = 'completed', result_json = ?, last_error_code = NULL, last_error = NULL
       WHERE id = ?`,
    ).run(JSON.stringify(result.data ?? {}), stepId);
    const unfinished = db.prepare(
      `SELECT COUNT(*) AS count FROM task_steps
       WHERE plan_id = ? AND status != 'completed'`,
    ).get(step.planId) as { count: number };
    db.prepare(
      `UPDATE task_plans
       SET status = ?, ts_updated = ?, last_error = NULL
       WHERE id = ?`,
    ).run(unfinished.count === 0 ? "completed" : "running", Date.now(), step.planId);
  });
  complete();
}

export function failTaskStep(
  db: DB,
  stepId: number,
  result: SkillResult,
  nextAttemptAt: number | null,
): void {
  const fail = db.transaction(() => {
    const step = getTaskStep(db, stepId);
    if (!step) return;
    const retry = nextAttemptAt !== null && step.attempts < step.maxAttempts;
    db.prepare(
      `UPDATE task_steps
       SET status = ?, next_attempt_at = ?, last_error_code = ?, last_error = ?
       WHERE id = ?`,
    ).run(
      retry ? "retry_wait" : "failed",
      retry ? nextAttemptAt : null,
      result.code ?? "UNKNOWN",
      result.summary,
      stepId,
    );
    db.prepare(
      `UPDATE task_plans SET status = ?, ts_updated = ?, last_error = ? WHERE id = ?`,
    ).run(retry ? "running" : "failed", Date.now(), result.summary, step.planId);
  });
  fail();
}

export function pauseTaskPlan(db: DB, planId: number): boolean {
  const result = db.prepare(
    `UPDATE task_plans SET status = 'paused', ts_updated = ?
     WHERE id = ? AND status IN ('pending', 'running')`,
  ).run(Date.now(), planId);
  if (result.changes > 0) {
    db.prepare(
      `UPDATE task_steps SET status = 'pending', next_attempt_at = NULL
       WHERE plan_id = ? AND status = 'running'`,
    ).run(planId);
  }
  return result.changes > 0;
}

export function resumeTaskPlan(db: DB, planId: number): boolean {
  const result = db.prepare(
    `UPDATE task_plans SET status = 'pending', ts_updated = ?
     WHERE id = ? AND status = 'paused'`,
  ).run(Date.now(), planId);
  return result.changes > 0;
}

export function cancelTaskPlan(db: DB, planId: number): boolean {
  const cancel = db.transaction(() => {
    const result = db.prepare(
      `UPDATE task_plans SET status = 'cancelled', ts_updated = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
    ).run(Date.now(), planId);
    if (result.changes > 0) {
      db.prepare(
        `UPDATE task_steps SET status = 'cancelled', next_attempt_at = NULL
         WHERE plan_id = ? AND status != 'completed'`,
      ).run(planId);
    }
    return result.changes > 0;
  });
  return cancel();
}

export function reconcileInterruptedTasks(db: DB): number {
  const reconcile = db.transaction(() => {
    const steps = db.prepare(
      `UPDATE task_steps SET status = 'pending', next_attempt_at = NULL
       WHERE status = 'running'`,
    ).run();
    db.prepare(
      `UPDATE task_plans SET status = 'pending', ts_updated = ?
       WHERE status = 'running'`,
    ).run(Date.now());
    return steps.changes;
  });
  return reconcile();
}

export function nextRetryAt(db: DB): number | undefined {
  const row = db.prepare(
    `SELECT MIN(s.next_attempt_at) AS next
     FROM task_steps s JOIN task_plans p ON p.id = s.plan_id
     WHERE s.status = 'retry_wait' AND p.status = 'running'`,
  ).get() as { next: number | null };
  return row.next ?? undefined;
}

function getTaskStep(db: DB, id: number): TaskStepRow | undefined {
  const row = db.prepare(
    `SELECT id, plan_id, position, skill, params_json, status, attempts,
            max_attempts, next_attempt_at, last_error_code, last_error, result_json
     FROM task_steps WHERE id = ?`,
  ).get(id) as {
    id: number;
    plan_id: number;
    position: number;
    skill: string;
    params_json: string;
    status: TaskStepStatus;
    attempts: number;
    max_attempts: number;
    next_attempt_at: number | null;
    last_error_code: SkillErrorCode | null;
    last_error: string | null;
    result_json: string | null;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    planId: row.plan_id,
    position: row.position,
    skill: row.skill,
    params: JSON.parse(row.params_json) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, unknown>)
      : null,
  };
}
