import { describe, expect, it } from "vitest";
import { compileBuildDefinition } from "../../../src/construction/buildOps/compiler.js";
import type { BuildBlockRegistry, BlueprintPlacement } from "../../../src/construction/buildOps/types.js";

function registry(): BuildBlockRegistry {
  const names = ["stone", "glass", "oak_stairs"];
  return {
    version: "1.21.11",
    blocksByName: Object.fromEntries(names.map((name) => [name, { id: name.length }])),
    itemsByName: Object.fromEntries(names.map((name) => [name, { id: name.length }])),
  };
}

function definition(ops: unknown[]) {
  return {
    schema: "smartbot.build/v1",
    name: "advanced_geometry",
    targetVersion: "1.21.11",
    ops,
  };
}

function compile(ops: unknown[], limits?: Record<string, number>) {
  return compileBuildDefinition(definition(ops), { registry: registry(), limits });
}

function has(placements: readonly BlueprintPlacement[], x: number, y: number, z: number): boolean {
  return placements.some((placement) => placement.x === x && placement.y === y && placement.z === z);
}

describe("BuildOps advanced geometry", () => {
  it("keeps domes symmetric and emits bounded gable ridges", () => {
    const dome = compile([
      { op: "dome", center: [0, 0, 0], radius: 3, block: "stone", mode: "hollow", thickness: 1 },
    ]);
    expect(dome.ok).toBe(true);
    if (!dome.ok) return;
    for (const placement of dome.value.placements) {
      expect(has(dome.value.placements, -placement.x, placement.y, placement.z)).toBe(true);
      expect(has(dome.value.placements, placement.x, placement.y, -placement.z)).toBe(true);
    }

    const roof = compile([
      { op: "gableRoof", from: [0, 0, 0], to: [4, 2, 4], ridge: "x", block: "stone" },
    ]);
    expect(roof.ok).toBe(true);
    if (!roof.ok) return;
    expect(roof.value.report.bounds).toEqual({ min: [0, 0, 0], max: [4, 2, 4] });
    expect(roof.value.placements.filter((placement) => placement.y === 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 0, y: 2, z: 2 }),
        expect.objectContaining({ x: 4, y: 2, z: 2 }),
      ]),
    );
  });

  it("keeps curved-wall arc endpoints and spiral hints deterministic", () => {
    const arc = compile([
      {
        op: "curvedWall",
        center: [0, 0, 0],
        radius: 4,
        startAngle: 0,
        endAngle: 90,
        height: 2,
        thickness: 1,
        block: "stone",
      },
    ]);
    expect(arc.ok).toBe(true);
    if (!arc.ok) return;
    expect(has(arc.value.placements, 4, 0, 0)).toBe(true);
    expect(has(arc.value.placements, 0, 1, 4)).toBe(true);

    const spiral = compile([
      {
        op: "spiralStairs",
        center: [0, 0, 0],
        radius: 2,
        height: 4,
        turns: 1,
        clockwise: true,
        block: "oak_stairs",
      },
    ]);
    expect(spiral.ok).toBe(true);
    if (!spiral.ok) return;
    expect(spiral.value.placements.map((placement) => placement.y)).toEqual([0, 1, 2, 3]);
    expect(spiral.value.placements).toContainEqual({
      x: 2,
      y: 0,
      z: 0,
      block: "oak_stairs",
      hint: { facing: "north", half: "bottom" },
    });
    expect(spiral.value.placements.every((placement) => placement.hint?.half === "bottom")).toBe(true);
  });

  it("copies a stable canvas snapshot and rotates/mirrors placement hints with it", () => {
    const result = compile([
      { op: "put", at: [1, 0, 0], block: "oak_stairs" },
      { op: "spiralStairs", center: [0, 1, 0], radius: 1, height: 1, turns: 1, clockwise: true, block: "oak_stairs" },
      { op: "copy", from: [1, 0, 0], to: [2, 1, 0], offset: [0, 0, 3] },
      { op: "rotate", from: [1, 1, 0], to: [1, 1, 0], pivot: [0, 1, 0], quarterTurns: 1 },
      { op: "mirror", from: [0, 1, 1], to: [0, 1, 1], pivot: [0, 1, 0], axis: "z" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.placements).toContainEqual({ x: 1, y: 0, z: 3, block: "oak_stairs" });
    expect(result.value.placements).toContainEqual({
      x: 0,
      y: 1,
      z: 1,
      block: "oak_stairs",
      hint: { facing: "east", half: "bottom" },
    });
    expect(result.value.placements).toContainEqual({
      x: 0,
      y: 1,
      z: -1,
      block: "oak_stairs",
      hint: { facing: "east", half: "bottom" },
    });
  });

  it("fails the operation before mutating its canvas when a transformed snapshot exceeds a budget", () => {
    const result = compile([
      { op: "put", at: [0, 0, 0], block: "stone" },
      { op: "put", at: [1, 0, 0], block: "stone" },
      { op: "put", at: [2, 0, 0], block: "stone" },
      { op: "copy", from: [0, 0, 0], to: [2, 0, 0], offset: [0, 0, 2] },
    ], { maxCellsPerOperation: 2 });

    expect(result).toMatchObject({ ok: false, errors: [{ code: "OPERATION_CELL_LIMIT", opIndex: 3 }] });
  });

  it("rejects every derived advanced-geometry coordinate instead of clamping it", () => {
    const result = compile([
      { op: "dome", center: [64, 0, 0], radius: 1, block: "stone", mode: "hollow", thickness: 1 },
    ]);

    expect(result).toMatchObject({ ok: false, errors: [{ code: "COORDINATE_OUT_OF_RANGE", opIndex: 0 }] });
  });

  it("honors lowered radius and operation caps for advanced sources", () => {
    const radius = compile([
      { op: "curvedWall", center: [0, 0, 0], radius: 2, startAngle: 0, endAngle: 90, height: 1, thickness: 1, block: "stone" },
    ], { maxRadius: 1 });
    expect(radius).toMatchObject({ ok: false, errors: [{ code: "SCHEMA_INVALID", opIndex: 0 }] });

    const operationCount = compile([
      { op: "put", at: [0, 0, 0], block: "stone" },
      { op: "put", at: [1, 0, 0], block: "stone" },
    ], { maxOperations: 1 });
    expect(operationCount).toMatchObject({ ok: false, errors: [{ code: "SCHEMA_INVALID" }] });
  });
});
