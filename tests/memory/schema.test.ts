import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/memory/db.js";

let tmp: string;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function tablesIn(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r: { name: string }) => r.name);
}

describe("schema v18", () => {
  it("creates the new tables and the FTS virtual table", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    const names = tablesIn(db);
    for (const t of [
      "conversations", "facts", "locations", "goals", "skill_runs", "memory_search",
      "containers", "container_items",
      "inventory_policies",
      "task_plans", "task_steps", "task_plan_actors",
      "supply_goals",
      "farms",
      "blueprints", "blueprint_sources", "construction_jobs",
      "world_observations",
      "map_trail_cells", "map_trail_points", "map_surveys",
      "map_terrain_samples",
      "player_roles",
      "event_log", "notification_rules",
      "world_transactions", "world_changes",
      "mission_definitions", "mission_runs", "mission_step_links",
    ]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it("records schema version 18", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(row.v).toBe(18);
    db.close();
  });

  it("defines server-scoped transaction and ordered block-change records", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    expect(
      db.prepare("PRAGMA table_info(world_transactions)").all(),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "server_key", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "dimension", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "actor_username", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "actor_role", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "actor_source", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "budget_scope", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "requested_change_count", type: "INTEGER", notnull: 1 }),
      expect.objectContaining({ name: "applied_change_count", type: "INTEGER", notnull: 1 }),
    ]));
    expect(
      db.prepare("PRAGMA table_info(world_changes)").all(),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "transaction_id", type: "INTEGER", notnull: 1 }),
      expect.objectContaining({ name: "ordinal", type: "INTEGER", notnull: 1 }),
      expect.objectContaining({ name: "before_json", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "intended_json", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "confirmed_after_json", type: "TEXT", notnull: 0 }),
    ]));
    expect(
      db.prepare("PRAGMA foreign_key_list(world_changes)").all(),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "world_transactions",
        from: "transaction_id",
        to: "id",
        on_delete: "CASCADE",
      }),
    ]));
    expect(
      db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_world_changes_coordinate'",
      ).get(),
    ).toEqual(expect.objectContaining({ sql: expect.stringContaining("x, y, z") }));
    db.close();
  });

  it("keeps BuildOps source metadata one-to-one with blueprints", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    expect(db.prepare("PRAGMA table_info(blueprint_sources)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "blueprint_id", type: "INTEGER", pk: 1, notnull: 0 }),
      expect.objectContaining({ name: "source_schema", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "target_version", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "source_json", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "source_hash", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "compile_report_json", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "creator_username", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "creator_source", type: "TEXT", notnull: 1 }),
    ]));
    expect(db.prepare("PRAGMA foreign_key_list(blueprint_sources)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "blueprints", from: "blueprint_id", to: "id", on_delete: "CASCADE" }),
    ]));
    db.close();
  });

  it("defines durable mission definitions, immutable runs, and logical-step links", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    expect(db.prepare("PRAGMA table_info(mission_definitions)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "id", type: "INTEGER", pk: 1 }),
      expect.objectContaining({ name: "name", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "schema", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "source_json", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "source_hash", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "creator_username", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "creator_source", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "enabled", type: "INTEGER", notnull: 1 }),
    ]));
    expect(db.prepare("PRAGMA table_info(mission_runs)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "definition_id", type: "INTEGER", notnull: 0 }),
      expect.objectContaining({ name: "source_schema", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "source_json", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "source_hash", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "actor_username", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "actor_role", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "actor_source", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "limits_json", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "compile_report_json", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "task_plan_id", type: "INTEGER", notnull: 0 }),
      expect.objectContaining({ name: "transaction_scope", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "transaction_correlation_json", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "deadline_at", type: "INTEGER", notnull: 1 }),
      expect.objectContaining({ name: "status", type: "TEXT", notnull: 1 }),
    ]));
    expect(db.prepare("PRAGMA table_info(mission_step_links)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "mission_run_id", type: "INTEGER", notnull: 1 }),
      expect.objectContaining({ name: "logical_step_id", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "logical_position", type: "INTEGER", notnull: 1 }),
      expect.objectContaining({ name: "expanded_start_position", type: "INTEGER", notnull: 1 }),
      expect.objectContaining({ name: "expanded_step_count", type: "INTEGER", notnull: 1 }),
      expect.objectContaining({ name: "construction_job_id", type: "INTEGER", notnull: 0 }),
      expect.objectContaining({ name: "compile_metadata_json", type: "TEXT", notnull: 1 }),
    ]));
    expect(db.prepare("PRAGMA foreign_key_list(mission_runs)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "mission_definitions", from: "definition_id", to: "id", on_delete: "SET NULL" }),
      expect.objectContaining({ table: "task_plans", from: "task_plan_id", to: "id", on_delete: "SET NULL" }),
    ]));
    expect(db.prepare("PRAGMA foreign_key_list(mission_step_links)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "mission_runs", from: "mission_run_id", to: "id", on_delete: "CASCADE" }),
      expect.objectContaining({ table: "construction_jobs", from: "construction_job_id", to: "id", on_delete: "SET NULL" }),
    ]));
    for (const name of [
      "idx_mission_definitions_name",
      "idx_mission_runs_recent",
      "idx_mission_runs_status",
      "idx_mission_runs_task_plan",
      "idx_mission_step_links_construction_job",
      "idx_mission_step_links_construction_job_unique",
    ]) {
      expect(db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).get(name)).toEqual({ name });
    }
    expect(db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_mission_step_links_construction_job_unique'",
    ).get()).toEqual(expect.objectContaining({ sql: expect.stringContaining("WHERE construction_job_id IS NOT NULL") }));
    db.close();
  });

  it("enforces mission link cardinality and keeps a run after its saved definition is removed", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    const definitionId = Number(db.prepare(
      `INSERT INTO mission_definitions
         (ts_created, ts_updated, name, schema, source_json, source_hash, creator_username, creator_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 1, "reusable", "smartbot.mission/v1", "{}", "definition-hash", "owner", "desktop").lastInsertRowid);
    const runId = Number(db.prepare(
      `INSERT INTO mission_runs
         (ts_created, ts_updated, definition_id, source_schema, source_json, source_hash,
          actor_username, actor_role, actor_source, limits_json, compile_report_json,
          transaction_scope, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      2, 2, definitionId, "smartbot.mission/v1", "{}", "run-hash",
      "owner", "owner", "desktop", "{}", "{}", "mission:1", 3,
    ).lastInsertRowid);
    const insertLink = db.prepare(
      `INSERT INTO mission_step_links
         (mission_run_id, logical_step_id, logical_position, expanded_start_position, expanded_step_count)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertLink.run(runId, "survey", 0, 0, 1);
    expect(() => insertLink.run(runId, "survey", 1, 1, 1)).toThrow();
    expect(() => insertLink.run(runId, "clear", 1, 1, 0)).toThrow();

    db.prepare("DELETE FROM mission_definitions WHERE id = ?").run(definitionId);
    expect(db.prepare(
      "SELECT definition_id AS definitionId, source_hash AS sourceHash FROM mission_runs WHERE id = ?",
    ).get(runId)).toEqual({ definitionId: null, sourceHash: "run-hash" });
    db.prepare("DELETE FROM mission_runs WHERE id = ?").run(runId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mission_step_links").get()).toEqual({ count: 0 });
    db.close();
  });

  it("opens a v14-shaped task fixture without losing durable plan data", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const path = join(tmp, "memory.sqlite");
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (14);
      CREATE TABLE task_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_created INTEGER NOT NULL,
        ts_updated INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT
      );
      CREATE TABLE task_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        skill TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_attempt_at INTEGER,
        last_error_code TEXT,
        last_error TEXT,
        result_json TEXT,
        UNIQUE(plan_id, position)
      );
    `);
    legacy.prepare(
      "INSERT INTO task_plans (id, ts_created, ts_updated, title, status) VALUES (?, ?, ?, ?, ?)",
    ).run(41, 1, 2, "legacy plan", "pending");
    legacy.prepare(
      "INSERT INTO task_steps (plan_id, position, skill, params_json) VALUES (?, ?, ?, ?)",
    ).run(41, 0, "gotoCoords", "{}");
    legacy.close();

    const db = openDatabase(path);
    expect(
      db.prepare("SELECT MAX(version) AS v FROM schema_version").get(),
    ).toEqual({ v: 18 });
    expect(
      db.prepare("SELECT id, title, status FROM task_plans WHERE id = ?").get(41),
    ).toEqual({ id: 41, title: "legacy plan", status: "pending" });
    expect(
      db.prepare("SELECT plan_id AS planId, position, skill FROM task_steps WHERE plan_id = ?").get(41),
    ).toEqual({ planId: 41, position: 0, skill: "gotoCoords" });
    expect(
      db.prepare("PRAGMA table_info(task_plan_actors)").all(),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "plan_id", type: "INTEGER", pk: 1 }),
      expect.objectContaining({ name: "actor_username", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "actor_role", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "actor_source", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "ts_authorized", type: "INTEGER", notnull: 1 }),
    ]));
    expect(
      db.prepare("PRAGMA foreign_key_list(task_plan_actors)").all(),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "task_plans",
        from: "plan_id",
        to: "id",
        on_delete: "CASCADE",
      }),
    ]));
    db.close();
  });

  it("opens a v17-shaped fixture without losing saved source data and adds mission tables", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const path = join(tmp, "memory.sqlite");
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (17);
      CREATE TABLE task_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_created INTEGER NOT NULL,
        ts_updated INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT
      );
      CREATE TABLE blueprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_created INTEGER NOT NULL,
        ts_updated INTEGER NOT NULL,
        name TEXT NOT NULL UNIQUE,
        blocks_json TEXT NOT NULL
      );
      CREATE TABLE blueprint_sources (
        blueprint_id INTEGER PRIMARY KEY REFERENCES blueprints(id) ON DELETE CASCADE,
        ts_created INTEGER NOT NULL,
        ts_updated INTEGER NOT NULL,
        source_schema TEXT NOT NULL,
        target_version TEXT NOT NULL,
        source_json TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        compile_report_json TEXT NOT NULL,
        creator_username TEXT NOT NULL,
        creator_source TEXT NOT NULL
      );
      INSERT INTO blueprints (id, ts_created, ts_updated, name, blocks_json)
      VALUES (7, 1, 2, 'legacy-source', '[{"x":0,"y":0,"z":0,"block":"stone"}]');
      INSERT INTO blueprint_sources
        (blueprint_id, ts_created, ts_updated, source_schema, target_version,
         source_json, source_hash, compile_report_json, creator_username, creator_source)
      VALUES (7, 1, 2, 'smartbot.build/v1', '1.21.11', '{}', 'abc', '{}', 'owner', 'cli');
    `);
    legacy.close();

    const db = openDatabase(path);
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: 18 });
    expect(db.prepare(
      "SELECT b.name, s.source_hash AS sourceHash FROM blueprints b JOIN blueprint_sources s ON s.blueprint_id = b.id WHERE b.id = ?",
    ).get(7)).toEqual({ name: "legacy-source", sourceHash: "abc" });
    expect(tablesIn(db)).toEqual(expect.arrayContaining([
      "mission_definitions", "mission_runs", "mission_step_links",
    ]));
    db.close();
  });

  it("FTS triggers keep memory_search in sync with facts", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    db.prepare("INSERT INTO facts (ts, topic, text, source) VALUES (?, ?, ?, ?)")
      .run(Date.now(), "iron", "owner prefers polished cobble walls", "chat");
    const hits = db
      .prepare("SELECT kind, topic FROM memory_search WHERE memory_search MATCH ?")
      .all("polished") as { kind: string; topic: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("fact");
    expect(hits[0]?.topic).toBe("iron");
    db.close();
  });

  it("FTS triggers keep memory_search in sync with locations", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    db.prepare("INSERT INTO locations (ts, name, x, y, z, notes) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Date.now(), "base", 0, 64, 0, "main hideout near the spawn river");
    const hits = db
      .prepare("SELECT kind, topic FROM memory_search WHERE memory_search MATCH ?")
      .all("river") as { kind: string; topic: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.topic).toBe("base");
    db.close();
  });

  it("FTS DELETE trigger removes fact rows from memory_search", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    const ins = db.prepare("INSERT INTO facts (ts, topic, text, source) VALUES (?, ?, ?, ?)")
      .run(Date.now(), "iron", "south vein exhausted", "chat");
    const id = Number(ins.lastInsertRowid);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM memory_search WHERE kind = 'fact' AND ref_id = ?").get(id),
    ).toEqual({ c: 1 });
    db.prepare("DELETE FROM facts WHERE id = ?").run(id);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM memory_search WHERE kind = 'fact' AND ref_id = ?").get(id),
    ).toEqual({ c: 0 });
    db.close();
  });

  it("FTS UPDATE trigger replaces the fact row in memory_search rather than duplicating", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    const ins = db.prepare("INSERT INTO facts (ts, topic, text, source) VALUES (?, ?, ?, ?)")
      .run(Date.now(), "iron", "first text", "chat");
    const id = Number(ins.lastInsertRowid);
    db.prepare("UPDATE facts SET text = ? WHERE id = ?").run("second text", id);
    const rows = db
      .prepare("SELECT text FROM memory_search WHERE kind = 'fact' AND ref_id = ?")
      .all(id) as { text: string }[];
    expect(rows.map((r) => r.text)).toEqual(["second text"]);
    db.close();
  });

  it("FTS DELETE trigger removes location rows from memory_search", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    const ins = db.prepare("INSERT INTO locations (ts, name, x, y, z, notes) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Date.now(), "base", 0, 64, 0, "river hideout");
    const id = Number(ins.lastInsertRowid);
    db.prepare("DELETE FROM locations WHERE id = ?").run(id);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM memory_search WHERE kind = 'location' AND ref_id = ?").get(id),
    ).toEqual({ c: 0 });
    db.close();
  });

  it("FTS UPDATE trigger replaces the location row in memory_search (upsert flow)", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    const ins = db.prepare("INSERT INTO locations (ts, name, x, y, z, notes) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Date.now(), "base", 0, 64, 0, "first notes");
    const id = Number(ins.lastInsertRowid);
    db.prepare("UPDATE locations SET notes = ? WHERE id = ?").run("second notes", id);
    const rows = db
      .prepare("SELECT text FROM memory_search WHERE kind = 'location' AND ref_id = ?")
      .all(id) as { text: string }[];
    expect(rows.map((r) => r.text)).toEqual(["second notes"]);
    db.close();
  });
});
