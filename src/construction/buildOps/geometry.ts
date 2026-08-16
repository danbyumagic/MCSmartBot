// Portions adapted from https://github.com/AnctyEnly453/mc-architect-mcp,
// bridge/src/geometry.ts @ 51fe736bf4bf59185f961e80f01b58c36b67f7fa.
// Licensed under MIT; see LICENSES/mc-architect-mcp-MIT.txt.
// Modified for SmartBotMC: emit bounded pure placement cells and typed hints
// only; no FillOperation compression, block-state strings, Fabric code, or
// direct world execution is retained.

import type {
  BlueprintPlacement,
  BuildOperation,
  Cardinal,
  PlacementHint,
  Vec3Tuple,
} from "./types.js";

type AdvancedGeometryOperation = Extract<BuildOperation, {
  op: "gableRoof" | "curvedWall" | "dome" | "spiralStairs";
}>;

type TransformOperation = Extract<BuildOperation, { op: "copy" | "rotate" | "mirror" }>;

export interface GeometryGenerationResult {
  readonly placements: readonly BlueprintPlacement[];
  readonly overflow: boolean;
}

/** Expand a pure advanced geometry operation into ordinary placement units. */
export function generateAdvancedPlacements(
  operation: AdvancedGeometryOperation,
  block: string,
  maxCells: number,
): GeometryGenerationResult {
  const collector = new GeometryCollector(maxCells);
  switch (operation.op) {
    case "gableRoof":
      emitGableRoof(operation, block, collector);
      break;
    case "curvedWall":
      emitCurvedWall(operation, block, collector);
      break;
    case "dome":
      emitDome(operation, block, collector);
      break;
    case "spiralStairs":
      emitSpiralStairs(operation, block, collector);
      break;
  }
  return { placements: collector.placements(), overflow: collector.overflow };
}

/**
 * Transform one stable canvas snapshot. Transform operations deliberately
 * retain their source cells; callers overlay this returned batch exactly once.
 */
export function transformSnapshot(
  operation: TransformOperation,
  source: readonly BlueprintPlacement[],
): readonly BlueprintPlacement[] {
  switch (operation.op) {
    case "copy":
      return source.map((placement) => clonePlacement(placement, {
        x: placement.x + operation.offset[0],
        y: placement.y + operation.offset[1],
        z: placement.z + operation.offset[2],
      }));
    case "rotate":
      return source.map((placement) => rotatePlacement(placement, operation.pivot, operation.quarterTurns));
    case "mirror":
      return source.map((placement) => mirrorPlacement(placement, operation.pivot, operation.axis));
  }
}

function emitGableRoof(
  operation: Extract<AdvancedGeometryOperation, { op: "gableRoof" }>,
  block: string,
  collector: GeometryCollector,
): void {
  const minX = Math.min(operation.from[0], operation.to[0]);
  const maxX = Math.max(operation.from[0], operation.to[0]);
  const minY = Math.min(operation.from[1], operation.to[1]);
  const maxY = Math.max(operation.from[1], operation.to[1]);
  const minZ = Math.min(operation.from[2], operation.to[2]);
  const maxZ = Math.max(operation.from[2], operation.to[2]);
  const slopeMin = operation.ridge === "x" ? minZ : minX;
  const slopeMax = operation.ridge === "x" ? maxZ : maxX;
  const halfSpan = Math.floor((slopeMax - slopeMin) / 2);
  const rise = maxY - minY;

  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      const slopeCoordinate = operation.ridge === "x" ? z : x;
      const distanceFromEave = Math.min(slopeCoordinate - slopeMin, slopeMax - slopeCoordinate);
      const relativeHeight = halfSpan === 0 ? rise : Math.round(rise * distanceFromEave / halfSpan);
      if (!collector.add(x, minY + Math.min(rise, relativeHeight), z, block)) return;
    }
  }
}

function emitCurvedWall(
  operation: Extract<AdvancedGeometryOperation, { op: "curvedWall" }>,
  block: string,
  collector: GeometryCollector,
): void {
  const span = normalizedAngleSpan(operation.startAngle, operation.endAngle);
  const samples = Math.max(2, Math.ceil(span * Math.PI / 180 * (operation.radius + operation.thickness) * 2));
  for (let sample = 0; sample <= samples; sample++) {
    const angle = (operation.startAngle + span * sample / samples) * Math.PI / 180;
    for (let inset = 0; inset < operation.thickness; inset++) {
      const radius = operation.radius - inset;
      if (radius < 0) break;
      const x = Math.round(operation.center[0] + Math.cos(angle) * radius);
      const z = Math.round(operation.center[2] + Math.sin(angle) * radius);
      for (let yOffset = 0; yOffset < operation.height; yOffset++) {
        if (!collector.add(x, operation.center[1] + yOffset, z, block)) return;
      }
    }
  }
}

