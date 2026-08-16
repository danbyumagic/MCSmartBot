import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import {
  analyzeBuildSite,
  blueprintWorldPosition,
  findNearbyBuildSites,
  rotateBlueprintOffset,
} from "../../src/construction/site.js";

function makeBot(
  blocks: Map<string, string>,
  properties = new Map<string, Readonly<Record<string, unknown>>>(),
) {
  return {
    blockAt: (position: Vec3) => {
      const key = `${position.x},${position.y},${position.z}`;
      const name = blocks.get(key) ??
        (position.y === 64 ? "stone" : "air");
      return {
        name,
        position,
        boundingBox: name === "air" ? "empty" : "block",
        getProperties: () => properties.get(key) ?? {},
      };
    },
  } as any;
}

describe("construction site analysis", () => {
  it("rotates blueprint offsets around the origin", () => {
    expect(rotateBlueprintOffset(2, 1, 0)).toEqual({ x: 2, z: 1 });
    expect(rotateBlueprintOffset(2, 1, 90)).toEqual({ x: -1, z: 2 });
    expect(rotateBlueprintOffset(2, 1, 180)).toEqual({ x: -2, z: -1 });
    expect(rotateBlueprintOffset(2, 1, 270)).toEqual({ x: 1, z: -2 });
    expect(blueprintWorldPosition(
      { x: 2, y: 1, z: 1, block: "stone" },
      { originX: 10, originY: 65, originZ: 20 },
      90,
    )).toEqual(new Vec3(9, 66, 22));
  });

  it("accepts replaceable vegetation over solid ground", () => {
    const bot = makeBot(new Map([["1,65,0", "short_grass"]]));
    const analysis = analyzeBuildSite(bot, [
      { x: 0, y: 0, z: 0, block: "oak_planks" },
      { x: 1, y: 0, z: 0, block: "oak_planks" },
    ], { originX: 0, originY: 65, originZ: 0 }, 0);

    expect(analysis).toMatchObject({
      safe: true,
      correct: 0,
      pending: 2,
      placementUnitCount: 2,
      worldCellCount: 2,
      correctPlacementUnits: 0,
      pendingPlacementUnits: 2,
      correctWorldCells: 0,
      pendingWorldCells: 2,
      issueCounts: { blocked: 0, unloaded: 0, unsupported: 0 },
      issues: [],
    });
  });

  it("reports occupied and unsupported build positions", () => {
    const bot = makeBot(new Map([
      ["0,65,0", "chest"],
      ["1,64,0", "air"],
    ]));
    const analysis = analyzeBuildSite(bot, [
      { x: 0, y: 0, z: 0, block: "oak_planks" },
      { x: 1, y: 0, z: 0, block: "oak_planks" },
    ], { originX: 0, originY: 65, originZ: 0 }, 0);

    expect(analysis.safe).toBe(false);
    expect(analysis.issues).toEqual([
      expect.objectContaining({ kind: "blocked", found: "chest" }),
      expect.objectContaining({ kind: "unsupported", found: "air" }),
    ]);
    expect(analysis.issueCounts).toEqual({ blocked: 1, unloaded: 0, unsupported: 1 });
  });

  it("keeps exact issue totals while bounding deterministic preview samples", () => {
    const blocks = Array.from({ length: 100 }, (_, x) => ({
      x,
      y: 0,
      z: 0,
      block: "oak_planks",
    }));
    const world = new Map(blocks.map((entry) => [`${entry.x},65,0`, "chest"]));

    const analysis = analyzeBuildSite(
      makeBot(world),
      blocks,
      { originX: 0, originY: 65, originZ: 0 },
      0,
      { maxIssueSamples: 2 },
    );

    expect(analysis.safe).toBe(false);
    expect(analysis.issueCounts).toEqual({ blocked: 100, unloaded: 0, unsupported: 0 });
    expect(analysis.issues).toEqual([
      expect.objectContaining({ kind: "blocked", position: { x: 0, y: 65, z: 0 } }),
      expect.objectContaining({ kind: "blocked", position: { x: 1, y: 65, z: 0 } }),
    ]);
  });

  it("counts multi-cell placement units as one material use and two world cells", () => {
    const units = [{
      anchor: { x: 0, y: 0, z: 0, block: "oak_door" },
      item: "oak_door",
      expectedCells: [
        { x: 0, y: 0, z: 0, block: "oak_door" },
        { x: 0, y: 1, z: 0, block: "oak_door" },
      ],
      hint: { facing: "north" as const },
    }];
    const analysis = analyzeBuildSite(
      makeBot(
        new Map([["0,65,0", "oak_door"], ["0,66,0", "oak_door"]]),
        new Map([["0,65,0", { facing: "north" }]]),
      ),
      units,
      { originX: 0, originY: 65, originZ: 0 },
      0,
    );

    expect(analysis).toMatchObject({
      safe: true,
      placementUnitCount: 1,
      worldCellCount: 2,
      correctPlacementUnits: 1,
      correctWorldCells: 2,
      pendingPlacementUnits: 0,
      pendingWorldCells: 0,
    });
  });

  it("treats a same-name stair with the wrong hinted facing or half as blocked", () => {
    const units = [{
      anchor: { x: 0, y: 0, z: 0, block: "oak_stairs" },
      item: "oak_stairs",
      expectedCells: [{ x: 0, y: 0, z: 0, block: "oak_stairs" }],
      hint: { facing: "north" as const, half: "bottom" as const },
    }];
    const analysis = analyzeBuildSite(
      makeBot(
        new Map([["0,65,0", "oak_stairs"]]),
        new Map([["0,65,0", { facing: "east", half: "top" }]]),
      ),
      units,
      { originX: 0, originY: 65, originZ: 0 },
      0,
    );

    expect(analysis).toMatchObject({
      safe: false,
      correct: 0,
      pending: 0,
      correctPlacementUnits: 0,
      pendingPlacementUnits: 0,
      issueCounts: { blocked: 1, unloaded: 0, unsupported: 0 },
      issues: [expect.objectContaining({ kind: "blocked", expected: "oak_stairs", found: "oak_stairs" })],
    });
  });

  it("rotates a stair placement hint before accepting the site as already correct", () => {
    const units = [{
      anchor: { x: 0, y: 0, z: 0, block: "oak_stairs" },
      item: "oak_stairs",
      expectedCells: [{ x: 0, y: 0, z: 0, block: "oak_stairs" }],
      hint: { facing: "north" as const, half: "bottom" as const },
    }];
    const analysis = analyzeBuildSite(
      makeBot(
        new Map([["0,65,0", "oak_stairs"]]),
        new Map([["0,65,0", { facing: "east", half: "bottom" }]]),
      ),
      units,
      { originX: 0, originY: 65, originZ: 0 },
      90,
    );

    expect(analysis).toMatchObject({
      safe: true,
      correct: 1,
      pending: 0,
      correctPlacementUnits: 1,
      issueCounts: { blocked: 0, unloaded: 0, unsupported: 0 },
    });
  });

  it("finds a nearby safe origin when the requested site is blocked", () => {
    const bot = makeBot(new Map([["0,65,0", "chest"]]));
    const alternatives = findNearbyBuildSites(
      bot,
      [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
      { originX: 0, originY: 65, originZ: 0 },
      0,
      2,
      3,
    );

    expect(alternatives).toHaveLength(3);
    expect(alternatives[0]).toMatchObject({ distance: 1 });
    expect(alternatives[0]).not.toMatchObject({ originX: 0, originZ: 0 });
  });
});
