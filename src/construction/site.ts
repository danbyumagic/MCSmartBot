import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  countExpectedWorldCells,
  normalizeBlueprintPlacementUnits,
  type BlueprintBlock,
  type BlueprintPlacementUnit,
} from "./store.js";
import type { Cardinal, PlacementHint } from "./buildOps/types.js";

export const BUILD_ROTATIONS = [0, 90, 180, 270] as const;
export type BuildRotation = typeof BUILD_ROTATIONS[number];

export const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);
export const REPLACEABLE_BUILD_BLOCKS = new Set([
  ...AIR_BLOCKS,
  "short_grass",
  "tall_grass",
  "fern",
  "large_fern",
  "dead_bush",
  "snow",
  "vine",
  "glow_lichen",
  "seagrass",
  "tall_seagrass",
]);

/** Default bounded preview payload. Totals always include every issue. */
export const DEFAULT_BUILD_SITE_ISSUE_SAMPLES = 32;
/** Callers cannot turn a site preview into a multi-thousand-cell response. */
export const MAX_BUILD_SITE_ISSUE_SAMPLES = 64;

export interface BuildOrigin {
  originX: number;
  originY: number;
  originZ: number;
}

export interface BuildSiteIssue {
  kind: "blocked" | "unloaded" | "unsupported";
  position: { x: number; y: number; z: number };
  expected: string;
  found: string | null;
}

export interface BuildSiteIssueCounts {
  blocked: number;
  unloaded: number;
  unsupported: number;
}

export interface BuildSiteAnalysisOptions {
  /** Bounded deterministic sample size; zero computes only aggregate counts. */
  maxIssueSamples?: number;
}

export interface BuildSiteAnalysis {
  safe: boolean;
  /** Compatibility aliases for correct/pending expected world cells. */
  correct: number;
  pending: number;
  /** Exact cardinality of material uses, not necessarily world cells. */
  placementUnitCount: number;
  /** Exact cardinality of required final world cells. */
  worldCellCount: number;
  /** A unit is correct only when every expected cell is correct. */
  correctPlacementUnits: number;
  /** A unit is pending when it has at least one replaceable expected cell. */
  pendingPlacementUnits: number;
  correctWorldCells: number;
  pendingWorldCells: number;
  /** Exact totals even when `issues` is intentionally truncated. */
  issueCounts: BuildSiteIssueCounts;
  /** Deterministic, bounded sample of the issue totals above. */
  issues: BuildSiteIssue[];
}

export type BuildSiteInput = readonly BlueprintBlock[] | readonly BlueprintPlacementUnit[];

export function rotateBlueprintOffset(
  x: number,
  z: number,
  rotation: BuildRotation,
): { x: number; z: number } {
  switch (rotation) {
    case 0:
      return { x, z };
    case 90:
      return { x: -z, z: x };
    case 180:
      return { x: -x, z: -z };
    case 270:
      return { x: z, z: -x };
  }
}

export function blueprintWorldPosition(
  relative: BlueprintBlock,
  origin: BuildOrigin,
  rotation: BuildRotation,
): Vec3 {
  const horizontal = rotateBlueprintOffset(relative.x, relative.z, rotation);
  return new Vec3(
    origin.originX + horizontal.x,
    origin.originY + relative.y,
    origin.originZ + horizontal.z,
  );
}

/**
 * Read a build site without allocating an unbounded issue list. Both legacy
 * flat cells and modern placement units are accepted; legacy cells normalize
 * to one ordinary material use and one expected world cell in memory.
 */
export function analyzeBuildSite(
  bot: Bot,
  input: BuildSiteInput,
  origin: BuildOrigin,
  rotation: BuildRotation,
  options: BuildSiteAnalysisOptions = {},
): BuildSiteAnalysis {
  const units = toPlacementUnits(input);
  const maxIssueSamples = boundedIssueSamples(options.maxIssueSamples);
  const issues: BuildSiteIssue[] = [];
  const issueCounts: BuildSiteIssueCounts = {
    blocked: 0,
    unloaded: 0,
    unsupported: 0,
  };
  const minimumAnchorY = minimumAnchorYFor(units);
  let correctWorldCells = 0;
  let pendingWorldCells = 0;
  let correctPlacementUnits = 0;
  let pendingPlacementUnits = 0;

  for (const unit of units) {
    let unitCorrect = unit.expectedCells.length > 0;
    let unitPending = false;
    for (const expected of unit.expectedCells) {
      const position = blueprintWorldPosition(expected, origin, rotation);
      const current = bot.blockAt(position);
      if (!current) {
        unitCorrect = false;
        recordIssue(issues, issueCounts, maxIssueSamples, {
          kind: "unloaded",
          position: vector(position),
          expected: expected.block,
          found: null,
        });
        continue;
      }
      // A name match is not enough for a compiler-vetted placement hint. The
      // live verifier applies the hint only to the placement anchor, because
      // secondary cells of a future multi-cell unit can legitimately have a
      // different state. Keep this preflight comparison equivalent so a stair
      // facing the wrong way is never treated as already built (or allowed to
      // reach material preparation).
      const hint = isAnchorCell(expected, unit.anchor) ? placementHintFor(unit) : undefined;
      if (current.name === expected.block && matchesPlacementHint(current, hint, rotation)) {
        correctWorldCells++;
        continue;
      }

      unitCorrect = false;
      if (!REPLACEABLE_BUILD_BLOCKS.has(current.name)) {
        recordIssue(issues, issueCounts, maxIssueSamples, {
          kind: "blocked",
          position: vector(position),
          expected: expected.block,
          found: current.name,
        });
        continue;
      }

      pendingWorldCells++;
      unitPending = true;
      // Only the actual placement anchor needs a direct support check. Extra
      // expected cells of a future multi-cell item (for example a door top)
      // are verified independently but must not be mistaken for a second item
      // placement that needs its own support face.
      if (!isAnchorCell(expected, unit.anchor) || unit.anchor.y !== minimumAnchorY) continue;
      const below = bot.blockAt(position.offset(0, -1, 0));
      if (
        !below ||
        REPLACEABLE_BUILD_BLOCKS.has(below.name) ||
        below.boundingBox === "empty"
      ) {
        recordIssue(issues, issueCounts, maxIssueSamples, {
          kind: below ? "unsupported" : "unloaded",
          position: vector(position),
          expected: expected.block,
          found: below?.name ?? null,
        });
      }
    }
    if (unitCorrect) correctPlacementUnits++;
    if (unitPending) pendingPlacementUnits++;
  }

  const issueTotal = issueCounts.blocked + issueCounts.unloaded + issueCounts.unsupported;
  return {
    safe: issueTotal === 0,
    // Preserve the original cell-oriented names for existing callers.
    correct: correctWorldCells,
    pending: pendingWorldCells,
    placementUnitCount: units.length,
    worldCellCount: countExpectedWorldCells(units),
    correctPlacementUnits,
    pendingPlacementUnits,
    correctWorldCells,
    pendingWorldCells,
    issueCounts,
    issues,
  };
}

