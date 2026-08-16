import { describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_BLUEPRINTS,
  installBuiltInBlueprints,
} from "../../src/construction/builtins.js";
import { UNSAFE_BLUEPRINT_BLOCKS } from "../../src/skills/construction/buildBlueprint.js";

describe("built-in blueprints", () => {
  it("stay bounded, unique, and safe", () => {
    expect(BUILT_IN_BLUEPRINTS.map((blueprint) => blueprint.name)).toEqual([
      "oak_field_shelter",
      "starter_house",
      "cobblestone_shelter",
      "platform_5x5",
      "wall_7x3",
    ]);
    for (const blueprint of BUILT_IN_BLUEPRINTS) {
      expect(blueprint.blocks.length).toBeGreaterThan(0);
      expect(blueprint.blocks.length).toBeLessThanOrEqual(256);
      const coordinates = blueprint.blocks.map(({ x, y, z }) => `${x},${y},${z}`);
      expect(new Set(coordinates).size).toBe(coordinates.length);
      expect(blueprint.blocks.some((entry) =>
        UNSAFE_BLUEPRINT_BLOCKS.has(entry.block))).toBe(false);
      for (const entry of blueprint.blocks) {
        expect(Math.abs(entry.x)).toBeLessThanOrEqual(32);
        expect(Math.abs(entry.y)).toBeLessThanOrEqual(32);
        expect(Math.abs(entry.z)).toBeLessThanOrEqual(32);
      }
    }
  });

  it("includes a field shelter that can be made entirely from oak logs", () => {
    const shelter = BUILT_IN_BLUEPRINTS.find((blueprint) =>
      blueprint.name === "oak_field_shelter")!;
    expect(new Set(shelter.blocks.map((entry) => entry.block))).toEqual(
      new Set(["oak_log", "oak_planks"]),
    );
    expect(shelter.blocks).not.toContainEqual({
      x: 2,
      y: 1,
      z: 0,
      block: "oak_planks",
    });
    expect(shelter.blocks).not.toContainEqual({
      x: 2,
      y: 2,
      z: 0,
      block: "oak_planks",
    });
  });

  it("provides a useful starter house within the construction limit", () => {
    const house = BUILT_IN_BLUEPRINTS.find((blueprint) =>
      blueprint.name === "starter_house")!;
    expect(house.blocks).toContainEqual({ x: 3, y: 1, z: 0, block: "oak_door" });
    expect(house.blocks.some((entry) => entry.block === "glass")).toBe(true);
    expect(house.blocks.some((entry) => entry.block === "oak_log")).toBe(true);
    expect(house.blocks.length).toBeLessThanOrEqual(256);
  });

  it("installs only missing blueprints", () => {
    const registerBlueprint = vi.fn((input) => ({
      id: registerBlueprint.mock.calls.length,
      tsCreated: 1,
      tsUpdated: 1,
      ...input,
    }));
    const manager = {
      getBlueprint: vi.fn((name: string) =>
        name === "platform_5x5" ? { id: 99, name, blocks: [] } : undefined),
      registerBlueprint,
    } as any;

    const installed = installBuiltInBlueprints(manager);

    expect(installed).toHaveLength(BUILT_IN_BLUEPRINTS.length - 1);
    expect(registerBlueprint).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "platform_5x5" }),
    );
  });
});
