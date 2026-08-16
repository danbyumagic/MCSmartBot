import type { DB } from "./db.js";

export interface LocationInput {
  name: string;
  dimension?: string;
  x: number;
  y: number;
  z: number;
  notes?: string;
}

export interface LocationRow {
  id: number;
  ts: number;
  name: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  notes: string | null;
}

export function upsertLocation(db: DB, input: LocationInput): LocationRow {
  const ts = Date.now();
  const dimension = input.dimension ?? "overworld";
  db
    .prepare(
      `INSERT INTO locations (ts, name, dimension, x, y, z, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         ts = excluded.ts,
         dimension = excluded.dimension,
         x = excluded.x,
         y = excluded.y,
         z = excluded.z,
         notes = excluded.notes`,
    )
    .run(ts, input.name, dimension, input.x, input.y, input.z, input.notes ?? null);

  const row = getLocation(db, input.name);
  if (!row) throw new Error(`upsertLocation: row '${input.name}' missing after insert`);
  return row;
}

export function getLocation(db: DB, name: string): LocationRow | undefined {
  const row = db
    .prepare("SELECT id, ts, name, dimension, x, y, z, notes FROM locations WHERE name = ?")
    .get(name) as LocationRow | undefined;
  return row;
}

export function listLocations(db: DB): LocationRow[] {
  return db
    .prepare("SELECT id, ts, name, dimension, x, y, z, notes FROM locations ORDER BY name ASC")
    .all() as LocationRow[];
}
