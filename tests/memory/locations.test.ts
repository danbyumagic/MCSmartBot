import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { upsertLocation, getLocation, listLocations } from "../../src/memory/locations.js";

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

describe("locations", () => {
  it("upsert creates a row when name is new", () => {
    const row = upsertLocation(db, { name: "base", dimension: "overworld", x: 10, y: 64, z: -20, notes: "hideout" });
    expect(row.name).toBe("base");
    expect(getLocation(db, "base")?.x).toBe(10);
  });

  it("upsert overwrites existing coords and notes on the same name", () => {
    upsertLocation(db, { name: "base", dimension: "overworld", x: 0, y: 64, z: 0 });
    upsertLocation(db, { name: "base", dimension: "overworld", x: 100, y: 70, z: 200, notes: "moved" });
    const out = getLocation(db, "base");
    expect(out?.x).toBe(100);
    expect(out?.notes).toBe("moved");
  });

  it("listLocations returns rows in alphabetical order by name", () => {
    upsertLocation(db, { name: "zinc", x: 0, y: 64, z: 0 });
    upsertLocation(db, { name: "alpha", x: 0, y: 64, z: 0 });
    expect(listLocations(db).map((r) => r.name)).toEqual(["alpha", "zinc"]);
  });

  it("getLocation returns undefined for unknown name", () => {
    expect(getLocation(db, "nope")).toBeUndefined();
  });
});
