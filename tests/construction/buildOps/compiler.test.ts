// Portions adapted from https://github.com/NoblerWorks-HQ/minecraft-agentic,
// src/ops.js @ 7e2590d9150e47956371e610e1f3ac050d3f7ad2 and
// test/ops.test.mjs @ 7e2590d9150e47956371e610e1f3ac050d3f7ad2.
// Licensed under MIT; see LICENSES/minecraft-agentic-MIT.txt.
// Modified for SmartBotMC: strict fail-closed compilation, injected registry,
// bounded reports, and no direct Minecraft/world execution.

import minecraftData from "minecraft-data";
import { describe, expect, it } from "vitest";
import { createBuildBlockRegistry } from "../../../src/construction/buildOps/blockRegistry.js";
import {
  compileBuildDefinition,
  compileBuildDefinitionForVersion,
  hashBuildSource,
} from "../../../src/construction/buildOps/compiler.js";
import { parseBuildDefinition } from "../../../src/construction/buildOps/schema.js";
import type { BuildBlockRegistry } from "../../../src/construction/buildOps/types.js";

function registry(
  names = ["stone", "dirt", "glass", "glass_pane", "stone_bricks", "tnt", "bedrock"],
  version = "1.21.11",
): BuildBlockRegistry {
  return {
    version,
    blocksByName: Object.fromEntries(names.map((name) => [name, { id: name.length }])),
    itemsByName: Object.fromEntries(names.map((name) => [name, { id: name.length }])),
  };
}

function definition(ops: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schema: "smartbot.build/v1",
    name: "test_build",
    targetVersion: "1.21.11",
    ops,
    ...overrides,
  };
}

function compile(ops: unknown[], options: Record<string, unknown> = {}) {
  return compileBuildDefinition(definition(ops), {
    registry: registry(),
    ...options,
  });
}