export function findNearbyBuildSites(
  bot: Bot,
  input: BuildSiteInput,
  origin: BuildOrigin,
  rotation: BuildRotation,
  radius = 4,
  limit = 5,
): Array<BuildOrigin & { distance: number }> {
  const candidates: Array<BuildOrigin & { distance: number }> = [];
  const offsets: Array<{ x: number; z: number; distance: number }> = [];
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      if (x === 0 && z === 0) continue;
      offsets.push({ x, z, distance: Math.hypot(x, z) });
    }
  }
  offsets.sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z);
  for (const offset of offsets) {
    const candidate = {
      originX: origin.originX + offset.x,
      originY: origin.originY,
      originZ: origin.originZ + offset.z,
      distance: offset.distance,
    };
    // Nearby-origin selection needs only `safe`, so avoid allocating a sample
    // for every rejected candidate while retaining the exact internal totals.
    if (analyzeBuildSite(bot, input, candidate, rotation, { maxIssueSamples: 0 }).safe) {
      candidates.push(candidate);
      if (candidates.length >= limit) break;
    }
  }
  return candidates;
}

function toPlacementUnits(input: BuildSiteInput): readonly BlueprintPlacementUnit[] {
  if (input.length === 0) return [];
  const first = input[0]!;
  return "expectedCells" in first
    ? input as readonly BlueprintPlacementUnit[]
    : normalizeBlueprintPlacementUnits(input as readonly BlueprintBlock[]);
}

function minimumAnchorYFor(units: readonly BlueprintPlacementUnit[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const unit of units) {
    minimum = Math.min(minimum, unit.anchor.y);
  }
  return minimum;
}

function isAnchorCell(cell: BlueprintBlock, anchor: BlueprintBlock): boolean {
  return cell.x === anchor.x && cell.y === anchor.y && cell.z === anchor.z;
}

/**
 * Unit-level hints are the durable placement contract. Keep the anchor
 * fallback for in-memory legacy callers, matching construction verification.
 */
function placementHintFor(unit: BlueprintPlacementUnit): PlacementHint | undefined {
  return unit.hint ?? unit.anchor.hint;
}

/**
 * Compare the observable state contract without importing `verifier.ts`:
 * verifier already depends on this site module for world coordinates and
 * replaceability. Missing or unreadable properties deliberately fail a
 * hinted comparison closed.
 */
function matchesPlacementHint(
  block: { getProperties?: () => unknown },
  hint: PlacementHint | undefined,
  rotation: BuildRotation,
): boolean {
  if (!hint) return true;
  const properties = readBlockProperties(block);
  return (hint.facing === undefined || properties.facing === rotateFacing(hint.facing, rotation)) &&
    (hint.half === undefined || properties.half === hint.half);
}

function rotateFacing(facing: Cardinal, rotation: BuildRotation): Cardinal {
  const turns = rotation / 90;
  const cardinals: readonly Cardinal[] = ["north", "east", "south", "west"];
  const index = cardinals.indexOf(facing);
  return cardinals[(index + turns) % cardinals.length]!;
}

function readBlockProperties(block: { getProperties?: () => unknown }): Readonly<Record<string, unknown>> {
  let candidate: unknown;
  try {
    candidate = block.getProperties?.();
  } catch {
    return {};
  }
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? candidate as Readonly<Record<string, unknown>>
    : {};
}

function boundedIssueSamples(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BUILD_SITE_ISSUE_SAMPLES;
  if (!Number.isFinite(value)) return DEFAULT_BUILD_SITE_ISSUE_SAMPLES;
  return Math.min(MAX_BUILD_SITE_ISSUE_SAMPLES, Math.max(0, Math.floor(value)));
}

function recordIssue(
  issues: BuildSiteIssue[],
  counts: BuildSiteIssueCounts,
  maximum: number,
  issue: BuildSiteIssue,
): void {
  counts[issue.kind]++;
  if (issues.length < maximum) issues.push(issue);
}

function vector(position: Vec3): { x: number; y: number; z: number } {
  return { x: position.x, y: position.y, z: position.z };
}
