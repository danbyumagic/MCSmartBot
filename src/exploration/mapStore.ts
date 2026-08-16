import type { DB } from "../memory/db.js";
import { TERRAIN_SAMPLE_SIZE } from "./terrainStore.js";

export const MAP_CELL_SIZE = 8;

export interface MapPositionInput {
  serverKey: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
}

export interface MapSurveyInput extends MapPositionInput {
  radius: number;
  label: string;
}

export function makeServerKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

/**
 * A v12 database had no server identity. On its first v13 start, the configured
 * server is the only reliable owner for that history. This is idempotent and
 * also rebuilds survey circles from the old landmark observations.
 */
export function adoptLegacyWorldMap(db: DB, serverKey: string): number {
  const legacy = db.prepare(
    "SELECT COUNT(*) AS count FROM world_observations WHERE server_key = 'legacy'",
  ).get() as { count: number };
  if (legacy.count === 0 || serverKey === "legacy") return 0;
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO map_surveys
         (server_key, dimension, center_x, center_y, center_z, radius, label,
          first_seen_at, last_seen_at, scan_count)
       SELECT ?, dimension, x, y, z,
              CAST(json_extract(details_json, '$.radius') AS INTEGER), name,
              first_seen_at, last_seen_at, seen_count
       FROM world_observations
       WHERE server_key = 'legacy' AND kind = 'landmark'
         AND json_type(details_json, '$.radius') IN ('integer', 'real')`,
    ).run(serverKey);
    db.prepare(
      `INSERT INTO world_observations
         (server_key, first_seen_at, last_seen_at, dimension, x, y, z,
          kind, name, seen_count, details_json)
       SELECT ?, first_seen_at, last_seen_at, dimension, x, y, z,
              kind, name, seen_count, details_json
       FROM world_observations WHERE server_key = 'legacy'
       ON CONFLICT(server_key, dimension, x, y, z, kind, name) DO UPDATE SET
         first_seen_at = MIN(world_observations.first_seen_at, excluded.first_seen_at),
         last_seen_at = MAX(world_observations.last_seen_at, excluded.last_seen_at),
         seen_count = world_observations.seen_count + excluded.seen_count,
         details_json = CASE
           WHEN excluded.last_seen_at >= world_observations.last_seen_at
           THEN excluded.details_json ELSE world_observations.details_json END`,
    ).run(serverKey);
    db.prepare("DELETE FROM world_observations WHERE server_key = 'legacy'").run();
  })();
  return legacy.count;
}

export function recordMapPosition(db: DB, input: MapPositionInput, now = Date.now()): void {
  const cellX = Math.floor(input.x / MAP_CELL_SIZE);
  const cellZ = Math.floor(input.z / MAP_CELL_SIZE);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO map_trail_cells
         (server_key, dimension, cell_x, cell_z, min_y, max_y, visits, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(server_key, dimension, cell_x, cell_z) DO UPDATE SET
         min_y = MIN(map_trail_cells.min_y, excluded.min_y),
         max_y = MAX(map_trail_cells.max_y, excluded.max_y),
         visits = map_trail_cells.visits + 1,
         last_seen_at = excluded.last_seen_at`,
    ).run(input.serverKey, input.dimension, cellX, cellZ, input.y, input.y, now, now);
    db.prepare(
      `INSERT INTO map_trail_points (server_key, dimension, x, y, z, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.serverKey, input.dimension, input.x, input.y, input.z, now);
  })();
}

export function recordMapSurvey(db: DB, input: MapSurveyInput, now = Date.now()): void {
  db.prepare(
    `INSERT INTO map_surveys
       (server_key, dimension, center_x, center_y, center_z, radius, label, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_key, dimension, center_x, center_y, center_z, radius, label) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       scan_count = map_surveys.scan_count + 1`,
  ).run(
    input.serverKey,
    input.dimension,
    input.x,
    input.y,
    input.z,
    input.radius,
    input.label.trim().toLowerCase(),
    now,
    now,
  );
}

export interface DashboardMapData {
  serverKey: string;
  dimension: string;
  cellSize: number;
  terrainSampleSize: number;
  servers: Array<{ serverKey: string; dimensions: string[]; lastSeenAt: number }>;
  dimensions: string[];
  cells: Array<{
    cellX: number;
    cellZ: number;
    minY: number;
    maxY: number;
    visits: number;
    firstSeenAt: number;
    lastSeenAt: number;
  }>;
  trail: Array<{ x: number; y: number; z: number; ts: number }>;
  surveys: Array<{
    x: number;
    y: number;
    z: number;
    radius: number;
    label: string;
    scanCount: number;
    lastSeenAt: number;
  }>;
  observations: Array<{
    x: number;
    y: number;
    z: number;
    kind: string;
    name: string;
    lastSeenAt: number;
  }>;
  terrain: Array<{
    x: number;
    y: number;
    z: number;
    blockName: string;
    updatedAt: number;
  }>;
}

export function getDashboardMap(
  db: DB,
  requestedServerKey: string,
  requestedDimension?: string,
): DashboardMapData {
  const serverRows = db.prepare(
    `SELECT server_key AS serverKey, dimension, MAX(last_seen_at) AS lastSeenAt
     FROM (
       SELECT server_key, dimension, last_seen_at FROM map_trail_cells
       UNION ALL
       SELECT server_key, dimension, last_seen_at FROM map_surveys
       UNION ALL
       SELECT server_key, dimension, last_seen_at FROM world_observations
       UNION ALL
       SELECT server_key, dimension, updated_at AS last_seen_at FROM map_terrain_samples
     )
     GROUP BY server_key, dimension
     ORDER BY lastSeenAt DESC`,
  ).all() as Array<{ serverKey: string; dimension: string; lastSeenAt: number }>;
  const grouped = new Map<string, { dimensions: string[]; lastSeenAt: number }>();
  for (const row of serverRows) {
    const entry = grouped.get(row.serverKey) ?? { dimensions: [], lastSeenAt: 0 };
    if (!entry.dimensions.includes(row.dimension)) entry.dimensions.push(row.dimension);
    entry.lastSeenAt = Math.max(entry.lastSeenAt, row.lastSeenAt);
    grouped.set(row.serverKey, entry);
  }
  if (!grouped.has(requestedServerKey)) {
    grouped.set(requestedServerKey, { dimensions: [requestedDimension ?? "overworld"], lastSeenAt: 0 });
  }
  const dimensions = grouped.get(requestedServerKey)?.dimensions ?? ["overworld"];
  const dimension = requestedDimension && dimensions.includes(requestedDimension)
    ? requestedDimension
    : dimensions[0] ?? "overworld";
  const cells = db.prepare(
    `SELECT cell_x AS cellX, cell_z AS cellZ, min_y AS minY, max_y AS maxY,
            visits, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
     FROM map_trail_cells WHERE server_key = ? AND dimension = ?
     ORDER BY last_seen_at ASC LIMIT 10000`,
  ).all(requestedServerKey, dimension) as DashboardMapData["cells"];
  const trail = db.prepare(
    `SELECT x, y, z, ts FROM map_trail_points
     WHERE server_key = ? AND dimension = ? ORDER BY id DESC LIMIT 5000`,
  ).all(requestedServerKey, dimension).reverse() as DashboardMapData["trail"];
  const surveys = db.prepare(
    `SELECT center_x AS x, center_y AS y, center_z AS z, radius, label,
            scan_count AS scanCount, last_seen_at AS lastSeenAt
     FROM map_surveys WHERE server_key = ? AND dimension = ?
     ORDER BY last_seen_at DESC LIMIT 1000`,
  ).all(requestedServerKey, dimension) as DashboardMapData["surveys"];
  const observations = db.prepare(
    `SELECT x, y, z, kind, name, last_seen_at AS lastSeenAt
     FROM world_observations WHERE server_key = ? AND dimension = ?
     ORDER BY last_seen_at DESC LIMIT 2000`,
  ).all(requestedServerKey, dimension) as DashboardMapData["observations"];
  const terrain = db.prepare(
    `SELECT x, y, z, block_name AS blockName, updated_at AS updatedAt
     FROM map_terrain_samples WHERE server_key = ? AND dimension = ?
     ORDER BY x, z LIMIT 100000`,
  ).all(requestedServerKey, dimension) as DashboardMapData["terrain"];
  return {
    serverKey: requestedServerKey,
    dimension,
    cellSize: MAP_CELL_SIZE,
    terrainSampleSize: TERRAIN_SAMPLE_SIZE,
    servers: Array.from(grouped, ([serverKey, value]) => ({ serverKey, ...value }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    dimensions,
    cells,
    trail,
    surveys,
    observations,
    terrain,
  };
}

export function createMapTrailRecorder(db: DB, serverKey: string): {
  capture(input: Omit<MapPositionInput, "serverKey">, now?: number): boolean;
} {
  let lastIdentity = "";
  return {
    capture(input, now = Date.now()) {
      const identity = `${input.dimension}:${Math.floor(input.x / MAP_CELL_SIZE)}:${Math.floor(input.z / MAP_CELL_SIZE)}`;
      if (identity === lastIdentity) return false;
      lastIdentity = identity;
      recordMapPosition(db, { ...input, serverKey }, now);
      return true;
    },
  };
}
