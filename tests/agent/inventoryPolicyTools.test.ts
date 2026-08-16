import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import {
  createGetInventoryPolicyTool,
  createSetInventoryPolicyTool,
} from "../../src/agent/inventoryPolicyTools.js";

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

describe("inventory policy tools", () => {
  it("sets and reads a policy", async () => {
    const set = createSetInventoryPolicyTool(db);
    const get = createGetInventoryPolicyTool(db);
    const saved = await set.handler({
      name: "default",
      alwaysCarry: { torch: 32 },
      preferredStorage: "main",
    });
    expect(saved.ok).toBe(true);
    const read = await get.handler({ name: "default" });
    expect(read.summary).toContain('"torch":32');
    expect(read.summary).toContain('"preferredStorage":"main"');
  });

  it("validates policy quantities", () => {
    const set = createSetInventoryPolicyTool(db);
    expect(() => set.inputSchema.parse({
      name: "bad",
      alwaysCarry: { torch: -1 },
    })).toThrow();
  });
});
