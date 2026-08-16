import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import {
  findContainersWithItem,
  getContainer,
  getContainerItems,
  replaceContainerSnapshot,
} from "../../src/memory/containers.js";

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

describe("container index", () => {
  it("stores container metadata and aggregates duplicate stacks", () => {
    replaceContainerSnapshot(db, {
      name: "main",
      dimension: "overworld",
      x: 1, y: 2, z: 3,
      blockType: "chest",
      items: [
        { item: "iron_ingot", itemType: 265, metadata: 0, count: 32 },
        { item: "iron_ingot", itemType: 265, metadata: 0, count: 12 },
      ],
    });
    expect(getContainer(db, "main")).toMatchObject({
      name: "main", x: 1, y: 2, z: 3, blockType: "chest",
    });
    expect(getContainerItems(db, "main")).toEqual([
      { item: "iron_ingot", itemType: 265, metadata: 0, count: 44 },
    ]);
  });

  it("replaces stale item contents on rescan", () => {
    const base = {
      name: "main", dimension: "overworld", x: 1, y: 2, z: 3, blockType: "barrel",
    };
    replaceContainerSnapshot(db, {
      ...base,
      items: [{ item: "coal", itemType: 263, metadata: 0, count: 8 }],
    });
    replaceContainerSnapshot(db, {
      ...base,
      items: [{ item: "iron_ingot", itemType: 265, metadata: 0, count: 4 }],
    });
    expect(getContainerItems(db, "main")).toEqual([
      { item: "iron_ingot", itemType: 265, metadata: 0, count: 4 },
    ]);
    expect(findContainersWithItem(db, "coal")).toEqual([]);
  });

  it("finds indexed stock across containers", () => {
    for (const [name, count] of [["a", 4], ["b", 10]] as const) {
      replaceContainerSnapshot(db, {
        name, dimension: "overworld", x: count, y: 2, z: 3, blockType: "chest",
        items: [{ item: "coal", itemType: 263, metadata: 0, count }],
      });
    }
    const found = findContainersWithItem(db, "coal")
      .map((r) => [r.name, r.count] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    expect(found).toEqual([["a", 4], ["b", 10]]);
  });
});
