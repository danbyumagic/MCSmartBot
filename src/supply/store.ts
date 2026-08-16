import type { DB } from "../memory/db.js";

export type SupplyGoalStatus = "active" | "paused" | "cancelled";

export interface SupplyGoalInput {
  containerName: string;
  item: string;
  targetQuantity: number;
  searchRadius?: number;
  intervalMinutes?: number;
}

export interface SupplyGoalRow {
  id: number;
  tsCreated: number;
  tsUpdated: number;
  containerName: string;
  item: string;
  targetQuantity: number;
  searchRadius: number;
  intervalMinutes: number;
  status: SupplyGoalStatus;
  nextCheckAt: number;
  lastPlanId: number | null;
  lastError: string | null;
}

export function createSupplyGoal(
  db: DB,
  input: SupplyGoalInput,
  now = Date.now(),
): SupplyGoalRow {
  const result = db.prepare(
    `INSERT INTO supply_goals
      (ts_created, ts_updated, container_name, item, target_quantity,
       search_radius, interval_minutes, status, next_check_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    now,
    now,
    input.containerName,
    input.item,
    input.targetQuantity,
    input.searchRadius ?? 64,
    input.intervalMinutes ?? 15,
    now,
  );
  return getSupplyGoal(db, Number(result.lastInsertRowid))!;
}

export function getSupplyGoal(db: DB, id: number): SupplyGoalRow | undefined {
  const row = db.prepare(
    `SELECT id, ts_created, ts_updated, container_name, item, target_quantity,
            search_radius, interval_minutes, status, next_check_at,
            last_plan_id, last_error
     FROM supply_goals WHERE id = ?`,
  ).get(id);
  return row ? mapRow(row as RawSupplyGoal) : undefined;
}

export function listDueSupplyGoals(
  db: DB,
  now = Date.now(),
): SupplyGoalRow[] {
  return (db.prepare(
    `SELECT id, ts_created, ts_updated, container_name, item, target_quantity,
            search_radius, interval_minutes, status, next_check_at,
            last_plan_id, last_error
     FROM supply_goals
     WHERE status = 'active' AND next_check_at <= ?
     ORDER BY next_check_at ASC, id ASC`,
  ).all(now) as RawSupplyGoal[]).map(mapRow);
}

export function markSupplyGoalPlan(
  db: DB,
  goalId: number,
  planId: number,
  now = Date.now(),
): void {
  // Push the next check into the future immediately so repeated scheduler ticks
  // cannot create duplicate plans while this one is still running.
  const goal = getSupplyGoal(db, goalId);
  if (!goal) return;
  db.prepare(
    `UPDATE supply_goals
     SET last_plan_id = ?, next_check_at = ?, ts_updated = ?, last_error = NULL
     WHERE id = ?`,
  ).run(planId, now + goal.intervalMinutes * 60_000, now, goalId);
}

export function finishSupplyGoalPlan(
  db: DB,
  planId: number,
  result: { error?: string },
  now = Date.now(),
): SupplyGoalRow | undefined {
  const row = db.prepare(
    `SELECT id FROM supply_goals WHERE last_plan_id = ?`,
  ).get(planId) as { id: number } | undefined;
  if (!row) return undefined;
  const goal = getSupplyGoal(db, row.id);
  if (!goal) return undefined;
  const retryMinutes = result.error
    ? Math.min(goal.intervalMinutes, 5)
    : goal.intervalMinutes;
  db.prepare(
    `UPDATE supply_goals
     SET next_check_at = ?, ts_updated = ?, last_error = ?
     WHERE id = ?`,
  ).run(now + retryMinutes * 60_000, now, result.error ?? null, goal.id);
  return getSupplyGoal(db, goal.id);
}

export function setSupplyGoalStatus(
  db: DB,
  id: number,
  status: SupplyGoalStatus,
  now = Date.now(),
): boolean {
  const result = db.prepare(
    `UPDATE supply_goals
     SET status = ?, ts_updated = ?, next_check_at = CASE WHEN ? = 'active' THEN ? ELSE next_check_at END
     WHERE id = ? AND status != 'cancelled'`,
  ).run(status, now, status, now, id);
  return result.changes > 0;
}

interface RawSupplyGoal {
  id: number;
  ts_created: number;
  ts_updated: number;
  container_name: string;
  item: string;
  target_quantity: number;
  search_radius: number;
  interval_minutes: number;
  status: SupplyGoalStatus;
  next_check_at: number;
  last_plan_id: number | null;
  last_error: string | null;
}

function mapRow(row: RawSupplyGoal): SupplyGoalRow {
  return {
    id: row.id,
    tsCreated: row.ts_created,
    tsUpdated: row.ts_updated,
    containerName: row.container_name,
    item: row.item,
    targetQuantity: row.target_quantity,
    searchRadius: row.search_radius,
    intervalMinutes: row.interval_minutes,
    status: row.status,
    nextCheckAt: row.next_check_at,
    lastPlanId: row.last_plan_id,
    lastError: row.last_error,
  };
}
