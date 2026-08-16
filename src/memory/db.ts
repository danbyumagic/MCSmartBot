import Database, { type Database as DB } from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

// schema.sql is read at runtime. The npm build script copies it to dist/memory/
// so the default path resolves under tsx and built JS. Electron injects an
// explicit resource path because its main bundle is not adjacent to the schema.

export function openDatabase(path: string, options: { schemaPath?: string } = {}): DB {
  mkdirSync(dirname(path), { recursive: true });
  let db: DB | null = null;
  try {
    db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const schemaPath = options.schemaPath
      ?? fileURLToPath(new URL("./schema.sql", import.meta.url));
    const schema = readFileSync(schemaPath, "utf8");
    db.exec(schema);
    migrateServerScopedWorldObservations(db);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_world_observations_lookup
      ON world_observations(server_key, dimension, kind, name, last_seen_at)`);
    migrateSkillRunOutcomes(db);
    migrateConstructionRotation(db);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the original schema/migration error.
    }
    throw error;
  }
}

function migrateServerScopedWorldObservations(db: DB): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(world_observations)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (columns.has("server_key")) return;
  db.exec(`
    BEGIN;
    ALTER TABLE world_observations RENAME TO world_observations_legacy;
    CREATE TABLE world_observations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      server_key    TEXT NOT NULL DEFAULT 'legacy',
      first_seen_at INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL,
      dimension     TEXT NOT NULL,
      x             INTEGER NOT NULL,
      y             INTEGER NOT NULL,
      z             INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      name          TEXT NOT NULL,
      seen_count    INTEGER NOT NULL DEFAULT 1,
      details_json  TEXT NOT NULL DEFAULT '{}',
      UNIQUE(server_key, dimension, x, y, z, kind, name)
    );
    INSERT INTO world_observations
      (id, server_key, first_seen_at, last_seen_at, dimension, x, y, z, kind, name, seen_count, details_json)
    SELECT id, 'legacy', first_seen_at, last_seen_at, dimension, x, y, z, kind, name, seen_count, details_json
    FROM world_observations_legacy;
    DROP TABLE world_observations_legacy;
    CREATE INDEX idx_world_observations_lookup
      ON world_observations(server_key, dimension, kind, name, last_seen_at);
    COMMIT;
  `);
}

function migrateConstructionRotation(db: DB): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(construction_jobs)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (!columns.has("rotation")) {
    db.exec(
      "ALTER TABLE construction_jobs ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0",
    );
  }
}

function migrateSkillRunOutcomes(db: DB): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(skill_runs)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const additions = [
    ["error_code", "TEXT"],
    ["recoverable", "INTEGER"],
    ["details_json", "TEXT"],
  ] as const;
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE skill_runs ADD COLUMN ${name} ${type}`);
  }
}

export type { DB };
