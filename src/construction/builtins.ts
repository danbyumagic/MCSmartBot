import type { ConstructionManager } from "./manager.js";
import type { BlueprintBlock, BlueprintInput, BlueprintRow } from "./store.js";

export const BUILT_IN_BLUEPRINTS: BlueprintInput[] = [
  oakFieldShelter(),
  starterHouse(),
  cobblestoneShelter(),
  platform5x5(),
  wall7x3(),
];

/**
 * Seed missing built-ins without overwriting a blueprint the owner customized
 * or one already referenced by an active construction job.
 */
export function installBuiltInBlueprints(
  manager: ConstructionManager,
): BlueprintRow[] {
  const installed: BlueprintRow[] = [];
  for (const blueprint of BUILT_IN_BLUEPRINTS) {
    if (manager.getBlueprint(blueprint.name)) continue;
    installed.push(manager.registerBlueprint(blueprint));
  }
  return installed;
}

function starterHouse(): BlueprintInput {
  const blocks: BlueprintBlock[] = [];
  const width = 7;
  const depth = 9;
  const doorX = 3;

  // The origin is one block above a flat patch of ground.
  fillPlane(blocks, width, depth, 0, "cobblestone");

  for (let y = 1; y <= 3; y++) {
    forEachPerimeter(width, depth, (x, z) => {
      if (z === 0 && x === doorX && (y === 1 || y === 2)) return;
      const corner = (x === 0 || x === width - 1) &&
        (z === 0 || z === depth - 1);
      const window = y === 2 && (
        (z === 0 && (x === 1 || x === width - 2)) ||
        (z === depth - 1 && (x === 2 || x === width - 3)) ||
        ((x === 0 || x === width - 1) && (z === 3 || z === 5))
      );
      blocks.push({
        x,
        y,
        z,
        block: corner ? "oak_log" : window ? "glass" : "oak_planks",
      });
    });
  }
  blocks.push({ x: doorX, y: 1, z: 0, block: "oak_door" });
  fillPlane(blocks, width, depth, 4, "oak_planks");

  return { name: "starter_house", blocks };
}

function oakFieldShelter(): BlueprintInput {
  const blocks: BlueprintBlock[] = [];
  const width = 5;
  const depth = 5;
  const doorwayX = 2;

  fillPlane(blocks, width, depth, 0, "oak_planks");
  for (let y = 1; y <= 2; y++) {
    forEachPerimeter(width, depth, (x, z) => {
      if (z === 0 && x === doorwayX) return;
      const corner = (x === 0 || x === width - 1) &&
        (z === 0 || z === depth - 1);
      blocks.push({
        x,
        y,
        z,
        block: corner ? "oak_log" : "oak_planks",
      });
    });
  }
  fillPlane(blocks, width, depth, 3, "oak_planks");
  return { name: "oak_field_shelter", blocks };
}

function cobblestoneShelter(): BlueprintInput {
  const blocks: BlueprintBlock[] = [];
  const width = 5;
  const depth = 5;
  const doorX = 2;

  fillPlane(blocks, width, depth, 0, "cobblestone");
  for (let y = 1; y <= 2; y++) {
    forEachPerimeter(width, depth, (x, z) => {
      if (z === 0 && x === doorX) return;
      const window = y === 2 && (
        (z === depth - 1 && x === 2) ||
        ((x === 0 || x === width - 1) && z === 2)
      );
      blocks.push({ x, y, z, block: window ? "glass" : "cobblestone" });
    });
  }
  blocks.push({ x: doorX, y: 1, z: 0, block: "oak_door" });
  fillPlane(blocks, width, depth, 3, "cobblestone");

  return { name: "cobblestone_shelter", blocks };
}

function platform5x5(): BlueprintInput {
  const blocks: BlueprintBlock[] = [];
  fillPlane(blocks, 5, 5, 0, "cobblestone");
  return { name: "platform_5x5", blocks };
}

function wall7x3(): BlueprintInput {
  const blocks: BlueprintBlock[] = [];
  for (let x = 0; x < 7; x++) {
    for (let y = 0; y < 3; y++) {
      blocks.push({ x, y, z: 0, block: "cobblestone" });
    }
  }
  return { name: "wall_7x3", blocks };
}

function fillPlane(
  blocks: BlueprintBlock[],
  width: number,
  depth: number,
  y: number,
  block: string,
): void {
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      blocks.push({ x, y, z, block });
    }
  }
}

function forEachPerimeter(
  width: number,
  depth: number,
  visit: (x: number, z: number) => void,
): void {
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, depth - 1);
  }
  for (let z = 1; z < depth - 1; z++) {
    visit(0, z);
    visit(width - 1, z);
  }
}
