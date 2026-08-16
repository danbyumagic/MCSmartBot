import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptLegacyWorldMap,
  createMapTrailRecorder,
  getDashboardMap,
  makeServerKey,
  recordMapPosition,
  recordMapSurvey,
} from "../../src/exploration/mapStore.js";
import { recordWorldObservations } from "../../src/exploration/store.js";
import { openDatabase, type DB } from "../../src/memory/db.js";

let tmp: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-map-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("persistent overhead map", () => {
  it("normalizes server identity", () => {
    expect(makeServerKey("  Play.Example.COM ", 25565)).toBe("play.example.com:25565");
  });

  it("records cell transitions while deduplicating ticks within a cell", () => {
    const recorder = createMapTrailRecorder(db, "alpha:25565");
    expect(recorder.capture({ dimension: "overworld", x: 1, y: 64, z: 1 }, 100)).toBe(true);
    expect(recorder.capture({ dimension: "overworld", x: 7, y: 65, z: 7 }, 110)).toBe(false);
    expect(recorder.capture({ dimension: "overworld", x: 8, y: 66, z: 7 }, 120)).toBe(true);
    const map = getDashboardMap(db, "alpha:25565", "overworld");
    expect(map.cells).toHaveLength(2);
    expect(map.trail.map((point) => point.x)).toEqual([1, 8]);
  });

  it("persists surveys and discoveries separately per server", () => {
    recordMapPosition(db, {
      serverKey: "alpha:25565", dimension: "overworld", x: 4, y: 70, z: 4,
    }, 100);
    recordMapSurvey(db, {
      serverKey: "alpha:25565", dimension: "overworld", x: 10, y: 70, z: 10,
      radius: 16, label: "North Scan",
    }, 200);
    recordWorldObservations(db, [{
      dimension: "overworld", x: 12, y: 30, z: 10,
      kind: "resource", name: "diamond_ore",
    }], 250, "alpha:25565");
    recordMapPosition(db, {
      serverKey: "beta:25565", dimension: "the_nether", x: 1, y: 80, z: 1,
    }, 300);

    const alpha = getDashboardMap(db, "alpha:25565", "overworld");
    expect(alpha.surveys).toMatchObject([{ label: "north scan", radius: 16, scanCount: 1 }]);
    expect(alpha.observations).toMatchObject([{ kind: "resource", name: "diamond_ore" }]);
    expect(alpha.servers.map((entry) => entry.serverKey)).toEqual(["beta:25565", "alpha:25565"]);
    expect(getDashboardMap(db, "beta:25565").dimension).toBe("the_nether");
    expect(getDashboardMap(db, "beta:25565").surveys).toEqual([]);
  });

  it("adopts pre-upgrade observations and reconstructs survey coverage", () => {
    recordWorldObservations(db, [{
      dimension: "overworld", x: 20, y: 70, z: -8,
      kind: "landmark", name: "old_scan", details: { radius: 12 },
    }], 100);
    recordWorldObservations(db, [{
      dimension: "overworld", x: 21, y: 50, z: -8,
      kind: "resource", name: "iron_ore",
    }], 110);
    expect(adoptLegacyWorldMap(db, "alpha:25565")).toBe(2);
    expect(adoptLegacyWorldMap(db, "alpha:25565")).toBe(0);
    const map = getDashboardMap(db, "alpha:25565", "overworld");
    expect(map.observations).toHaveLength(2);
    expect(map.surveys).toMatchObject([{ x: 20, z: -8, radius: 12, label: "old_scan" }]);
    expect(map.servers.map((server) => server.serverKey)).not.toContain("legacy");
  });
});
