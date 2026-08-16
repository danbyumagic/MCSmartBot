import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { getBlueprintByName, getBlueprintSource } from "../../../src/construction/store.js";
import { createBuildOpsService } from "../../../src/construction/buildOps/service.js";
import { systemActor } from "../../../src/permissions/executionActor.js";
import type { BuildBlockRegistry } from "../../../src/construction/buildOps/types.js";

let tmp: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-buildops-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function registry(names = ["stone", "tnt", "oak_stairs"]): BuildBlockRegistry {
  return {
    version: "1.21.11",
    blocksByName: Object.fromEntries(names.map((name) => [name, {}])),
    itemsByName: Object.fromEntries(names.map((name) => [name, {}])),
  };
}

function definition(ops: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schema: "smartbot.build/v1",
    name: "generated_wall",
    targetVersion: "1.21.11",
    ops,
    ...overrides,
  };
}

function service() {
  return createBuildOpsService({
    db,
    registryForVersion: (version) => version === "1.21.11" ? registry() : undefined,
    now: () => 123,
  });
}

describe("BuildOps service", () => {
  it("previews through the version-aware compiler without writing", () => {
    const result = service().previewBuildDefinition({
      definition: definition([{ op: "put", at: [0, 0, 0], block: "stone" }]),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        report: { placementCount: 1, requiredAccess: "operator" },
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM blueprints").get()).toEqual({ count: 0 });
  });

  it("registers a canonical compiled source and its placements atomically", () => {
    const result = service().registerBuildDefinition({
      definition: definition([{ op: "put", at: [0, 0, 0], block: "stone" }]),
      creator: { username: "operator", role: "operator", source: "desktop" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.blueprint).toMatchObject({ name: "generated_wall", blocks: [{ x: 0, y: 0, z: 0, block: "stone" }] });
    expect(getBlueprintSource(db, result.value.blueprint.id)).toMatchObject({
      sourceHash: result.value.compiled.report.sourceHash,
      creator: { username: "operator", source: "desktop" },
      tsCreated: 123,
      tsUpdated: 123,
    });
  });

  it("registers a compact ASCII source through the same version-aware storage path", () => {
    const result = service().registerBuildDefinition({
      definition: {
        schema: "smartbot.build-ascii/v1",
        name: "ascii_arch",
        targetVersion: "1.21.11",
        palette: { "#": "stone" },
        layers: [{ y: 0, rows: ["##"] }],
      },
      creator: { username: "operator", role: "operator", source: "desktop" },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { blueprint: { name: "ascii_arch", blocks: expect.any(Array) } },
    });
    if (!result.ok) return;
    expect(getBlueprintSource(db, result.value.blueprint.id)).toMatchObject({
      schema: "smartbot.build-ascii/v1",
      targetVersion: "1.21.11",
    });
  });

  it("enforces the compiled access requirement against the registration actor", () => {
    const result = service().registerBuildDefinition({
      definition: definition([{ op: "put", at: [0, 0, 0], block: "tnt" }]),
      creator: { username: "operator", role: "operator", source: "desktop" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });
  });

  it("registers owner-authorized hazardous sources for source-aware execution", () => {
    const source = definition([{ op: "put", at: [0, 0, 0], block: "tnt" }]);
    expect(service().previewBuildDefinition({ definition: source })).toMatchObject({
      ok: true,
      value: { report: { requiredAccess: "owner" } },
    });
    const registered = service().registerBuildDefinition({
      definition: source,
      creator: systemActor("owner", "recovery"),
    });
    expect(registered).toMatchObject({
      ok: true,
      value: {
        compiled: { report: { requiredAccess: "owner" } },
        blueprint: { blocks: [{ x: 0, y: 0, z: 0, block: "tnt" }] },
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM blueprints").get()).toEqual({ count: 1 });
  });

  it("persists verified one-cell stair hints from compiled sources", () => {
    const source = definition([
      { op: "spiralStairs", center: [0, 0, 0], radius: 1, height: 1, turns: 1, clockwise: true, block: "oak_stairs" },
    ]);
    expect(service().previewBuildDefinition({ definition: source })).toMatchObject({
      ok: true,
      value: { placements: [expect.objectContaining({ hint: expect.any(Object) })] },
    });
    const registered = service().registerBuildDefinition({
      definition: source,
      creator: systemActor("owner", "recovery"),
    });
    expect(registered).toMatchObject({
      ok: true,
      value: {
        blueprint: {
          blocks: [expect.objectContaining({
            block: "oak_stairs",
            hint: { facing: expect.any(String), half: "bottom" },
          })],
          placementUnits: [expect.objectContaining({
            hint: { facing: expect.any(String), half: "bottom" },
          })],
        },
      },
    });
    if (!registered.ok) return;
    expect(getBlueprintByName(db, registered.value.blueprint.name)?.placementUnits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hint: { facing: "north", half: "bottom" } }),
      ]),
    );
  });

  it("fails target-version resolution without writing a blueprint", () => {
    const result = service().registerBuildDefinition({
      definition: definition([{ op: "put", at: [0, 0, 0], block: "stone" }], { targetVersion: "1.20.4" }),
      creator: systemActor("owner", "recovery"),
    });

    expect(result).toMatchObject({ ok: false, error: { code: "VERSION_MISMATCH" } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM blueprints").get()).toEqual({ count: 0 });
  });
});
