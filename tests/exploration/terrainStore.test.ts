import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDashboardMap } from "../../src/exploration/mapStore.js";
import { recordTerrainSamples } from "../../src/exploration/terrainStore.js";
import { openDatabase, type DB } from "../../src/memory/db.js";

let tmp: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-terrain-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("terrain sample store", () => {
  it("persists surface blocks by server and updates revisited coordinates", () => {
    recordTerrainSamples(db, "alpha:25565", "overworld", [
      { x: 0, y: 63, z: 0, blockName: "water" },
      { x: 2, y: 65, z: 0, blockName: "grass_block" },
    ], 100);
    recordTerrainSamples(db, "alpha:25565", "overworld", [
      { x: 2, y: 66, z: 0, blockName: "oak_planks" },
    ], 200);
    recordTerrainSamples(db, "beta:25565", "overworld", [
      { x: 0, y: 70, z: 0, blockName: "snow_block" },
    ], 300);

    const map = getDashboardMap(db, "alpha:25565", "overworld");
    expect(map.terrainSampleSize).toBe(2);
    expect(map.terrain).toEqual([
      { x: 0, y: 63, z: 0, blockName: "water", updatedAt: 100 },
      { x: 2, y: 66, z: 0, blockName: "oak_planks", updatedAt: 200 },
    ]);
  });
});
