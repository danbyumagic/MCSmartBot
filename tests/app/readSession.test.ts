import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { openProfileReadOnlySession } from "../../src/app/readSession.js";
import type { RuntimeProfile } from "../../src/app/profile.js";
import { saveMissionDefinition } from "../../src/missions/store.js";
import { systemActor } from "../../src/permissions/executionActor.js";

let directory: string;
let db: DB | undefined;

function profile(): RuntimeProfile {
  return {
    envPath: "/tmp/smartbot-read/.env",
    rootDir: "/tmp/smartbot-read",
    config: {
      serverHost: "localhost",
      serverPort: 25565,
      serverVersion: "1.21.11",
      botUsername: "SmartBot",
      botAuth: "offline",
      ownerUsername: "owner",
      agentProvider: "codex",
      dataDir: directory,
      logLevel: "error",
      chatMirrorEnabled: true,
      hpFleeThreshold: 6,
      foodEatThreshold: 14,
      agentIdleTickMinutes: 5,
      reconnectBaseDelayMs: 1000,
      reconnectMaxDelayMs: 60000,
      reconnectJitterRatio: 0.2,
      dashboardEnabled: false,
      dashboardHost: "127.0.0.1",
      dashboardPort: 8787,
    },
    serverConfig: { commands: [], notes: [] },
    serverConfigPath: "/tmp/smartbot-read/server.json",
  };
}

afterEach(() => {
  try { db?.close(); } catch { /* already closed in the test */ }
  rmSync(directory, { recursive: true, force: true });
});

describe("profile read-only session", () => {
  it("reads mission records without opening a writable runtime connection", () => {
    directory = mkdtempSync(join("/tmp", "smartbot-read-"));
    const writable = openDatabase(join(directory, "memory.sqlite"));
    db = writable;
    saveMissionDefinition(writable, {
      definition: {
        schema: "smartbot.mission/v1",
        name: "read-me",
        limits: { maxLogicalSteps: 1, maxExpandedSteps: 1, maxWorldChanges: 1, maxRuntimeMinutes: 1 },
        steps: [{ id: "clear", op: "clear", from: [0, 64, 0], to: [0, 64, 0] }],
      },
      creator: systemActor("owner", "desktop"),
    });
    writable.close();

    const readonly = openProfileReadOnlySession(profile());
    expect(readonly.listMissions()).toMatchObject([{ name: "read-me", creatorUsername: "owner" }]);
    expect(readonly.listWorldTransactions()).toEqual([]);
    readonly.close?.();
    db = undefined;
  });
});
