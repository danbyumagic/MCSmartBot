import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGetPlayerRolesTool,
  createSetPlayerRoleTool,
} from "../../src/agent/roleTools.js";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { resolvePlayerRole } from "../../src/permissions/roles.js";

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

describe("player role tools", () => {
  it("grants lists and removes access", async () => {
    const setTool = createSetPlayerRoleTool(db, "alice");
    expect(await setTool.handler({ username: "bob", role: "operator" }))
      .toMatchObject({ ok: true });
    expect(resolvePlayerRole(db, "bob", "alice")).toBe("operator");
    const listed = await createGetPlayerRolesTool(db, "alice").handler({});
    expect(listed.summary).toContain('"username":"bob"');
    await setTool.handler({ username: "BOB", role: "remove" });
    expect(resolvePlayerRole(db, "bob", "alice")).toBeUndefined();
  });

  it("will not alter the configured owner", async () => {
    const result = await createSetPlayerRoleTool(db, "Alice").handler({
      username: "alice",
      role: "viewer",
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});
