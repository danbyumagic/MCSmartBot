import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  queryWorldObservations,
  recordWorldObservations,
} from "../../src/exploration/store.js";
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

describe("world observation store", () => {
  it("upserts repeated sightings and preserves first seen time", () => {
    const observation = {
      dimension: "overworld",
      x: 10, y: 20, z: 30,
      kind: "resource" as const,
      name: "diamond_ore",
      details: { vein: 2 },
    };
    recordWorldObservations(db, [observation], 100);
    recordWorldObservations(db, [{ ...observation, details: { vein: 3 } }], 200);
    expect(queryWorldObservations(db, { name: "diamond" })).toMatchObject([{
      firstSeenAt: 100,
      lastSeenAt: 200,
      seenCount: 2,
      details: { vein: 3 },
    }]);
  });

  it("filters by kind and three-dimensional radius then sorts nearest first", () => {
    recordWorldObservations(db, [
      { dimension: "overworld", x: 3, y: 64, z: 0, kind: "hazard", name: "lava" },
      { dimension: "overworld", x: 20, y: 64, z: 0, kind: "hazard", name: "lava" },
      { dimension: "overworld", x: 1, y: 64, z: 0, kind: "resource", name: "iron_ore" },
    ], 100);
    const rows = queryWorldObservations(db, {
      dimension: "overworld",
      kind: "hazard",
      centerX: 0, centerY: 64, centerZ: 0,
      radius: 10,
    });
    expect(rows.map((row) => row.x)).toEqual([3]);
  });

  it("keeps observations isolated by server", () => {
    const observation = {
      dimension: "overworld", x: 4, y: 64, z: 8,
      kind: "landmark" as const, name: "spawn",
    };
    recordWorldObservations(db, [observation], 100, "alpha.example:25565");
    recordWorldObservations(db, [observation], 200, "beta.example:25565");
    expect(queryWorldObservations(db, { serverKey: "alpha.example:25565" }))
      .toMatchObject([{ serverKey: "alpha.example:25565", firstSeenAt: 100 }]);
    expect(queryWorldObservations(db, { serverKey: "beta.example:25565" }))
      .toMatchObject([{ serverKey: "beta.example:25565", firstSeenAt: 200 }]);
  });
});
