import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import {
  getInventoryPolicy,
  listInventoryPolicies,
  upsertInventoryPolicy,
} from "../../src/memory/inventoryPolicies.js";

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

describe("inventory policies", () => {
  it("stores and reads a policy", () => {
    upsertInventoryPolicy(db, {
      name: "default",
      alwaysCarry: { cooked_beef: 16, torch: 32 },
      preferredStorage: "main",
    });
    expect(getInventoryPolicy(db, "default")).toMatchObject({
      name: "default",
      alwaysCarry: { cooked_beef: 16, torch: 32 },
      preferredStorage: "main",
    });
  });

  it("replaces a policy atomically by name", () => {
    upsertInventoryPolicy(db, { name: "mining", alwaysCarry: { torch: 16 } });
    upsertInventoryPolicy(db, { name: "mining", alwaysCarry: { torch: 64, bread: 8 } });
    expect(getInventoryPolicy(db, "mining")?.alwaysCarry).toEqual({ torch: 64, bread: 8 });
    expect(listInventoryPolicies(db)).toHaveLength(1);
  });
});
