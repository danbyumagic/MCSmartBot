import type { DB } from "../memory/db.js";
import { getOpenGoal } from "../memory/goals.js";
import { getRecentEvents } from "../events/store.js";
import { listPlayerRoles } from "../permissions/roles.js";
import { getRecentSkillRuns } from "../memory/skillRuns.js";
import {
  disconnectedRuntimeState,
  type BotRuntimeState,
} from "../runtime/state.js";

export interface DashboardSnapshot {
  generatedAt: number;
  serverKey: string;
  serverLabel: string;
  connection: string;
  ownerUsername: string;
  live: BotRuntimeState;
  goal: ReturnType<typeof getOpenGoal> | null;
  metrics: {
    activeTasks: number;
    failedTasks: number;
    activeSupplyGoals: number;
    activeFarms: number;
    activeBuilds: number;
    mappedObservations: number;
    indexedContainers: number;
  };
  tasks: Array<{
    id: number;
    title: string;
    status: string;
    completedSteps: number;
    totalSteps: number;
    currentStep: string | null;
    currentStepStatus: string | null;
    lastError: string | null;
    updatedAt: number;
  }>;
  supplyGoals: Array<Record<string, unknown>>;
  farms: Array<Record<string, unknown>>;
  builds: Array<Record<string, unknown>>;
  mapSummary: Array<{ kind: string; count: number; latestSeenAt: number }>;
  events: ReturnType<typeof getRecentEvents>;
  roles: ReturnType<typeof listPlayerRoles>;
  movementFailures: Array<{
    id: number;
    skill: string;
    summary: string;
    code: string | null;
    recoverable: boolean | null;
    details: Record<string, unknown> | null;
    ts: number;
  }>;
}

export function getDashboardSnapshot(
  db: DB,
  runtime: BotRuntimeState | string,
  now = Date.now(),
  ownerUsername = "configured owner",
  serverKey = "legacy",
  serverLabel = serverKey,
): DashboardSnapshot {
  const live = typeof runtime === "string"
    ? disconnectedRuntimeState(runtime)
    : runtime;
  const scalar = (sql: string, ...args: unknown[]): number => {
    const row = db.prepare(sql).get(...args) as { count: number };
    return row.count;
  };
  const tasks = db.prepare(
    `SELECT p.id, p.title, p.status, p.ts_updated, p.last_error,
            COUNT(s.id) AS total_steps,
            SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completed_steps,
            (
              SELECT current.skill FROM task_steps current
              WHERE current.plan_id = p.id AND current.status != 'completed'
              ORDER BY current.position ASC LIMIT 1
            ) AS current_step,
            (
              SELECT current.status FROM task_steps current
              WHERE current.plan_id = p.id AND current.status != 'completed'
              ORDER BY current.position ASC LIMIT 1
            ) AS current_step_status
     FROM task_plans p
     LEFT JOIN task_steps s ON s.plan_id = p.id
     GROUP BY p.id
     ORDER BY
       CASE p.status
         WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'paused' THEN 2
         ELSE 3
       END,
       p.ts_updated DESC
     LIMIT 12`,
  ).all() as Array<{
    id: number;
    title: string;
    status: string;
    ts_updated: number;
    last_error: string | null;
    total_steps: number;
    completed_steps: number;
    current_step: string | null;
    current_step_status: string | null;
  }>;
  const supplyGoals = db.prepare(
    `SELECT id, container_name AS containerName, item, target_quantity AS targetQuantity,
            status, next_check_at AS nextCheckAt, last_error AS lastError
     FROM supply_goals WHERE status != 'cancelled'
     ORDER BY status, next_check_at LIMIT 12`,
  ).all() as Array<Record<string, unknown>>;
  const farms = db.prepare(
    `SELECT id, name, crop, status, next_check_at AS nextCheckAt,
            last_error AS lastError
     FROM farms WHERE status != 'cancelled'
     ORDER BY status, next_check_at LIMIT 12`,
  ).all() as Array<Record<string, unknown>>;
  const builds = db.prepare(
    `SELECT j.id, b.name AS blueprint, j.status, j.dimension,
            j.origin_x AS originX, j.origin_y AS originY, j.origin_z AS originZ,
            j.rotation,
            j.placed_count AS placedCount, j.total_count AS totalCount,
            j.last_error AS lastError, j.ts_updated AS updatedAt,
            (
              SELECT s.skill FROM task_steps s
              WHERE s.plan_id = j.last_plan_id AND s.status != 'completed'
              ORDER BY s.position ASC LIMIT 1
            ) AS stage,
            (
              SELECT s.status FROM task_steps s
              WHERE s.plan_id = j.last_plan_id AND s.status != 'completed'
              ORDER BY s.position ASC LIMIT 1
            ) AS stageStatus
     FROM construction_jobs j
     JOIN blueprints b ON b.id = j.blueprint_id
     ORDER BY j.ts_updated DESC LIMIT 12`,
  ).all() as Array<Record<string, unknown>>;
  const mapSummary = db.prepare(
    `SELECT kind, COUNT(*) AS count, MAX(last_seen_at) AS latestSeenAt
     FROM world_observations WHERE server_key = ?
     GROUP BY kind ORDER BY count DESC`,
  ).all(serverKey) as Array<{ kind: string; count: number; latestSeenAt: number }>;
  const movementFailures = getRecentSkillRuns(db, 100)
    .filter((run) =>
      run.status === "failed" &&
      (
        run.errorCode === "NO_PATH" ||
        run.errorCode === "TIMED_OUT" ||
        typeof run.details?.failureKind === "string"
      ))
    .reverse()
    .slice(0, 8)
    .map((run) => ({
      id: run.id,
      skill: run.skill,
      summary: run.summary ?? "movement failed",
      code: run.errorCode,
      recoverable: run.recoverable,
      details: run.details,
      ts: run.ts_end ?? run.ts_start,
    }));

  return {
    generatedAt: now,
    serverKey,
    serverLabel,
    connection: live.connection,
    ownerUsername,
    live,
    goal: getOpenGoal(db) ?? null,
    metrics: {
      activeTasks: scalar(
        `SELECT COUNT(*) AS count FROM task_plans WHERE status IN ('pending','running','paused')`,
      ),
      failedTasks: scalar("SELECT COUNT(*) AS count FROM task_plans WHERE status = 'failed'"),
      activeSupplyGoals: scalar("SELECT COUNT(*) AS count FROM supply_goals WHERE status = 'active'"),
      activeFarms: scalar("SELECT COUNT(*) AS count FROM farms WHERE status = 'active'"),
      activeBuilds: scalar(
        `SELECT COUNT(*) AS count FROM construction_jobs
         WHERE status IN ('pending','running','paused','blocked')`,
      ),
      mappedObservations: scalar(
        "SELECT COUNT(*) AS count FROM world_observations WHERE server_key = ?",
        serverKey,
      ),
      indexedContainers: scalar("SELECT COUNT(*) AS count FROM containers"),
    },
    tasks: tasks.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      completedSteps: row.completed_steps ?? 0,
      totalSteps: row.total_steps,
      currentStep: row.current_step,
      currentStepStatus: row.current_step_status,
      lastError: row.last_error,
      updatedAt: row.ts_updated,
    })),
    supplyGoals,
    farms,
    builds,
    mapSummary,
    events: getRecentEvents(db, { limit: 15 }),
    roles: listPlayerRoles(db),
    movementFailures,
  };
}
