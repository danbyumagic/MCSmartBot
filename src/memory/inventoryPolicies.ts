import type { DB } from "./db.js";

export interface InventoryPolicyInput {
  name: string;
  alwaysCarry: Record<string, number>;
  preferredStorage?: string;
}

export interface InventoryPolicyRow extends InventoryPolicyInput {
  ts: number;
}

export function upsertInventoryPolicy(db: DB, input: InventoryPolicyInput): InventoryPolicyRow {
  const ts = Date.now();
  db.prepare(
    `INSERT INTO inventory_policies (name, ts, always_carry_json, preferred_storage)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       ts = excluded.ts,
       always_carry_json = excluded.always_carry_json,
       preferred_storage = excluded.preferred_storage`,
  ).run(
    input.name,
    ts,
    JSON.stringify(input.alwaysCarry),
    input.preferredStorage ?? null,
  );
  return getInventoryPolicy(db, input.name)!;
}

export function getInventoryPolicy(db: DB, name: string): InventoryPolicyRow | undefined {
  const row = db.prepare(
    `SELECT name, ts, always_carry_json, preferred_storage
     FROM inventory_policies WHERE name = ?`,
  ).get(name) as {
    name: string;
    ts: number;
    always_carry_json: string;
    preferred_storage: string | null;
  } | undefined;
  if (!row) return undefined;
  return {
    name: row.name,
    ts: row.ts,
    alwaysCarry: JSON.parse(row.always_carry_json) as Record<string, number>,
    preferredStorage: row.preferred_storage ?? undefined,
  };
}

export function listInventoryPolicies(db: DB): InventoryPolicyRow[] {
  const names = db.prepare("SELECT name FROM inventory_policies ORDER BY name ASC")
    .all() as Array<{ name: string }>;
  return names.map(({ name }) => getInventoryPolicy(db, name)!);
}
