import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGetNotificationRulesTool,
  createGetRecentEventsTool,
  createSetNotificationRuleTool,
} from "../../src/agent/eventTools.js";
import { recordEvent } from "../../src/events/store.js";
import { openDatabase, type DB } from "../../src/memory/db.js";

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

describe("event tools", () => {
  it("configures rules and reads event history", async () => {
    const configured = await createSetNotificationRuleTool(db).handler({
      eventType: "player_join",
      minSeverity: "info",
      enabled: true,
    });
    expect(configured.summary).toContain("enabled player_join");
    const rules = await createGetNotificationRulesTool(db).handler({});
    expect(rules.summary).toContain('"eventType":"player_join"');
    recordEvent(db, {
      type: "player_join", severity: "info", summary: "bob joined",
    }, 100);
    const recent = await createGetRecentEventsTool(db).handler({
      eventType: "player_join",
      minSeverity: undefined,
      limit: 20,
    });
    expect(recent.summary).toContain('"summary":"bob joined"');
  });
});
