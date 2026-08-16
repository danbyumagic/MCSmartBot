import { describe, expect, it } from "vitest";
import {
  isAirSnapshot,
  sameBlockSnapshot,
  snapshotBlock,
} from "../../src/world/blockSnapshot.js";

describe("block snapshots", () => {
  it("captures an immutable, normalized plain-data view of a live block", () => {
    const properties = {
      facing: "north",
      powered: false,
      age: 3,
      ignoredArray: ["not", "a", "primitive"],
    };
    const liveBlock = {
      name: "oak_door",
      stateId: 12_345,
      position: { x: 10.9, y: 64.1, z: -2.01 },
      boundingBox: "block",
      diggable: true,
      getProperties: () => properties,
    };

    const snapshot = snapshotBlock(liveBlock);

    expect(snapshot).toEqual({
      position: { x: 10, y: 64, z: -3 },
      name: "oak_door",
      stateId: 12_345,
      properties: { age: 3, facing: "north", powered: false },
      boundingBox: "block",
      replaceable: false,
      diggable: true,
      key: "10,64,-3|oak_door|state:12345|box:block|replaceable:false|diggable:true|age=n:3&facing=s:north&powered=b:false",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.position)).toBe(true);
    expect(Object.isFrozen(snapshot.properties)).toBe(true);

    properties.facing = "south";
    liveBlock.name = "spruce_door";
    expect(snapshot.name).toBe("oak_door");
    expect(snapshot.properties.facing).toBe("north");
  });

  it("uses a stable key independent of property insertion order", () => {
    const first = snapshotBlock({
      name: "lever",
      stateId: undefined,
      position: { x: 1, y: 2, z: 3 },
      boundingBox: "block",
      diggable: true,
      getProperties: () => ({ powered: true, face: "wall" }),
    });
    const second = snapshotBlock({
      name: "lever",
      position: { x: 1, y: 2, z: 3 },
      boundingBox: "block",
      diggable: true,
      getProperties: () => ({ face: "wall", powered: true }),
    });

    expect(first.key).toBe(second.key);
    expect(sameBlockSnapshot(first, second)).toBe(true);
    expect(sameBlockSnapshot(first, { ...second, name: "stone" })).toBe(false);
  });

  it("marks only the explicit harmless replacement set as replaceable", () => {
    const air = snapshotBlock({
      name: "cave_air",
      position: { x: 0, y: 0, z: 0 },
      boundingBox: "empty",
      diggable: false,
    });
    const grass = snapshotBlock({
      name: "short_grass",
      position: { x: 1, y: 0, z: 0 },
      boundingBox: "empty",
      diggable: true,
    });
    const water = snapshotBlock({
      name: "water",
      position: { x: 2, y: 0, z: 0 },
      boundingBox: "empty",
      diggable: false,
    });

    expect(air.replaceable).toBe(true);
    expect(grass.replaceable).toBe(true);
    expect(water.replaceable).toBe(false);
    expect(isAirSnapshot(air)).toBe(true);
    expect(isAirSnapshot(grass)).toBe(false);
  });

  it("omits unavailable state information and contains hostile property values", () => {
    const snapshot = snapshotBlock({
      name: "stone",
      stateId: Number.NaN,
      position: { x: 0, y: 1, z: 2 },
      boundingBox: "mystery",
      diggable: false,
      getProperties: () => ({
        valid: "yes",
        invalidNumber: Number.POSITIVE_INFINITY,
        object: { nested: true },
      }),
    });

    expect(snapshot).toMatchObject({
      name: "stone",
      stateId: undefined,
      properties: { valid: "yes" },
      boundingBox: "unknown",
      diggable: false,
    });
  });
});
