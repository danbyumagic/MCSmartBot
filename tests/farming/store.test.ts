import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import {
  getFarm,
  listDueFarms,
  setFarmStatus,
  upsertFarm,
} from "../../src/farming/store.js";

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

describe("farm store", () => {
  it("normalizes bounds and creates an immediately due farm", () => {
    const farm = upsertFarm(db, {
      name: "wheat",
      minX: 10, minY: 65, minZ: 8,
      maxX: 2, maxY: 64, maxZ: 1,
      crop: "wheat",
    }, 1_000);
    expect(farm).toMatchObject({
      minX: 2, minY: 64, minZ: 1,
      maxX: 10, maxY: 65, maxZ: 8,
      status: "active",
      nextCheckAt: 1_000,
    });
    expect(listDueFarms(db, 1_000)).toHaveLength(1);
  });

  it("updates a named farm instead of duplicating it", () => {
    const first = upsertFarm(db, {
      name: "food", minX: 0, minY: 64, minZ: 0,
      maxX: 1, maxY: 64, maxZ: 1, crop: "wheat",
    });
    const updated = upsertFarm(db, {
      name: "food", minX: 0, minY: 64, minZ: 0,
      maxX: 2, maxY: 64, maxZ: 2, crop: "carrots",
      seedReserve: 24,
    });
    expect(updated.id).toBe(first.id);
    expect(updated).toMatchObject({ crop: "carrots", maxX: 2, seedReserve: 24 });
  });

  it("supports pause resume and terminal cancellation", () => {
    const farm = upsertFarm(db, {
      name: "food", minX: 0, minY: 64, minZ: 0,
      maxX: 1, maxY: 64, maxZ: 1, crop: "wheat",
    }, 1_000);
    expect(setFarmStatus(db, farm.id, "paused", 2_000)).toBe(true);
    expect(getFarm(db, farm.id)?.status).toBe("paused");
    expect(setFarmStatus(db, farm.id, "active", 3_000)).toBe(true);
    expect(getFarm(db, farm.id)?.nextCheckAt).toBe(3_000);
    expect(setFarmStatus(db, farm.id, "cancelled", 4_000)).toBe(true);
    expect(setFarmStatus(db, farm.id, "active", 5_000)).toBe(false);
  });
});
