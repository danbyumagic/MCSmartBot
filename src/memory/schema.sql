-- v1 schema for SmartBotMC memory. Forward-only migrations.
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS conversations (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  speaker  TEXT NOT NULL,
  text     TEXT NOT NULL,
  channel  TEXT NOT NULL DEFAULT 'chat'
);
CREATE INDEX IF NOT EXISTS idx_conv_ts ON conversations(ts);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);

-- ---------- Schema v2 additions ----------

CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  topic      TEXT NOT NULL,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_topic ON facts(topic);

CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  name       TEXT NOT NULL UNIQUE,
  dimension  TEXT NOT NULL DEFAULT 'overworld',
  x          INTEGER NOT NULL,
  y          INTEGER NOT NULL,
  z          INTEGER NOT NULL,
  notes      TEXT
);

CREATE TABLE IF NOT EXISTS goals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

CREATE TABLE IF NOT EXISTS skill_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_start    INTEGER NOT NULL,
  ts_end      INTEGER,
  skill       TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status      TEXT NOT NULL,
  summary     TEXT,
  data_json   TEXT,
  error_code  TEXT,
  recoverable INTEGER,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_ts ON skill_runs(ts_start);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  topic,
  text,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS trg_facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO memory_search(kind, ref_id, topic, text)
  VALUES ('fact', new.id, new.topic, new.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_facts_ad AFTER DELETE ON facts BEGIN
  DELETE FROM memory_search WHERE kind = 'fact' AND ref_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_facts_au AFTER UPDATE ON facts BEGIN
  DELETE FROM memory_search WHERE kind = 'fact' AND ref_id = old.id;
  INSERT INTO memory_search(kind, ref_id, topic, text)
  VALUES ('fact', new.id, new.topic, new.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_locations_ai AFTER INSERT ON locations BEGIN
  INSERT INTO memory_search(kind, ref_id, topic, text)
  VALUES ('location', new.id, new.name, COALESCE(new.notes, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_locations_ad AFTER DELETE ON locations BEGIN
  DELETE FROM memory_search WHERE kind = 'location' AND ref_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_locations_au AFTER UPDATE ON locations BEGIN
  DELETE FROM memory_search WHERE kind = 'location' AND ref_id = old.id;
  INSERT INTO memory_search(kind, ref_id, topic, text)
  VALUES ('location', new.id, new.name, COALESCE(new.notes, ''));
END;

INSERT OR IGNORE INTO schema_version (version) VALUES (2);

-- ---------- Schema v3 additions: persistent storage index ----------

CREATE TABLE IF NOT EXISTS containers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  ts_scanned    INTEGER NOT NULL,
  dimension     TEXT NOT NULL DEFAULT 'overworld',
  x             INTEGER NOT NULL,
  y             INTEGER NOT NULL,
  z             INTEGER NOT NULL,
  block_type    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS container_items (
  container_id  INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  item          TEXT NOT NULL,
  item_type     INTEGER NOT NULL,
  metadata      INTEGER NOT NULL DEFAULT 0,
  count         INTEGER NOT NULL,
  PRIMARY KEY (container_id, item, metadata)
);
CREATE INDEX IF NOT EXISTS idx_container_items_item ON container_items(item);

INSERT OR IGNORE INTO schema_version (version) VALUES (3);

-- ---------- Schema v4 additions: inventory policies ----------

CREATE TABLE IF NOT EXISTS inventory_policies (
  name                TEXT PRIMARY KEY,
  ts                  INTEGER NOT NULL,
  always_carry_json   TEXT NOT NULL,
  preferred_storage   TEXT
);

INSERT OR IGNORE INTO schema_version (version) VALUES (4);

-- ---------- Schema v5 additions: persistent task engine ----------

CREATE TABLE IF NOT EXISTS task_plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_created    INTEGER NOT NULL,
  ts_updated    INTEGER NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_plans_status ON task_plans(status, ts_created);

CREATE TABLE IF NOT EXISTS task_steps (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id          INTEGER NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  skill            TEXT NOT NULL,
  params_json      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  next_attempt_at  INTEGER,
  last_error_code  TEXT,
  last_error       TEXT,
  result_json      TEXT,
  UNIQUE(plan_id, position)
);
CREATE INDEX IF NOT EXISTS idx_task_steps_ready
  ON task_steps(status, next_attempt_at, plan_id, position);

INSERT OR IGNORE INTO schema_version (version) VALUES (5);

-- ---------- Schema v6 additions: standing container supply goals ----------

CREATE TABLE IF NOT EXISTS supply_goals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_created        INTEGER NOT NULL,
  ts_updated        INTEGER NOT NULL,
  container_name    TEXT NOT NULL,
  item              TEXT NOT NULL,
  target_quantity   INTEGER NOT NULL,
  search_radius     INTEGER NOT NULL DEFAULT 64,
  interval_minutes  INTEGER NOT NULL DEFAULT 15,
  status            TEXT NOT NULL DEFAULT 'active',
  next_check_at     INTEGER NOT NULL,
  last_plan_id      INTEGER REFERENCES task_plans(id),
  last_error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_supply_goals_due
  ON supply_goals(status, next_check_at);

INSERT OR IGNORE INTO schema_version (version) VALUES (6);

-- ---------- Schema v7 additions: registered crop farms ----------

CREATE TABLE IF NOT EXISTS farms (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_created        INTEGER NOT NULL,
  ts_updated        INTEGER NOT NULL,
  name              TEXT NOT NULL UNIQUE,
  dimension         TEXT NOT NULL DEFAULT 'overworld',
  min_x             INTEGER NOT NULL,
  min_y             INTEGER NOT NULL,
  min_z             INTEGER NOT NULL,
  max_x             INTEGER NOT NULL,
  max_y             INTEGER NOT NULL,
  max_z             INTEGER NOT NULL,
  crop              TEXT NOT NULL,
  storage_name      TEXT,
  seed_reserve      INTEGER NOT NULL DEFAULT 16,
  interval_minutes  INTEGER NOT NULL DEFAULT 15,
  status            TEXT NOT NULL DEFAULT 'active',
  next_check_at     INTEGER NOT NULL,
  last_plan_id      INTEGER REFERENCES task_plans(id),
  last_error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_farms_due ON farms(status, next_check_at);

INSERT OR IGNORE INTO schema_version (version) VALUES (7);

-- ---------- Schema v8 additions: persistent blueprints and construction jobs ----------

CREATE TABLE IF NOT EXISTS blueprints (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_created    INTEGER NOT NULL,
  ts_updated    INTEGER NOT NULL,
  name          TEXT NOT NULL UNIQUE,
  blocks_json   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS construction_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_created    INTEGER NOT NULL,
  ts_updated    INTEGER NOT NULL,
  blueprint_id  INTEGER NOT NULL REFERENCES blueprints(id),
  dimension     TEXT NOT NULL DEFAULT 'overworld',
  origin_x      INTEGER NOT NULL,
  origin_y      INTEGER NOT NULL,
  origin_z      INTEGER NOT NULL,
  rotation      INTEGER NOT NULL DEFAULT 0,
  storage_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  placed_count  INTEGER NOT NULL DEFAULT 0,
  total_count   INTEGER NOT NULL,
  last_plan_id  INTEGER REFERENCES task_plans(id),
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_construction_jobs_status
  ON construction_jobs(status, ts_created);

INSERT OR IGNORE INTO schema_version (version) VALUES (8);

-- ---------- Schema v9 additions: persistent world observations ----------

CREATE TABLE IF NOT EXISTS world_observations (
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
INSERT OR IGNORE INTO schema_version (version) VALUES (9);

-- ---------- Schema v10 additions: multiplayer roles ----------

CREATE TABLE IF NOT EXISTS player_roles (
  username    TEXT PRIMARY KEY COLLATE NOCASE,
  role        TEXT NOT NULL,
  ts_updated  INTEGER NOT NULL,
  granted_by  TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version (version) VALUES (10);

-- ---------- Schema v11 additions: event awareness and notification rules ----------

CREATE TABLE IF NOT EXISTS event_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  event_type    TEXT NOT NULL,
  severity      TEXT NOT NULL,
  summary       TEXT NOT NULL,
  details_json  TEXT NOT NULL DEFAULT '{}',
  notified      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_event_log_recent
  ON event_log(ts DESC, severity, event_type);

CREATE TABLE IF NOT EXISTS notification_rules (
  event_type    TEXT PRIMARY KEY,
  min_severity  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  ts_updated    INTEGER NOT NULL
);

INSERT OR IGNORE INTO notification_rules
  (event_type, min_severity, enabled, ts_updated)
VALUES ('*', 'warning', 1, 0);

INSERT OR IGNORE INTO schema_version (version) VALUES (11);

-- ---------- Schema v12 additions: rotated construction placement ----------

INSERT OR IGNORE INTO schema_version (version) VALUES (12);

-- ---------- Schema v13 additions: server-scoped overhead map ----------

CREATE TABLE IF NOT EXISTS map_trail_cells (
  server_key    TEXT NOT NULL,
  dimension     TEXT NOT NULL,
  cell_x        INTEGER NOT NULL,
  cell_z        INTEGER NOT NULL,
  min_y         REAL NOT NULL,
  max_y         REAL NOT NULL,
  visits        INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (server_key, dimension, cell_x, cell_z)
);
CREATE INDEX IF NOT EXISTS idx_map_trail_cells_server
  ON map_trail_cells(server_key, dimension, last_seen_at);

CREATE TABLE IF NOT EXISTS map_trail_points (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  server_key    TEXT NOT NULL,
  dimension     TEXT NOT NULL,
  x             REAL NOT NULL,
  y             REAL NOT NULL,
  z             REAL NOT NULL,
  ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_trail_points_server
  ON map_trail_points(server_key, dimension, id);

CREATE TABLE IF NOT EXISTS map_surveys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  server_key    TEXT NOT NULL,
  dimension     TEXT NOT NULL,
  center_x      REAL NOT NULL,
  center_y      REAL NOT NULL,
  center_z      REAL NOT NULL,
  radius        INTEGER NOT NULL,
  label         TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  scan_count    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(server_key, dimension, center_x, center_y, center_z, radius, label)
);
CREATE INDEX IF NOT EXISTS idx_map_surveys_server
  ON map_surveys(server_key, dimension, last_seen_at);

INSERT OR IGNORE INTO schema_version (version) VALUES (13);

-- ---------- Schema v14 additions: sampled top-surface terrain ----------

CREATE TABLE IF NOT EXISTS map_terrain_samples (
  server_key  TEXT NOT NULL,
  dimension   TEXT NOT NULL,
  x           INTEGER NOT NULL,
  z           INTEGER NOT NULL,
  y           INTEGER NOT NULL,
  block_name  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (server_key, dimension, x, z)
);
CREATE INDEX IF NOT EXISTS idx_map_terrain_server
  ON map_terrain_samples(server_key, dimension, x, z);

INSERT OR IGNORE INTO schema_version (version) VALUES (14);

-- ---------- Schema v15 additions: durable task-plan actors ----------

CREATE TABLE IF NOT EXISTS task_plan_actors (
  plan_id         INTEGER PRIMARY KEY REFERENCES task_plans(id) ON DELETE CASCADE,
  actor_username  TEXT NOT NULL,
  actor_role      TEXT NOT NULL,
  actor_source    TEXT NOT NULL,
  ts_authorized   INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (version) VALUES (15);

-- ---------- Schema v16 additions: verified world-change transactions ----------

CREATE TABLE IF NOT EXISTS world_transactions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_created             INTEGER NOT NULL,
  ts_updated             INTEGER NOT NULL,
  server_key             TEXT NOT NULL,
  dimension              TEXT NOT NULL,
  label                  TEXT,
  kind                   TEXT NOT NULL,
  actor_username         TEXT NOT NULL,
  actor_role             TEXT NOT NULL,
  actor_source           TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN (
                           'open', 'completed', 'partial', 'failed', 'cancelled',
                           'undoing', 'undone', 'undo_partial'
                         )),
  task_plan_id           INTEGER REFERENCES task_plans(id) ON DELETE SET NULL,
  construction_job_id    INTEGER REFERENCES construction_jobs(id) ON DELETE SET NULL,
  budget_scope           TEXT NOT NULL,
  correlation_json       TEXT NOT NULL DEFAULT '{}',
  requested_change_count INTEGER NOT NULL DEFAULT 0 CHECK (requested_change_count >= 0),
  applied_change_count   INTEGER NOT NULL DEFAULT 0 CHECK (applied_change_count >= 0),
  last_error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_world_transactions_recent
  ON world_transactions(server_key, dimension, ts_created DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_world_transactions_status
  ON world_transactions(server_key, dimension, status, ts_updated DESC);
CREATE INDEX IF NOT EXISTS idx_world_transactions_budget_scope
  ON world_transactions(server_key, budget_scope, status, id);

CREATE TABLE IF NOT EXISTS world_changes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id       INTEGER NOT NULL REFERENCES world_transactions(id) ON DELETE CASCADE,
  ordinal              INTEGER NOT NULL,
  x                    INTEGER NOT NULL,
  y                    INTEGER NOT NULL,
  z                    INTEGER NOT NULL,
  action               TEXT NOT NULL CHECK (action IN ('place', 'dig', 'replace')),
  before_json          TEXT NOT NULL,
  intended_json        TEXT NOT NULL,
  confirmed_after_json TEXT,
  status               TEXT NOT NULL DEFAULT 'planned'
                       CHECK (status IN (
                         'planned', 'applied', 'failed', 'conflict', 'reverting', 'reverted'
                       )),
  last_error           TEXT,
  ts_planned           INTEGER NOT NULL,
  ts_updated           INTEGER NOT NULL,
  UNIQUE(transaction_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_world_changes_transaction_status
  ON world_changes(transaction_id, status, ordinal);
CREATE INDEX IF NOT EXISTS idx_world_changes_coordinate
  ON world_changes(x, y, z, transaction_id, status);

INSERT OR IGNORE INTO schema_version (version) VALUES (16);

-- ---------- Schema v17 additions: auditable BuildOps source envelopes ----------

CREATE TABLE IF NOT EXISTS blueprint_sources (
  blueprint_id         INTEGER PRIMARY KEY REFERENCES blueprints(id) ON DELETE CASCADE,
  ts_created           INTEGER NOT NULL,
  ts_updated           INTEGER NOT NULL,
  source_schema        TEXT NOT NULL,
  target_version       TEXT NOT NULL,
  source_json          TEXT NOT NULL,
  source_hash          TEXT NOT NULL,
  compile_report_json  TEXT NOT NULL,
  creator_username     TEXT NOT NULL,
  creator_source       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blueprint_sources_hash
  ON blueprint_sources(source_hash);

INSERT OR IGNORE INTO schema_version (version) VALUES (17);

-- ---------- Schema v18 additions: durable MissionScript definitions and runs ----------

CREATE TABLE IF NOT EXISTS mission_definitions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_created       INTEGER NOT NULL,
  ts_updated       INTEGER NOT NULL,
  name             TEXT NOT NULL COLLATE NOCASE UNIQUE,
  schema           TEXT NOT NULL,
  source_json      TEXT NOT NULL,
  source_hash      TEXT NOT NULL,
  creator_username TEXT NOT NULL,
  creator_source   TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_mission_definitions_name
  ON mission_definitions(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS mission_runs (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_created                   INTEGER NOT NULL,
  ts_updated                   INTEGER NOT NULL,
  definition_id                INTEGER REFERENCES mission_definitions(id) ON DELETE SET NULL,
  source_schema                TEXT NOT NULL,
  source_json                  TEXT NOT NULL,
  source_hash                  TEXT NOT NULL,
  actor_username               TEXT NOT NULL,
  actor_role                   TEXT NOT NULL,
  actor_source                 TEXT NOT NULL,
  limits_json                  TEXT NOT NULL,
  compile_report_json          TEXT NOT NULL,
  task_plan_id                 INTEGER REFERENCES task_plans(id) ON DELETE SET NULL,
  transaction_scope            TEXT NOT NULL,
  transaction_correlation_json TEXT NOT NULL DEFAULT '{}',
  deadline_at                  INTEGER NOT NULL,
  status                       TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN (
                                 'pending', 'running', 'paused', 'completed', 'failed', 'cancelled'
                               )),
  ts_started                   INTEGER,
  ts_finished                  INTEGER,
  last_error                   TEXT
);
CREATE INDEX IF NOT EXISTS idx_mission_runs_recent
  ON mission_runs(ts_created DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mission_runs_status
  ON mission_runs(status, ts_updated DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_runs_task_plan
  ON mission_runs(task_plan_id) WHERE task_plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mission_runs_definition
  ON mission_runs(definition_id, ts_created DESC, id DESC);

CREATE TABLE IF NOT EXISTS mission_step_links (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_run_id          INTEGER NOT NULL REFERENCES mission_runs(id) ON DELETE CASCADE,
  logical_step_id         TEXT NOT NULL,
  logical_position        INTEGER NOT NULL CHECK (logical_position >= 0),
  expanded_start_position INTEGER NOT NULL CHECK (expanded_start_position >= 0),
  expanded_step_count     INTEGER NOT NULL CHECK (expanded_step_count > 0),
  construction_job_id     INTEGER REFERENCES construction_jobs(id) ON DELETE SET NULL,
  compile_metadata_json   TEXT NOT NULL DEFAULT '{}',
  UNIQUE(mission_run_id, logical_step_id),
  UNIQUE(mission_run_id, logical_position)
);
CREATE INDEX IF NOT EXISTS idx_mission_step_links_construction_job
  ON mission_step_links(construction_job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_step_links_construction_job_unique
  ON mission_step_links(construction_job_id) WHERE construction_job_id IS NOT NULL;

INSERT OR IGNORE INTO schema_version (version) VALUES (18);
