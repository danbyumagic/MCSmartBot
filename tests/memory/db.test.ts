import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/memory/db.js";
import Database from "better-sqlite3";

let tmp: string;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("creates the schema on a fresh file", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(row.version).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toContain("conversations");
    db.close();
  });

  it("is idempotent on second open", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const path = join(tmp, "memory.sqlite");
    openDatabase(path).close();
    const db = openDatabase(path);
    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(row.version).toBe(1);
    db.close();
  });

  it("loads an explicitly injected schema path", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const schemaPath = join(tmp, "custom-schema.sql");
    writeFileSync(schemaPath, readFileSync(new URL("../../src/memory/schema.sql", import.meta.url), "utf8"));
    const db = openDatabase(join(tmp, "memory.sqlite"), { schemaPath });
    expect((db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number }).version)
      .toBe(18);
    db.close();
  });

  it("migrates legacy world observations into the server-scoped schema", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const path = join(tmp, "memory.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE world_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        dimension TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
        kind TEXT NOT NULL, name TEXT NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1,
        details_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(dimension, x, y, z, kind, name)
      );
      CREATE INDEX idx_world_observations_lookup
        ON world_observations(dimension, kind, name, last_seen_at);
      INSERT INTO world_observations
        (first_seen_at, last_seen_at, dimension, x, y, z, kind, name)
      VALUES (10, 20, 'overworld', 1, 2, 3, 'landmark', 'old_spawn');
    `);
    legacy.close();

    const db = openDatabase(path);
    expect(db.prepare(
      "SELECT server_key AS serverKey, name FROM world_observations",
    ).all()).toEqual([{ serverKey: "legacy", name: "old_spawn" }]);
    const index = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_world_observations_lookup'",
    ).get() as { sql: string };
    expect(index.sql).toContain("server_key");
    db.close();
  });
});
