import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import {
  getAssignedRole,
  listPlayerRoles,
  removePlayerRole,
  resolvePlayerRole,
  setPlayerRole,
} from "../../src/permissions/roles.js";

let tmp: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("player roles", () => {
  it("persists updates and resolves the configured owner implicitly", () => {
    setPlayerRole(db, {
      username: "bob", role: "viewer", grantedBy: "alice",
    }, 100);
    setPlayerRole(db, {
      username: "bob", role: "operator", grantedBy: "alice",
    }, 200);
    expect(getAssignedRole(db, "BOB")).toMatchObject({
      username: "bob",
      role: "operator",
      tsUpdated: 200,
    });
    expect(resolvePlayerRole(db, "alice", "alice")).toBe("owner");
    expect(resolvePlayerRole(db, "ALICE", "alice")).toBe("owner");
    expect(resolvePlayerRole(db, "bob", "alice")).toBe("operator");
    expect(resolvePlayerRole(db, "mallory", "alice")).toBeUndefined();
    expect(listPlayerRoles(db)).toHaveLength(1);
    expect(removePlayerRole(db, "Bob")).toBe(true);
    expect(resolvePlayerRole(db, "bob", "alice")).toBeUndefined();
  });
});
