// Portions adapted from https://github.com/NoblerWorks-HQ/minecraft-agentic,
// src/library/canvas.js @ 7e2590d9150e47956371e610e1f3ac050d3f7ad2.
// Licensed under MIT; see LICENSES/minecraft-agentic-MIT.txt.
// Modified for SmartBotMC: a bounded coordinate-keyed canvas with no roles,
// no direct world execution, deterministic final ordering, and diagnostics.

import type {
  BlueprintPlacement,
  BuildDiagnostic,
  BuildBounds,
  Vec3Tuple,
} from "./types.js";

export interface CanvasApplyResult {
  readonly overwrites: number;
}

export interface CanvasPunchResult {
  readonly removed: readonly BlueprintPlacement[];
}

/** A coordinate-keyed, deterministic proposed-build canvas. */
export class BuildCanvas {
  readonly #cells = new Map<string, BlueprintPlacement>();
  readonly #diagnostics: BuildDiagnostic[] = [];
  #overwriteCount = 0;
  #punchCount = 0;

  get size(): number {
    return this.#cells.size;
  }

  get overwriteCount(): number {
    return this.#overwriteCount;
  }

  get punchCount(): number {
    return this.#punchCount;
  }

  /** Read a copy of one currently proposed placement, if any. */
  get(position: Vec3Tuple): BlueprintPlacement | undefined {
    const value = this.#cells.get(coordinateKey(position));
    return value ? clonePlacement(value) : undefined;
  }

  /** Return a stable snapshot of existing proposed placements inside inclusive bounds. */
  within(bounds: BuildBounds): readonly BlueprintPlacement[] {
    const found: BlueprintPlacement[] = [];
    for (const placement of this.#cells.values()) {
      if (inBounds(placement, bounds)) found.push(clonePlacement(placement));
    }
    return sortPlacements(found);
  }

  /** Number of unique cells that would remain after this ordered placement batch. */
  projectedSize(placements: readonly BlueprintPlacement[]): number {
    const newKeys = new Set<string>();
    for (const placement of placements) {
      const key = coordinateKey(placement);
      if (!this.#cells.has(key)) newKeys.add(key);
    }
    return this.#cells.size + newKeys.size;
  }

  /**
   * Apply an already validated batch in order. A later placement replaces the
   * prior proposal at the same coordinate and leaves a bounded audit sample.
   */
  apply(
    placements: readonly BlueprintPlacement[],
    opIndex: number,
    maxDiagnosticSamples: number,
  ): CanvasApplyResult {
    let overwrites = 0;
    for (const rawPlacement of placements) {
      const placement = freezePlacement(rawPlacement);
      const key = coordinateKey(placement);
      const previous = this.#cells.get(key);
      if (previous) {
        overwrites++;
        this.#overwriteCount++;
        this.#record({
          kind: "overwrite",
          opIndex,
          position: [placement.x, placement.y, placement.z],
          previous: previous.block,
          next: placement.block,
        }, maxDiagnosticSamples);
      }
      this.#cells.set(key, placement);
    }
    return { overwrites };
  }

  /**
   * Remove currently proposed placements in an inclusive box. This never
   * produces air blocks and therefore can never imply a live-world dig.
   */
  punch(
    bounds: BuildBounds,
    opIndex: number,
    maxDiagnosticSamples: number,
  ): CanvasPunchResult {
    const removed: BlueprintPlacement[] = [];
    for (const [key, placement] of this.#cells) {
      if (!inBounds(placement, bounds)) continue;
      this.#cells.delete(key);
      const copy = clonePlacement(placement);
      removed.push(copy);
      this.#punchCount++;
      this.#record({
        kind: "punch",
        opIndex,
        position: [copy.x, copy.y, copy.z],
        removed: copy.block,
      }, maxDiagnosticSamples);
    }
    return { removed: sortPlacements(removed) };
  }

  /** Stable y/x/z ordering suitable for persistence and deterministic tests. */
  placements(): readonly BlueprintPlacement[] {
    return sortPlacements([...this.#cells.values()].map(clonePlacement));
  }

  diagnostics(): readonly BuildDiagnostic[] {
    return this.#diagnostics.map(cloneDiagnostic);
  }

  #record(diagnostic: BuildDiagnostic, maxSamples: number): void {
    if (this.#diagnostics.length >= maxSamples) return;
    this.#diagnostics.push(Object.freeze({
      ...diagnostic,
      position: Object.freeze([...diagnostic.position]) as Vec3Tuple,
    }) as BuildDiagnostic);
  }
}

