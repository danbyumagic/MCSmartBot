import { describe, expect, it } from "vitest";
import {
  buildDefinitionSchema,
  parseBuildDefinition,
} from "../../../src/construction/buildOps/schema.js";

function definition(overrides: Record<string, unknown> = {}) {
  return {
    schema: "smartbot.build/v1",
    name: "watchtower",
    targetVersion: "1.21.11",
    ops: [{ op: "put", at: [0, 0, 0], block: "stone" }],
    ...overrides,
  };
}

describe("BuildOps v1 schema", () => {
  it("requires the exact v1 envelope and fills only documented defaults", () => {
    const parsed = parseBuildDefinition(definition({
      ops: [
        { op: "box", from: [0, 0, 0], to: [1, 1, 1], block: "stone" },
        { op: "walls", from: [0, 0, 0], to: [2, 2, 2], block: "stone" },
        { op: "cylinder", center: [0, 0, 0], radius: 2, height: 3, block: "stone" },
      ],
    }));

    expect(parsed).toEqual(expect.objectContaining({
      schema: "smartbot.build/v1",
      ops: [
        expect.objectContaining({ op: "box", mode: "solid" }),
        expect.objectContaining({ op: "walls", thickness: 1 }),
        expect.objectContaining({ op: "cylinder", mode: "hollow" }),
      ],
    }));
  });

  it("rejects wrong schemas, unknown root keys, unknown operations, and unknown operation keys", () => {
    expect(buildDefinitionSchema.safeParse(definition({ schema: "smartbot.build/v2" })).success).toBe(false);
    expect(buildDefinitionSchema.safeParse(definition({ unexpected: true })).success).toBe(false);
    expect(buildDefinitionSchema.safeParse(definition({
      ops: [{ op: "cone", center: [0, 0, 0], radius: 2, block: "stone" }],
    })).success).toBe(false);
    expect(buildDefinitionSchema.safeParse(definition({
      ops: [{ op: "put", at: [0, 0, 0], block: "stone", packet: "block_place" }],
    })).success).toBe(false);
  });

  it("rejects duplicate named operations rather than making diagnostics ambiguous", () => {
    const result = buildDefinitionSchema.safeParse(definition({
      ops: [
        { op: "put", name: "foundation", at: [0, 0, 0], block: "stone" },
        { op: "put", name: "foundation", at: [1, 0, 0], block: "stone" },
      ],
    }));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.message)).toContainEqual(
      expect.stringContaining("duplicate operation name 'foundation'"),
    );
  });

  it("rejects non-integer values, coordinate/radius/op caps, and missing bounds without coercion", () => {
    expect(buildDefinitionSchema.safeParse(definition({
      ops: [{ op: "put", at: [0.5, 0, 0], block: "stone" }],
    })).success).toBe(false);
    expect(buildDefinitionSchema.safeParse(definition({
      ops: [{ op: "put", at: [65, 0, 0], block: "stone" }],
    })).success).toBe(false);
    expect(buildDefinitionSchema.safeParse(definition({
      ops: [{ op: "ring", center: [0, 0, 0], radius: 33, block: "stone" }],
    })).success).toBe(false);
    expect(buildDefinitionSchema.safeParse(definition({
      ops: [{ op: "box", from: [0, 0, 0], block: "stone" }],
    })).success).toBe(false);
    expect(buildDefinitionSchema.safeParse(definition({
      ops: Array.from({ length: 129 }, () => ({ op: "put", at: [0, 0, 0], block: "stone" })),
    })).success).toBe(false);
    expect(buildDefinitionSchema.safeParse(definition({
      ops: [{ op: "put", at: ["0", 0, 0], block: "stone" }],
    })).success).toBe(false);
  });

  it("requires floors to stay on one y level and rejects arbitrary block states", () => {
    const floor = buildDefinitionSchema.safeParse(definition({
      ops: [{ op: "floor", from: [0, 0, 0], to: [2, 1, 2], block: "stone" }],
    }));
    expect(floor.success).toBe(false);
    expect(buildDefinitionSchema.safeParse(definition({
      ops: [{ op: "put", at: [0, 0, 0], block: "oak_stairs[facing=north]" }],
    })).success).toBe(false);
  });
});
