import type { DB } from "../memory/db.js";

export const FARM_CROPS = [
  "wheat",
  "carrots",
  "potatoes",
  "beetroots",
  "nether_wart",
] as const;
export type FarmCrop = typeof FARM_CROPS[number];
export type FarmStatus = "active" | "paused" | "cancelled";

export interface FarmInput {
  name: string;
  dimension?: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  crop: FarmCrop;
  storageName?: string;
  seedReserve?: number;
  intervalMinutes?: number;
}

export interface FarmRow extends Required<Omit<FarmInput, "storageName">> {
  id: number;
  tsCreated: number;
  tsUpdated: number;
  storageName: string | null;
  status: FarmStatus;
  nextCheckAt: number;
  lastPlanId: number | null;
  lastError: string | null;
}

export function upsertFarm(db: DB, input: FarmInput, now = Date.now()): FarmRow {
  const bounds = normalizeBounds(input);
  db.prepare(
    `INSERT INTO farms
      (ts_created, ts_updated, name, dimension, min_x, min_y, min_z,
       max_x, max_y, max_z, crop, storage_name, seed_reserve,
       interval_minutes, status, next_check_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT(name) DO UPDATE SET
       ts_updated = excluded.ts_updated,
       dimension = excluded.dimension,
       min_x = excluded.min_x, min_y = excluded.min_y, min_z = excluded.min_z,
       max_x = excluded.max_x, max_y = excluded.max_y, max_z = excluded.max_z,
       crop = excluded.crop,
       storage_name = excluded.storage_name,
       seed_reserve = excluded.seed_reserve,
       interval_minutes = excluded.interval_minutes,
       status = 'active',
       next_check_at = excluded.next_check_at,
       last_error = NULL`,
  ).run(
    now,
    now,
    input.name,
    input.dimension ?? "overworld",
    bounds.minX, bounds.minY, bounds.minZ,
    bounds.maxX, bounds.maxY, bounds.maxZ,
    input.crop,
    input.storageName ?? null,
    input.seedReserve ?? 16,
    input.intervalMinutes ?? 15,
    now,
  );
  return getFarmByName(db, input.name)!;
}

export function getFarm(db: DB, id: number): FarmRow | undefined {
  const row = db.prepare("SELECT * FROM farms WHERE id = ?").get(id);
  return row ? mapRow(row as RawFarm) : undefined;
}

export function getFarmByName(db: DB, name: string): FarmRow | undefined {
  const row = db.prepare("SELECT * FROM farms WHERE name = ?").get(name);
  return row ? mapRow(row as RawFarm) : undefined;
}

export function listDueFarms(db: DB, now = Date.now()): FarmRow[] {
  return (db.prepare(
    `SELECT * FROM farms
     WHERE status = 'active' AND next_check_at <= ?
     ORDER BY next_check_at ASC, id ASC`,
  ).all(now) as RawFarm[]).map(mapRow);
}

export function markFarmPlan(db: DB, farmId: number, planId: number, now = Date.now()): void {
  const farm = getFarm(db, farmId);
  if (!farm) return;
  db.prepare(
    `UPDATE farms
     SET last_plan_id = ?, next_check_at = ?, ts_updated = ?, last_error = NULL
     WHERE id = ?`,
  ).run(planId, now + farm.intervalMinutes * 60_000, now, farmId);
}

export function finishFarmPlan(
  db: DB,
  planId: number,
  error?: string,
  now = Date.now(),
): FarmRow | undefined {
  const row = db.prepare("SELECT id FROM farms WHERE last_plan_id = ?")
    .get(planId) as { id: number } | undefined;
  if (!row) return undefined;
  const farm = getFarm(db, row.id);
  if (!farm) return undefined;
  const delayMinutes = error ? Math.min(5, farm.intervalMinutes) : farm.intervalMinutes;
  db.prepare(
    `UPDATE farms SET next_check_at = ?, ts_updated = ?, last_error = ? WHERE id = ?`,
  ).run(now + delayMinutes * 60_000, now, error ?? null, farm.id);
  return getFarm(db, farm.id);
}

export function setFarmStatus(
  db: DB,
  id: number,
  status: FarmStatus,
  now = Date.now(),
): boolean {
  const result = db.prepare(
    `UPDATE farms
     SET status = ?, ts_updated = ?,
         next_check_at = CASE WHEN ? = 'active' THEN ? ELSE next_check_at END
     WHERE id = ? AND status != 'cancelled'`,
  ).run(status, now, status, now, id);
  return result.changes > 0;
}

function normalizeBounds(input: FarmInput) {
  return {
    minX: Math.min(input.minX, input.maxX),
    minY: Math.min(input.minY, input.maxY),
    minZ: Math.min(input.minZ, input.maxZ),
    maxX: Math.max(input.minX, input.maxX),
    maxY: Math.max(input.minY, input.maxY),
    maxZ: Math.max(input.minZ, input.maxZ),
  };
}

interface RawFarm {
  id: number;
  ts_created: number;
  ts_updated: number;
  name: string;
  dimension: string;
  min_x: number;
  min_y: number;
  min_z: number;
  max_x: number;
  max_y: number;
  max_z: number;
  crop: FarmCrop;
  storage_name: string | null;
  seed_reserve: number;
  interval_minutes: number;
  status: FarmStatus;
  next_check_at: number;
  last_plan_id: number | null;
  last_error: string | null;
}

function mapRow(row: RawFarm): FarmRow {
  return {
    id: row.id,
    tsCreated: row.ts_created,
    tsUpdated: row.ts_updated,
    name: row.name,
    dimension: row.dimension,
    minX: row.min_x,
    minY: row.min_y,
    minZ: row.min_z,
    maxX: row.max_x,
    maxY: row.max_y,
    maxZ: row.max_z,
    crop: row.crop,
    storageName: row.storage_name,
    seedReserve: row.seed_reserve,
    intervalMinutes: row.interval_minutes,
    status: row.status,
    nextCheckAt: row.next_check_at,
    lastPlanId: row.last_plan_id,
    lastError: row.last_error,
  };
}
