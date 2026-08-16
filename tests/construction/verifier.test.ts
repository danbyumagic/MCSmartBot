import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import { verifyBlueprintWorld } from "../../src/construction/verifier.js";

type FakeBlock = string | null | {
  name: string;
  properties?: Record<string, string | number | boolean>;
};

function makeBot(blocks: Map<string, FakeBlock>) {
  return {
    blockAt: (position: Vec3) => {
      const value = blocks.has(key(position)) ? blocks.get(key(position)) : "air";
      if (value === null) return null;
      const block = typeof value === "string"
        ? { name: value, properties: undefined }
        : value ?? { name: "air", properties: undefined };
      return {
        name: block.name,
        position,
        boundingBox: block.name === "air" ? "empty" : "block",
        getProperties: () => block.properties ?? {},
      };
    },
  } as any;
}

function key(position: { x: number; y: number; z: number }): string {
  return `${position.x},${position.y},${position.z}`;
}

const origin = { originX: 10, originY: 65, originZ: 20 };

describe("construction verifier", () => {
  it("compares every expected cell in stable order and reports a complete match", async () => {
    const report = await verifyBlueprintWorld(makeBot(new Map([
      ["10,65,20", "stone"],
      ["11,65,20", "dirt"],
    ])), [
      { x: 0, y: 0, z: 0, block: "stone" },
      { x: 1, y: 0, z: 0, block: "dirt" },
    ], origin, 0);

    expect(report).toMatchObject({
      complete: true,
      interrupted: false,
      matches: true,
      placementUnitCount: 2,
      expectedWorldCellCount: 2,
      checkedPlacementUnits: 2,
      checkedWorldCells: 2,
      correctPlacementUnits: 2,
      correct: 2,
      repaired: 0,
      issueCounts: { missing: 0, conflicting: 0, unloaded: 0, stateMismatched: 0 },
      issues: [],
    });
  });

  it("classifies missing, conflicting, and unloaded expected cells with exact totals", async () => {
    const report = await verifyBlueprintWorld(makeBot(new Map([
      ["10,65,20", "air"],
      ["11,65,20", "chest"],
      ["12,65,20", null],
      ["13,65,20", "short_grass"],
    ])), [
      { x: 0, y: 0, z: 0, block: "stone" },
      { x: 1, y: 0, z: 0, block: "stone" },
      { x: 2, y: 0, z: 0, block: "stone" },
      { x: 3, y: 0, z: 0, block: "stone" },
    ], origin, 0, { maxIssueSamples: 2 });

    expect(report).toMatchObject({
      complete: true,
      matches: false,
      correct: 0,
      missing: 2,
      conflicting: 1,
      unloaded: 1,
      stateMismatched: 0,
      issueCounts: { missing: 2, conflicting: 1, unloaded: 1, stateMismatched: 0 },
    });
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "missing", position: { x: 10, y: 65, z: 20 }, found: "air" }),
      expect.objectContaining({ kind: "conflicting", position: { x: 11, y: 65, z: 20 }, found: "chest" }),
    ]);
  });

  it("counts a multi-cell placement unit once while verifying every expected cell", async () => {
    const report = await verifyBlueprintWorld(makeBot(new Map([
      ["10,65,20", "oak_door"],
      ["10,66,20", "oak_door"],
    ])), [{
      anchor: { x: 0, y: 0, z: 0, block: "oak_door" },
      item: "oak_door",
      expectedCells: [
        { x: 0, y: 0, z: 0, block: "oak_door" },
        { x: 0, y: 1, z: 0, block: "oak_door" },
      ],
    }], origin, 0);

    expect(report).toMatchObject({
      complete: true,
      matches: true,
      placementUnitCount: 1,
      expectedWorldCellCount: 2,
      correctPlacementUnits: 1,
      correct: 2,
      stateMismatched: 0,
    });
  });

  it("rotates a hinted stair facing with the build rotation before verifying its state", async () => {
    const unit = {
      anchor: { x: 0, y: 0, z: 0, block: "oak_stairs" },
      item: "oak_stairs",
      expectedCells: [{ x: 0, y: 0, z: 0, block: "oak_stairs" }],
      hint: { facing: "north" as const, half: "top" as const },
    };

    for (const [rotation, facing] of [
      [0, "north"],
      [90, "east"],
      [180, "south"],
      [270, "west"],
    ] as const) {
      const report = await verifyBlueprintWorld(makeBot(new Map([
        ["10,65,20", { name: "oak_stairs", properties: { facing, half: "top" } }],
      ])), [unit], origin, rotation);

      expect(report).toMatchObject({
        complete: true,
        matches: true,
        correct: 1,
        stateMismatched: 0,
        issueCounts: { missing: 0, conflicting: 0, unloaded: 0, stateMismatched: 0 },
      });
    }
  });

  it("classifies same-name wrong hinted facing or half as a state mismatch", async () => {
    const report = await verifyBlueprintWorld(makeBot(new Map([
      ["10,65,20", { name: "oak_stairs", properties: { facing: "south", half: "top" } }],
      ["11,65,20", { name: "oak_stairs", properties: { facing: "east", half: "top" } }],
    ])), [
      {
        anchor: { x: 0, y: 0, z: 0, block: "oak_stairs" },
        item: "oak_stairs",
        expectedCells: [{ x: 0, y: 0, z: 0, block: "oak_stairs" }],
        hint: { facing: "north", half: "top" },
      },
      {
        anchor: { x: 1, y: 0, z: 0, block: "oak_stairs" },
        item: "oak_stairs",
        expectedCells: [{ x: 1, y: 0, z: 0, block: "oak_stairs" }],
        hint: { facing: "east", half: "bottom" },
      },
    ], origin, 0, { maxIssueSamples: 1 });

    expect(report).toMatchObject({
      complete: true,
      matches: false,
      correct: 0,
      correctPlacementUnits: 0,
      mismatchedPlacementUnits: 2,
      stateMismatched: 2,
      issueCounts: { missing: 0, conflicting: 0, unloaded: 0, stateMismatched: 2 },
    });
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "state-mismatched", found: "oak_stairs" }),
    ]);
  });

  it("preserves name-only verification when a stair has no placement hint", async () => {
    const report = await verifyBlueprintWorld(makeBot(new Map([
      ["10,65,20", "oak_stairs"],
    ])), [{
      anchor: { x: 0, y: 0, z: 0, block: "oak_stairs" },
      item: "oak_stairs",
      expectedCells: [{ x: 0, y: 0, z: 0, block: "oak_stairs" }],
    }], origin, 90);

    expect(report).toMatchObject({
      complete: true,
      matches: true,
      correct: 1,
      stateMismatched: 0,
    });
  });

  it("yields in bounded batches for a 4,096-cell compiled plan", async () => {
    const cells = Array.from({ length: 4_096 }, (_, x) => ({ x, y: 0, z: 0, block: "stone" }));
    let yields = 0;
    const report = await verifyBlueprintWorld({
      blockAt: (position: Vec3) => ({ name: "stone", position, boundingBox: "block" }),
    } as any, cells, origin, 0, {
      batchSize: 128,
      yield: async () => { yields++; },
    });

    expect(report).toMatchObject({
      complete: true,
      matches: true,
      checkedWorldCells: 4_096,
      correct: 4_096,
      placementUnitCount: 4_096,
    });
    expect(yields).toBe(32);
  });

  it("stops at a batch boundary when cancelled and clearly marks the prefix report", async () => {
    const cells = Array.from({ length: 300 }, (_, x) => ({ x, y: 0, z: 0, block: "stone" }));
    const controller = new AbortController();
    const report = await verifyBlueprintWorld({
      blockAt: (position: Vec3) => ({ name: "stone", position, boundingBox: "block" }),
    } as any, cells, origin, 0, {
      signal: controller.signal,
      batchSize: 64,
      yield: async () => { controller.abort(); },
    });

    expect(report).toMatchObject({
      complete: false,
      interrupted: true,
      matches: false,
      checkedWorldCells: 64,
      correct: 64,
      expectedWorldCellCount: 300,
    });
  });
});
