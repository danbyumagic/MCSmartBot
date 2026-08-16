import { describe, expect, it } from "vitest";
import { compileBuildDefinition } from "../../../src/construction/buildOps/compiler.js";
import {
  buildAsciiDefinitionSchema,
  parseBuildSource,
} from "../../../src/construction/buildOps/schema.js";
import type { BuildBlockRegistry } from "../../../src/construction/buildOps/types.js";

function registry(): BuildBlockRegistry {
  const names = ["stone", "glass_pane", "dirt"];
  return {
    version: "1.21.11",
    blocksByName: Object.fromEntries(names.map((name) => [name, { id: name.length }])),
    itemsByName: Object.fromEntries(names.map((name) => [name, { id: name.length }])),
  };
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    schema: "smartbot.build-ascii/v1",
    name: "small_arch",
    targetVersion: "1.21.11",
    palette: { "#": "stone", g: "glass_pane" },
    layers: [{ y: 0, rows: ["#g", " #"] }],
    ...overrides,
  };
}

describe("BuildOps ASCII sources", () => {
  it("maps columns west-to-east and rows north-to-south around the relative origin", () => {
    const result = compileBuildDefinition(definition(), { registry: registry() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schema).toBe("smartbot.build-ascii/v1");
    expect(result.value.placements).toEqual([
      { x: -1, y: 0, z: -1, block: "stone" },
      { x: 0, y: 0, z: -1, block: "glass_pane" },
      { x: 0, y: 0, z: 0, block: "stone" },
    ]);
  });

  it("requires bounded rectangular rows and a palette entry for every non-skip character", () => {
    expect(buildAsciiDefinitionSchema.safeParse(definition({
      layers: [{ y: 0, rows: ["##", "#"] }],
    })).success).toBe(false);
    expect(buildAsciiDefinitionSchema.safeParse(definition({
      layers: [{ y: 0, rows: ["#x"] }],
    })).success).toBe(false);
    expect(buildAsciiDefinitionSchema.safeParse(definition({
      palette: { ".": "stone" },
      layers: [{ y: 0, rows: ["."] }],
    })).success).toBe(false);
  });

  it("treats default skip characters as no-op canvas cells rather than air placements", () => {
    const result = compileBuildDefinition(definition({
      layers: [{ y: 0, rows: [" ._-#"] }],
    }), { registry: registry() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.placements).toEqual([{ x: 2, y: 0, z: 0, block: "stone" }]);
  });

  it("honors lowered ASCII dimensions before producing any candidate cells", () => {
    const result = compileBuildDefinition(definition({
      layers: [{ y: 0, rows: ["##"] }],
    }), { registry: registry(), limits: { maxAsciiWidth: 1 } });

    expect(result).toMatchObject({ ok: false, errors: [{ code: "SCHEMA_INVALID", opIndex: 0 }] });
  });

  it("uses the shared parser and deterministic source hash for ASCII sources", () => {
    const left = parseBuildSource(definition({
      palette: { "#": "stone", g: "glass_pane" },
    }));
    const right = parseBuildSource({
      targetVersion: "1.21.11",
      layers: [{ rows: ["#g", " #"], y: 0 }],
      palette: { g: "glass_pane", "#": "stone" },
      name: " small_arch ",
      schema: "smartbot.build-ascii/v1",
    });
    const first = compileBuildDefinition(left, { registry: registry() });
    const second = compileBuildDefinition(right, { registry: registry() });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.report.sourceHash).toBe(second.value.report.sourceHash);
  });

  it("resolves duplicate final cells through the same canvas pipeline", () => {
    const result = compileBuildDefinition(definition({
      palette: { "#": "stone", g: "glass_pane" },
      layers: [
        { y: 0, rows: ["#"] },
        { y: 0, rows: ["g"] },
      ],
    }), { registry: registry() });

    expect(result).toMatchObject({
      ok: true,
      value: {
        placements: [{ x: 0, y: 0, z: 0, block: "glass_pane" }],
        report: { overwrites: 1 },
      },
    });
  });
});
