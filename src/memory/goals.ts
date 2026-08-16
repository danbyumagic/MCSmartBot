import type { DB } from "./db.js";

export type GoalStatus = "open" | "done" | "cancelled";
export type GoalSource = "owner" | "agent";

export interface GoalInput {
  text: string;
  createdBy: GoalSource;
}

export interface GoalRow {
  id: number;
  ts: number;
  text: string;
  status: GoalStatus;
  created_by: GoalSource;
}

export function setGoal(db: DB, input: GoalInput): GoalRow {
  const ts = Date.now();
  return db.transaction((): GoalRow => {
    db.prepare("UPDATE goals SET status = 'done' WHERE status = 'open'").run();
    const res = db
      .prepare("INSERT INTO goals (ts, text, status, created_by) VALUES (?, ?, 'open', ?)")
      .run(ts, input.text, input.createdBy);
    return {
      id: Number(res.lastInsertRowid),
      ts,
      text: input.text,
      status: "open",
      created_by: input.createdBy,
    };
  })();
}

export function clearOpenGoal(db: DB): GoalRow | undefined {
  const open = getOpenGoal(db);
  if (!open) return undefined;
  db.prepare("UPDATE goals SET status = 'cancelled' WHERE id = ?").run(open.id);
  return { ...open, status: "cancelled" };
}

export function getOpenGoal(db: DB): GoalRow | undefined {
  return db
    .prepare("SELECT id, ts, text, status, created_by FROM goals WHERE status = 'open' ORDER BY ts DESC, id DESC LIMIT 1")
    .get() as GoalRow | undefined;
}

export function listGoals(db: DB): GoalRow[] {
  return db
    .prepare("SELECT id, ts, text, status, created_by FROM goals ORDER BY ts ASC, id ASC")
    .all() as GoalRow[];
}
