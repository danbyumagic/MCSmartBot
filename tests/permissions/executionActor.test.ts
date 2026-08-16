import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { setPlayerRole } from "../../src/permissions/roles.js";
import {
  parsePersistedExecutionActor,
  resolveCurrentExecutionRole,
  snapshotExecutionActor,
  snapshotSkillExecutionContext,
  systemActor,
} from "../../src/permissions/executionActor.js";

let tempDir: string | undefined;
let db: DB | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function database(): DB {
  tempDir = mkdtempSync(join(tmpdir(), "smartbotmc-execution-actor-"));
  db = openDatabase(join(tempDir, "memory.sqlite"));
  return db;
}

describe("execution actors", () => {
  it("makes immutable actor and execution-context snapshots", () => {
    const mutable = {
      username: "Builder",
      role: "operator" as const,
      source: "minecraft-chat" as const,
    };
    const actor = snapshotExecutionActor(mutable);
    mutable.username = "Changed";
    const context = snapshotSkillExecutionContext({
      actor,
      planId: 7,
      maxWorldChanges: 50,
      transactionScope: "mission:7",
      transactionCorrelation: { mission: { id: 7 } },
    });

    expect(actor).toMatchObject({ username: "Builder", role: "operator" });
    expect(Object.isFrozen(actor)).toBe(true);
    expect(context).toMatchObject({
      planId: 7,
      maxWorldChanges: 50,
      transactionScope: "mission:7",
      transactionCorrelation: { mission: { id: 7 } },
      actor,
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.transactionCorrelation)).toBe(true);
    expect(Object.isFrozen((context.transactionCorrelation as { mission: object }).mission)).toBe(true);
  });

  it("rejects mutable non-JSON transaction correlation before a skill can await", () => {
    expect(() => snapshotSkillExecutionContext({
      actor: { username: "Builder", role: "operator", source: "desktop" },
      transactionCorrelation: { invalid: /regexp/ },
    })).toThrow(/transactionCorrelation/i);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => snapshotSkillExecutionContext({
      actor: { username: "Builder", role: "operator", source: "desktop" },
      transactionCorrelation: cyclic,
    })).toThrow(/cyclic/i);
  });

  it("strictly parses persisted values and creates named system actors", () => {
    expect(parsePersistedExecutionActor({
      username: "Owner",
      role: "owner",
      source: "scheduler",
    })).toMatchObject({ username: "Owner", role: "owner", source: "scheduler" });
    expect(() => parsePersistedExecutionActor({
      username: "Owner",
      role: "admin",
      source: "scheduler",
    })).toThrow(/invalid/i);
    expect(systemActor("Owner", "recovery")).toMatchObject({
      username: "Owner", role: "owner", source: "recovery",
    });
  });

  it("reauthorizes player actors and resolves the configured owner case-insensitively", () => {
    const activeDb = database();
    setPlayerRole(activeDb, { username: "Builder", role: "operator", grantedBy: "Owner" });
    const builder = snapshotExecutionActor({
      username: "builder",
      role: "operator",
      source: "minecraft-chat",
    });
    expect(resolveCurrentExecutionRole(activeDb, builder, "OWNER")).toBe("operator");
    activeDb.prepare("DELETE FROM player_roles WHERE username = ?").run("Builder");
    expect(resolveCurrentExecutionRole(activeDb, builder, "OWNER")).toBeUndefined();

    const owner = snapshotExecutionActor({
      username: "owner",
      role: "owner",
      source: "desktop",
    });
    expect(resolveCurrentExecutionRole(activeDb, owner, "OWNER")).toBe("owner");
  });
});
