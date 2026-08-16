// Portions adapted from https://github.com/NoblerWorks-HQ/minecraft-agentic,
// src/library/canvas.js @ 7e2590d9150e47956371e610e1f3ac050d3f7ad2 and
// test/ops.test.mjs @ 7e2590d9150e47956371e610e1f3ac050d3f7ad2.
// Licensed under MIT; see LICENSES/minecraft-agentic-MIT.txt.
// Modified for SmartBotMC: Vitest coverage of a coordinate-keyed bounded canvas.

import { describe, expect, it } from "vitest";
import {
  BuildCanvas,
  discOffsets,
  inclusiveBounds,
  ringOffsets,
} from "../../../src/construction/buildOps/canvas.js";

describe("BuildOps canvas", () => {
  it("keeps one proposed placement per coordinate, with later writes winning deterministically", () => {
    const canvas = new BuildCanvas();
    canvas.apply([
      { x: 2, y: 1, z: 0, block: "stone" },
      { x: 0, y: 0, z: 1, block: "dirt" },
    ], 0, 10);
    canvas.apply([{ x: 2, y: 1, z: 0, block: "glass" }], 1, 10);

    expect(canvas.size).toBe(2);
    expect(canvas.overwriteCount).toBe(1);
    expect(canvas.placements()).toEqual([
      { x: 0, y: 0, z: 1, block: "dirt" },
      { x: 2, y: 1, z: 0, block: "glass" },
    ]);
    expect(canvas.diagnostics()).toEqual([{
      kind: "overwrite",
      opIndex: 1,
      position: [2, 1, 0],
      previous: "stone",
      next: "glass",
    }]);
  });

  it("punches only proposed cells in an inclusive bounding box and never emits air", () => {
    const canvas = new BuildCanvas();
    canvas.apply([
      { x: 0, y: 0, z: 0, block: "stone" },
      { x: 1, y: 0, z: 0, block: "stone" },
      { x: 2, y: 0, z: 0, block: "stone" },
    ], 0, 10);

    const punched = canvas.punch(inclusiveBounds([1, 0, 0], [2, 0, 0]), 1, 10);

    expect(punched.removed).toEqual([
      { x: 1, y: 0, z: 0, block: "stone" },
      { x: 2, y: 0, z: 0, block: "stone" },
    ]);
    expect(canvas.placements()).toEqual([{ x: 0, y: 0, z: 0, block: "stone" }]);
    expect(canvas.punchCount).toBe(2);
    expect(canvas.diagnostics().every((diagnostic) => diagnostic.kind === "punch")).toBe(true);
  });

  it("keeps diagnostics bounded independently of overwrite and punch totals", () => {
    const canvas = new BuildCanvas();
    canvas.apply([{ x: 0, y: 0, z: 0, block: "stone" }], 0, 1);
    canvas.apply([{ x: 0, y: 0, z: 0, block: "dirt" }], 1, 1);
    canvas.punch(inclusiveBounds([0, 0, 0], [0, 0, 0]), 2, 1);

    expect(canvas.overwriteCount).toBe(1);
    expect(canvas.punchCount).toBe(1);
    expect(canvas.diagnostics()).toHaveLength(1);
  });

  it("uses gap-free, symmetric ring and disc raster offsets", () => {
    const ring = ringOffsets(5);
    const disc = discOffsets(5);
    const ringKeys = new Set(ring.map(([x, , z]) => `${x},${z}`));
    const discKeys = new Set(disc.map(([x, , z]) => `${x},${z}`));

    expect(ring.length).toBeGreaterThan(0);
    expect(ring.every(([x, , z]) => ringKeys.has(`${-x},${-z}`))).toBe(true);
    expect(ring.every(([x, , z]) => discKeys.has(`${x},${z}`))).toBe(true);
    expect(isEightConnected(ring)).toBe(true);
  });
});

function isEightConnected(points: readonly [number, number, number][]): boolean {
  if (points.length === 0) return true;
  const remaining = new Set(points.map(([x, , z]) => `${x},${z}`));
  const first = remaining.values().next().value as string;
  const queue = [first];
  remaining.delete(first);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const [x, z] = current.split(",").map(Number) as [number, number];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        const next = `${x + dx},${z + dz}`;
        if (remaining.delete(next)) queue.push(next);
      }
    }
  }
  return remaining.size === 0;
}
