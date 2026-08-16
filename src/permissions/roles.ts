import type { DB } from "../memory/db.js";
import { sameMinecraftUsername } from "../bot/playerIdentity.js";
import type { ExecutionSource } from "./executionActor.js";

export const ASSIGNABLE_ROLES = ["operator", "viewer"] as const;
export type AssignableRole = typeof ASSIGNABLE_ROLES[number];
export type PlayerRole = "owner" | AssignableRole;

export interface PlayerRoleRow {
  username: string;
  role: AssignableRole;
  tsUpdated: number;
  grantedBy: string;
}

export interface ActorContext {
  username: string;
  role: PlayerRole;
  /** Mutable request source; snapshot before any asynchronous skill work. */
  source: ExecutionSource;
}

export function setPlayerRole(
  db: DB,
  input: {
    username: string;
    role: AssignableRole;
    grantedBy: string;
  },
  now = Date.now(),
): PlayerRoleRow {
  db.prepare(
    `INSERT INTO player_roles (username, role, ts_updated, granted_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       role = excluded.role,
       ts_updated = excluded.ts_updated,
       granted_by = excluded.granted_by`,
  ).run(input.username, input.role, now, input.grantedBy);
  const row = getAssignedRole(db, input.username);
  if (!row) throw new Error(`role for '${input.username}' missing after upsert`);
  return row;
}

export function removePlayerRole(db: DB, username: string): boolean {
  return db.prepare("DELETE FROM player_roles WHERE username = ?").run(username).changes > 0;
}

export function getAssignedRole(db: DB, username: string): PlayerRoleRow | undefined {
  const row = db.prepare(
    `SELECT username, role, ts_updated, granted_by
     FROM player_roles WHERE username = ?`,
  ).get(username) as {
    username: string;
    role: AssignableRole;
    ts_updated: number;
    granted_by: string;
  } | undefined;
  return row ? {
    username: row.username,
    role: row.role,
    tsUpdated: row.ts_updated,
    grantedBy: row.granted_by,
  } : undefined;
}

export function listPlayerRoles(db: DB): PlayerRoleRow[] {
  return (db.prepare(
    `SELECT username, role, ts_updated, granted_by
     FROM player_roles ORDER BY username COLLATE NOCASE`,
  ).all() as Array<{
    username: string;
    role: AssignableRole;
    ts_updated: number;
    granted_by: string;
  }>).map((row) => ({
    username: row.username,
    role: row.role,
    tsUpdated: row.ts_updated,
    grantedBy: row.granted_by,
  }));
}

export function resolvePlayerRole(
  db: DB,
  username: string,
  ownerUsername: string,
): PlayerRole | undefined {
  if (sameMinecraftUsername(username, ownerUsername)) return "owner";
  return getAssignedRole(db, username)?.role;
}