/** Create a canonical map key for an integer relative coordinate. */
export function coordinateKey(position: Pick<BlueprintPlacement, "x" | "y" | "z"> | Vec3Tuple): string {
  if (Array.isArray(position)) return `${position[0]},${position[1]},${position[2]}`;
  return `${position.x},${position.y},${position.z}`;
}

/** Convert any two inclusive corners into stable min/max bounds. */
export function inclusiveBounds(from: Vec3Tuple, to: Vec3Tuple): BuildBounds {
  return Object.freeze({
    min: Object.freeze([
      Math.min(from[0], to[0]),
      Math.min(from[1], to[1]),
      Math.min(from[2], to[2]),
    ]) as Vec3Tuple,
    max: Object.freeze([
      Math.max(from[0], to[0]),
      Math.max(from[1], to[1]),
      Math.max(from[2], to[2]),
    ]) as Vec3Tuple,
  });
}

/** True when an exact placement lies within an inclusive relative bounding box. */
export function inBounds(
  position: Pick<BlueprintPlacement, "x" | "y" | "z">,
  bounds: BuildBounds,
): boolean {
  return position.x >= bounds.min[0] && position.x <= bounds.max[0] &&
    position.y >= bounds.min[1] && position.y <= bounds.max[1] &&
    position.z >= bounds.min[2] && position.z <= bounds.max[2];
}

/** Gap-free circle outline offsets using the upstream half-cell raster rule. */
export function ringOffsets(radius: number): readonly Vec3Tuple[] {
  return cachedRingOffsets(radius);
}

/** Gap-free filled circle offsets using the upstream half-cell raster rule. */
export function discOffsets(radius: number): readonly Vec3Tuple[] {
  return cachedDiscOffsets(radius);
}

const ringCache = new Map<number, readonly Vec3Tuple[]>();
const discCache = new Map<number, readonly Vec3Tuple[]>();

function cachedRingOffsets(radius: number): readonly Vec3Tuple[] {
  const cached = ringCache.get(radius);
  if (cached) return cached;
  const points: Vec3Tuple[] = [];
  const outer = (radius + 0.5) ** 2;
  const inner = (radius - 0.5) ** 2;
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      const distanceSquared = x * x + z * z;
      if (distanceSquared <= outer && distanceSquared >= inner) {
        points.push(Object.freeze([x, 0, z]) as Vec3Tuple);
      }
    }
  }
  const frozen = Object.freeze(points);
  ringCache.set(radius, frozen);
  return frozen;
}

function cachedDiscOffsets(radius: number): readonly Vec3Tuple[] {
  const cached = discCache.get(radius);
  if (cached) return cached;
  const points: Vec3Tuple[] = [];
  const outer = (radius + 0.5) ** 2;
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      if (x * x + z * z <= outer) points.push(Object.freeze([x, 0, z]) as Vec3Tuple);
    }
  }
  const frozen = Object.freeze(points);
  discCache.set(radius, frozen);
  return frozen;
}

/** Deterministic final sort; comparison never relies on insertion order. */
export function sortPlacements(placements: readonly BlueprintPlacement[]): BlueprintPlacement[] {
  return placements
    .map(clonePlacement)
    .sort((first, second) => first.y - second.y || first.x - second.x || first.z - second.z ||
      first.block.localeCompare(second.block));
}

function clonePlacement(placement: BlueprintPlacement): BlueprintPlacement {
  return {
    x: placement.x,
    y: placement.y,
    z: placement.z,
    block: placement.block,
    ...(placement.hint ? {
      hint: {
        ...(placement.hint.facing ? { facing: placement.hint.facing } : {}),
        ...(placement.hint.half ? { half: placement.hint.half } : {}),
      },
    } : {}),
  };
}

function freezePlacement(placement: BlueprintPlacement): BlueprintPlacement {
  const copy = clonePlacement(placement);
  return Object.freeze({
    ...copy,
    ...(copy.hint ? { hint: Object.freeze(copy.hint) } : {}),
  });
}

function cloneDiagnostic(diagnostic: BuildDiagnostic): BuildDiagnostic {
  return diagnostic.kind === "overwrite"
    ? {
      kind: diagnostic.kind,
      opIndex: diagnostic.opIndex,
      position: [...diagnostic.position] as Vec3Tuple,
      previous: diagnostic.previous,
      next: diagnostic.next,
    }
    : {
      kind: diagnostic.kind,
      opIndex: diagnostic.opIndex,
      position: [...diagnostic.position] as Vec3Tuple,
      removed: diagnostic.removed,
    };
}