describe("BuildOps compiler", () => {
  it("compiles all initial pure primitives into deterministic final placements", () => {
    const result = compile([
      { op: "put", at: [-10, 0, 0], block: "stone" },
      { op: "box", from: [0, 0, 0], to: [1, 1, 1], block: "stone", mode: "solid" },
      { op: "box", from: [3, 0, 0], to: [5, 2, 2], block: "dirt", mode: "hollow" },
      { op: "box", from: [7, 0, 0], to: [9, 2, 2], block: "glass", mode: "outline" },
      { op: "walls", from: [11, 0, 0], to: [14, 1, 3], block: "stone", thickness: 1 },
      { op: "floor", from: [16, 0, 0], to: [17, 0, 1], block: "dirt" },
      { op: "cylinder", center: [22, 0, 0], radius: 1, height: 2, block: "stone", mode: "filled" },
      { op: "cylinder", center: [27, 0, 0], radius: 1, height: 2, block: "stone", mode: "hollow" },
      { op: "disc", center: [32, 0, 0], radius: 1, block: "glass" },
      { op: "ring", center: [37, 0, 0], radius: 1, block: "glass" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.operationCount).toBe(10);
    expect(result.value.report.worldCellCount).toBe(result.value.placements.length);
    expect(result.value.placements).toEqual([...result.value.placements].sort((a, b) =>
      a.y - b.y || a.x - b.x || a.z - b.z || a.block.localeCompare(b.block)));
    expect(result.value.placements).toContainEqual({ x: -10, y: 0, z: 0, block: "stone" });
    expect(result.value.placements).toContainEqual({ x: 0, y: 1, z: 1, block: "stone" });
    expect(result.value.placements).not.toContainEqual({ x: 4, y: 1, z: 1, block: "dirt" });
    expect(result.value.placements).not.toContainEqual({ x: 8, y: 1, z: 1, block: "glass" });
    expect(result.value.placements).toContainEqual({ x: 12, y: 0, z: 0, block: "stone" });
    expect(result.value.placements).not.toContainEqual({ x: 12, y: 0, z: 1, block: "stone" });
  });

  it("supports thick walls, deliberate later overwrites, and final material totals", () => {
    const result = compile([
      { op: "walls", from: [0, 0, 0], to: [3, 1, 3], block: "stone", thickness: 2 },
      { op: "put", at: [0, 0, 0], block: "dirt" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.worldCellCount).toBe(32);
    expect(result.value.report.overwrites).toBe(1);
    expect(result.value.report.materials).toEqual({ dirt: 1, stone: 31 });
    expect(result.value.placements).toContainEqual({ x: 0, y: 0, z: 0, block: "dirt" });
    expect(result.value.report.diagnostics).toContainEqual(expect.objectContaining({
      kind: "overwrite",
      previous: "stone",
      next: "dirt",
    }));
  });

  it("punches proposed cells only, and windows carve then glaze only actual removed cells", () => {
    const result = compile([
      { op: "walls", from: [0, 0, 0], to: [4, 2, 0], block: "stone", thickness: 1 },
      { op: "window", from: [1, 1, 0], to: [2, 2, 0], block: "glass_pane" },
      { op: "punch", from: [4, 0, 0], to: [4, 0, 0] },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.placements).toContainEqual({ x: 1, y: 1, z: 0, block: "glass_pane" });
    expect(result.value.placements).toContainEqual({ x: 2, y: 2, z: 0, block: "glass_pane" });
    expect(result.value.placements).not.toContainEqual({ x: 1, y: 1, z: 0, block: "stone" });
    expect(result.value.placements).not.toContainEqual({ x: 4, y: 0, z: 0, block: "stone" });
    expect(result.value.report.punches).toBe(5);

    const floating = compile([
      { op: "put", at: [0, 0, 0], block: "stone" },
      { op: "window", from: [9, 0, 0], to: [9, 0, 0], block: "glass_pane" },
    ]);
    expect(floating.ok).toBe(true);
    if (!floating.ok) return;
    expect(floating.value.placements).toEqual([{ x: 0, y: 0, z: 0, block: "stone" }]);
    expect(floating.value.report.warnings).toContainEqual(expect.objectContaining({ code: "WINDOW_EMPTY" }));
  });

  it("fails closed when a primitive exceeds its per-op budget or total unique-cell budget", () => {
    const perOp = compile([
      { op: "box", from: [0, 0, 0], to: [2, 1, 1], block: "stone", mode: "solid" },
    ], { limits: { maxCellsPerOperation: 4 } });
    expect(perOp).toMatchObject({ ok: false, errors: [{ code: "OPERATION_CELL_LIMIT" }] });

    const total = compile([
      { op: "put", at: [0, 0, 0], block: "stone" },
      { op: "put", at: [1, 0, 0], block: "stone" },
      { op: "put", at: [2, 0, 0], block: "stone" },
    ], { limits: { maxWorldCells: 2 } });
    expect(total).toMatchObject({ ok: false, errors: [{ code: "OUTPUT_CELL_LIMIT" }] });
  });

  it("compiles a maximum-size pure design within a generous bounded runtime", () => {
    // This is intentionally a very loose CI guard, not a microbenchmark. It
    // catches accidental quadratic expansion while allowing slow shared test
    // runners plenty of headroom.
    const started = performance.now();
    const result = compile([
      { op: "box", from: [-8, -8, -8], to: [7, 7, -1], block: "stone", mode: "solid" },
      { op: "box", from: [-8, -8, 0], to: [7, 7, 7], block: "stone", mode: "solid" },
    ]);
    const elapsedMs = performance.now() - started;

    expect(result).toMatchObject({ ok: true, value: { report: { placementCount: 4_096 } } });
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("validates every derived coordinate rather than clamping a circle or cylinder", () => {
    const disc = compile([
      { op: "disc", center: [64, 0, 0], radius: 1, block: "stone" },
    ]);
    expect(disc).toMatchObject({ ok: false, errors: [{ code: "COORDINATE_OUT_OF_RANGE" }] });

    const cylinder = compile([
      { op: "cylinder", center: [0, 64, 0], radius: 1, height: 2, block: "stone", mode: "hollow" },
    ]);
    expect(cylinder).toMatchObject({ ok: false, errors: [{ code: "COORDINATE_OUT_OF_RANGE" }] });
  });

  it("normalizes one harmless alias, rejects unknown/ambiguous/not-placeable blocks, and classifies TNT as owner-only", () => {
    const normalized = compile([
      { op: "put", at: [0, 0, 0], block: "minecraft:stone_brick" },
    ]);
    expect(normalized).toMatchObject({
      ok: true,
      value: {
        placements: [{ x: 0, y: 0, z: 0, block: "stone_bricks" }],
        report: { warnings: [expect.objectContaining({ code: "BLOCK_NORMALIZED", from: "stone_brick", to: "stone_bricks" })] },
      },
    });

    const unknown = compile([{ op: "put", at: [0, 0, 0], block: "castle_wall" }]);
    expect(unknown).toMatchObject({ ok: false, errors: [{ code: "BLOCK_UNKNOWN" }] });

    const ambiguousRegistry = registry(["stone", "stones", "stoness"]);
    const ambiguous = compileBuildDefinition(definition([
      { op: "put", at: [0, 0, 0], block: "stones" },
    ]), { registry: ambiguousRegistry });
    // "stones" is exact here; make its block record absent while two repairs remain available.
    const trulyAmbiguous = compileBuildDefinition(definition([
      { op: "put", at: [0, 0, 0], block: "stones" },
    ]), {
      registry: {
        version: "1.21.11",
        blocksByName: { stone: {}, stoness: {} },
        itemsByName: { stone: {}, stoness: {} },
      },
    });
    expect(ambiguous.ok).toBe(true);
    expect(trulyAmbiguous).toMatchObject({ ok: false, errors: [{ code: "BLOCK_AMBIGUOUS" }] });

    const notPlaceable = compileBuildDefinition(definition([
      { op: "put", at: [0, 0, 0], block: "stone" },
    ]), {
      registry: { version: "1.21.11", blocksByName: { stone: {} }, itemsByName: {} },
    });
    expect(notPlaceable).toMatchObject({ ok: false, errors: [{ code: "BLOCK_NOT_PLACEABLE" }] });

    const hazardous = compile([{ op: "put", at: [0, 0, 0], block: "tnt" }]);
    expect(hazardous).toMatchObject({ ok: true, value: { report: { requiredAccess: "owner" } } });
  });

  it("rejects technical/server-managed blocks even if a registry exposes them", () => {
    const result = compile([{ op: "put", at: [0, 0, 0], block: "bedrock" }]);
    expect(result).toMatchObject({ ok: false, errors: [{ code: "BLOCK_UNSUPPORTED" }] });
  });

  it("uses the target-version registry exactly, including live minecraft-data registries", () => {
    const oneTwentyOne = createBuildBlockRegistry(minecraftData("1.21.11"));
    const oneTwenty = createBuildBlockRegistry(minecraftData("1.20.4"));
    const source = definition([{ op: "put", at: [0, 0, 0], block: "stone" }]);

    const current = compileBuildDefinition(source, { registry: oneTwentyOne });
    expect(current.ok).toBe(true);
    const mismatch = compileBuildDefinition(source, { registry: oneTwenty });
    expect(mismatch).toMatchObject({ ok: false, errors: [{ code: "VERSION_MISMATCH" }] });
    const resolved = compileBuildDefinitionForVersion(source, {
      registryForVersion: (version) => version === "1.21.11" ? oneTwentyOne : undefined,
    });
    expect(resolved.ok).toBe(true);
  });

  it("hashes parsed canonical source rather than original object key order or whitespace", () => {
    const left = parseBuildDefinition(definition([
      { op: "box", block: "stone", to: [1, 1, 1], from: [0, 0, 0] },
    ]));
    const right = parseBuildDefinition({
      targetVersion: "1.21.11",
      ops: [{ from: [0, 0, 0], op: "box", mode: "solid", to: [1, 1, 1], block: "stone" }],
      name: " test_build ",
      schema: "smartbot.build/v1",
    });

    expect(hashBuildSource(left)).toBe(hashBuildSource(right));
    const result = compileBuildDefinition(left, { registry: registry() });
    expect(result).toMatchObject({ ok: true, value: { report: { sourceHash: hashBuildSource(left) } } });
  });
});