function emitDome(
  operation: Extract<AdvancedGeometryOperation, { op: "dome" }>,
  block: string,
  collector: GeometryCollector,
): void {
  const innerRadius = Math.max(0, operation.radius - operation.thickness);
  for (let yOffset = 0; yOffset <= operation.radius; yOffset++) {
    const outer = Math.sqrt(operation.radius * operation.radius - yOffset * yOffset);
    const inner = yOffset >= innerRadius
      ? -1
      : Math.sqrt(innerRadius * innerRadius - yOffset * yOffset);
    const extent = Math.ceil(outer);
    for (let xOffset = -extent; xOffset <= extent; xOffset++) {
      for (let zOffset = -extent; zOffset <= extent; zOffset++) {
        const horizontal = Math.hypot(xOffset, zOffset);
        const selected = horizontal <= outer + 0.35 &&
          (operation.mode === "filled" || inner < 0 || horizontal >= inner - 0.35);
        if (!selected) continue;
        if (!collector.add(
          operation.center[0] + xOffset,
          operation.center[1] + yOffset,
          operation.center[2] + zOffset,
          block,
        )) return;
      }
    }
  }
}

function emitSpiralStairs(
  operation: Extract<AdvancedGeometryOperation, { op: "spiralStairs" }>,
  block: string,
  collector: GeometryCollector,
): void {
  const direction = operation.clockwise ? -1 : 1;
  for (let step = 0; step < operation.height; step++) {
    const progress = operation.height === 1 ? 0 : step / (operation.height - 1);
    const angle = direction * operation.turns * Math.PI * 2 * progress;
    const tangentX = -Math.sin(angle) * direction;
    const tangentZ = Math.cos(angle) * direction;
    if (!collector.add(
      Math.round(operation.center[0] + Math.cos(angle) * operation.radius),
      operation.center[1] + step,
      Math.round(operation.center[2] + Math.sin(angle) * operation.radius),
      block,
      block.endsWith("_stairs") ? { facing: facingFromTangent(tangentX, tangentZ), half: "bottom" } : undefined,
    )) return;
  }
}

function rotatePlacement(
  placement: BlueprintPlacement,
  pivot: Vec3Tuple,
  quarterTurns: 1 | 2 | 3,
): BlueprintPlacement {
  let x = placement.x - pivot[0];
  let z = placement.z - pivot[2];
  for (let turn = 0; turn < quarterTurns; turn++) {
    const nextX = -z;
    z = x;
    x = nextX;
  }
  return clonePlacement(placement, {
    x: pivot[0] + x,
    y: placement.y,
    z: pivot[2] + z,
  }, rotateHint(placement.hint, quarterTurns));
}

function mirrorPlacement(
  placement: BlueprintPlacement,
  pivot: Vec3Tuple,
  axis: "x" | "z",
): BlueprintPlacement {
  const x = axis === "x" ? 2 * pivot[0] - placement.x : placement.x;
  const z = axis === "z" ? 2 * pivot[2] - placement.z : placement.z;
  return clonePlacement(placement, { x, y: placement.y, z }, mirrorHint(placement.hint, axis));
}

function normalizedAngleSpan(startAngle: number, endAngle: number): number {
  let span = endAngle - startAngle;
  while (span <= 0) span += 360;
  return Math.min(span, 360);
}

function facingFromTangent(x: number, z: number): Cardinal {
  if (Math.abs(x) > Math.abs(z)) return x > 0 ? "east" : "west";
  return z > 0 ? "south" : "north";
}

function rotateHint(hint: PlacementHint | undefined, quarterTurns: 1 | 2 | 3): PlacementHint | undefined {
  if (!hint) return undefined;
  let facing = hint.facing;
  for (let turn = 0; facing && turn < quarterTurns; turn++) {
    facing = rotateFacing(facing);
  }
  return {
    ...(facing ? { facing } : {}),
    ...(hint.half ? { half: hint.half } : {}),
  };
}

function rotateFacing(facing: Cardinal): Cardinal {
  switch (facing) {
    case "north": return "east";
    case "east": return "south";
    case "south": return "west";
    case "west": return "north";
  }
}

function mirrorHint(hint: PlacementHint | undefined, axis: "x" | "z"): PlacementHint | undefined {
  if (!hint) return undefined;
  const inputFacing = hint.facing;
  const facing = inputFacing && (axis === "x"
    ? inputFacing === "east" ? "west" : inputFacing === "west" ? "east" : inputFacing
    : inputFacing === "north" ? "south" : inputFacing === "south" ? "north" : inputFacing);
  return {
    ...(facing ? { facing } : {}),
    ...(hint.half ? { half: hint.half } : {}),
  };
}

function clonePlacement(
  placement: BlueprintPlacement,
  position: Pick<BlueprintPlacement, "x" | "y" | "z">,
  hint = placement.hint,
): BlueprintPlacement {
  return {
    x: position.x,
    y: position.y,
    z: position.z,
    block: placement.block,
    ...(hint ? {
      hint: {
        ...(hint.facing ? { facing: hint.facing } : {}),
        ...(hint.half ? { half: hint.half } : {}),
      },
    } : {}),
  };
}

class GeometryCollector {
  readonly #placements = new Map<string, BlueprintPlacement>();
  #overflow = false;

  constructor(private readonly maxCells: number) {}

  get overflow(): boolean {
    return this.#overflow;
  }

  add(x: number, y: number, z: number, block: string, hint?: PlacementHint): boolean {
    const key = `${x},${y},${z}`;
    const placement: BlueprintPlacement = {
      x,
      y,
      z,
      block,
      ...(hint ? { hint } : {}),
    };
    if (!this.#placements.has(key) && this.#placements.size >= this.maxCells) {
      this.#overflow = true;
      return false;
    }
    this.#placements.set(key, placement);
    return true;
  }

  placements(): readonly BlueprintPlacement[] {
    return [...this.#placements.values()];
  }
}
