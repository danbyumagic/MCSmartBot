import type { DB } from "../memory/db.js";

export const OBSERVATION_KINDS = [
  "resource",
  "hazard",
  "container",
  "infrastructure",
  "landmark",
] as const;

export type ObservationKind = typeof OBSERVATION_KINDS[number];

export interface WorldObservationInput {
  dimension: string;
  x: number;
  y: number;
  z: number;
  kind: ObservationKind;
  name: string;
  details?: Record<string, unknown>;
}

export interface WorldObservationRow extends WorldObservationInput {
  id: number;
  serverKey: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  details: Record<string, unknown>;
}

export interface ObservationQuery {
  serverKey?: string;
  dimension?: string;
  kind?: ObservationKind;
  name?: string;
  centerX?: number;
  centerY?: number;
  centerZ?: number;
  radius?: number;
  limit?: number;
}

export function recordWorldObservations(
  db: DB,
  observations: WorldObservationInput[],
  now = Date.now(),
  serverKey = "legacy",
): number {
  if (observations.length === 0) return 0;
  const write = db.transaction(() => {
    const statement = db.prepare(
      `INSERT INTO world_observations
         (server_key, first_seen_at, last_seen_at, dimension, x, y, z, kind, name, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_key, dimension, x, y, z, kind, name) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         seen_count = world_observations.seen_count + 1,
         details_json = excluded.details_json`,
    );
    for (const entry of observations) {
      statement.run(
        serverKey,
        now,
        now,
        entry.dimension,
        entry.x,
        entry.y,
        entry.z,
        entry.kind,
        entry.name.trim().toLowerCase(),
        JSON.stringify(entry.details ?? {}),
      );
    }
    return observations.length;
  });
  return write();
}

export function queryWorldObservations(
  db: DB,
  query: ObservationQuery,
): WorldObservationRow[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (query.serverKey) {
    clauses.push("server_key = ?");
    args.push(query.serverKey);
  }
  if (query.dimension) {
    clauses.push("dimension = ?");
    args.push(query.dimension);
  }
  if (query.kind) {
    clauses.push("kind = ?");
    args.push(query.kind);
  }
  if (query.name) {
    clauses.push("name LIKE ?");
    args.push(`%${query.name.trim().toLowerCase()}%`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT id, server_key, first_seen_at, last_seen_at, dimension, x, y, z,
            kind, name, seen_count, details_json
     FROM world_observations
     ${where}
     ORDER BY last_seen_at DESC
     LIMIT 1000`,
  ).all(...args) as ObservationDbRow[];
  const centerSpecified =
    query.centerX !== undefined &&
    query.centerY !== undefined &&
    query.centerZ !== undefined;
  const radiusSquared = query.radius === undefined ? undefined : query.radius ** 2;
  const mapped = rows.map(mapObservation).filter((row) => {
    if (!centerSpecified || radiusSquared === undefined) return true;
    return distanceSquared(row, query.centerX!, query.centerY!, query.centerZ!) <= radiusSquared;
  });
  if (centerSpecified) {
    mapped.sort((a, b) =>
      distanceSquared(a, query.centerX!, query.centerY!, query.centerZ!) -
      distanceSquared(b, query.centerX!, query.centerY!, query.centerZ!));
  }
  return mapped.slice(0, query.limit ?? 50);
}

interface ObservationDbRow {
  id: number;
  server_key: string;
  first_seen_at: number;
  last_seen_at: number;
  dimension: string;
  x: number;
  y: number;
  z: number;
  kind: ObservationKind;
  name: string;
  seen_count: number;
  details_json: string;
}

function mapObservation(row: ObservationDbRow): WorldObservationRow {
  return {
    id: row.id,
    serverKey: row.server_key,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    dimension: row.dimension,
    x: row.x,
    y: row.y,
    z: row.z,
    kind: row.kind,
    name: row.name,
    seenCount: row.seen_count,
    details: JSON.parse(row.details_json) as Record<string, unknown>,
  };
}

function distanceSquared(
  row: Pick<WorldObservationRow, "x" | "y" | "z">,
  x: number,
  y: number,
  z: number,
): number {
  return (row.x - x) ** 2 + (row.y - y) ** 2 + (row.z - z) ** 2;
}
