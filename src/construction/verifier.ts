import type { Bot } from "mineflayer";
import {
  countExpectedWorldCells,
  normalizeBlueprintPlacementUnits,
  type BlueprintBlock,
  type BlueprintPlacementUnit,
} from "./store.js";
import {
  blueprintWorldPosition,
  REPLACEABLE_BUILD_BLOCKS,
  type BuildOrigin,
  type BuildRotation,
} from "./site.js";
import type { Cardinal, PlacementHint } from "./buildOps/types.js";

/** A full construction scan yields between deterministic bounded batches. */
export const DEFAULT_BUILD_VERIFICATION_BATCH_SIZE = 128;
export const MAX_BUILD_VERIFICATION_BATCH_SIZE = 512;
export const DEFAULT_BUILD_VERIFICATION_ISSUE_SAMPLES = 32;
export const MAX_BUILD_VERIFICATION_ISSUE_SAMPLES = 64;

export type BuildVerificationIssueKind =
  | "missing"
  | "conflicting"
  | "unloaded"
  | "state-mismatched";

export interface BuildVerificationIssue {
  kind: BuildVerificationIssueKind;
  /** Stable placement-unit order, useful only for an internal repair pass. */
  unitIndex: number;
  expectedCellIndex: number;
  position: { x: number; y: number; z: number };
  expected: string;
  found: string | null;
}

export interface BuildVerificationIssueCounts {
  missing: number;
  conflicting: number;
  unloaded: number;
  stateMismatched: number;
}

/**
 * Serializable comparison result. Counters cover the scanned prefix when
 * `complete` is false; `checkedWorldCells` makes that distinction explicit.
 */
export interface BuildVerificationReport {
  complete: boolean;
  interrupted: boolean;
  matches: boolean;
  placementUnitCount: number;
  expectedWorldCellCount: number;
  checkedPlacementUnits: number;
  checkedWorldCells: number;
  /** Units for which every expected world cell currently matches. */
  correctPlacementUnits: number;
  /** Fully scanned units with one or more nonmatching/unloaded expected cells. */
  mismatchedPlacementUnits: number;
  /** Cells whose current block name already matches the expected cell. */
  correct: number;
  /** A pure verification pass never mutates; execution reports repairs itself. */
  repaired: number;
  missing: number;
  conflicting: number;
  unloaded: number;
  /** Same-name cells whose verified hinted state does not match. */
  stateMismatched: number;
  issueCounts: BuildVerificationIssueCounts;
  /** Bounded deterministic sample, never an unbounded repair worklist. */
  issues: BuildVerificationIssue[];
}

export interface VerifyBlueprintWorldOptions {
  signal?: AbortSignal;
  /** Clamp to 1..512 so a large generated blueprint stays cooperative. */
  batchSize?: number;
  /** Clamp to 0..64; totals remain exact in `issueCounts`. */
  maxIssueSamples?: number;
  /** Injectable for deterministic tests and alternate runtime schedulers. */
  yield?: () => Promise<void>;
}

export type BlueprintVerificationInput =
  | readonly BlueprintBlock[]
  | readonly BlueprintPlacementUnit[];

/**
 * Compare all expected cells to the live world in stable unit/cell order.
 *
 * Ordinary cells compare block names. A placement unit with a durable state
 * hint additionally compares its observable `facing` and/or `half` state.
 * Facing is local to the blueprint, so it rotates with the requested build
 * rotation before being compared to the live Mineflayer block properties.
 */
export async function verifyBlueprintWorld(
  bot: Pick<Bot, "blockAt">,
  input: BlueprintVerificationInput,
  origin: BuildOrigin,
  rotation: BuildRotation,
  options: VerifyBlueprintWorldOptions = {},
): Promise<BuildVerificationReport> {
  const units = toPlacementUnits(input);
  const batchSize = boundedBatchSize(options.batchSize);
  const maxIssueSamples = boundedIssueSamples(options.maxIssueSamples);
  const yieldControl = options.yield ?? yieldToEventLoop;
  const signal = options.signal;
  const report = createReport(units);
  let cellsInBatch = 0;

  for (const [unitIndex, unit] of units.entries()) {
    let unitComplete = true;
    for (const [expectedCellIndex, expected] of unit.expectedCells.entries()) {
      if (signal?.aborted) return finishInterrupted(report);

      const position = blueprintWorldPosition(expected, origin, rotation);
      const current = bot.blockAt(position);
      report.checkedWorldCells++;
      cellsInBatch++;
      if (!current) {
        unitComplete = false;
        recordIssue(report, maxIssueSamples, {
          kind: "unloaded",
          unitIndex,
          expectedCellIndex,
          position: vector(position),
          expected: expected.block,
          found: null,
        });
      } else if (current.name === expected.block) {
        // A state hint describes the item-placement anchor. Future multi-cell
        // items can have different state on their secondary cells (for
        // example a door's upper half), so never copy the anchor expectation
        // onto every expected cell.
        const hint = isAnchorCell(expected, unit.anchor) ? placementHintFor(unit) : undefined;
        if (hint && !matchesPlacementHint(current, hint, rotation)) {
          unitComplete = false;
          recordIssue(report, maxIssueSamples, {
            kind: "state-mismatched",
            unitIndex,
            expectedCellIndex,
            position: vector(position),
            expected: expected.block,
            found: current.name,
          });
        } else {
          report.correct++;
        }
      } else if (REPLACEABLE_BUILD_BLOCKS.has(current.name)) {
        unitComplete = false;
        recordIssue(report, maxIssueSamples, {
          kind: "missing",
          unitIndex,
          expectedCellIndex,
          position: vector(position),
          expected: expected.block,
          found: current.name,
        });
      } else {
        unitComplete = false;
        recordIssue(report, maxIssueSamples, {
          kind: "conflicting",
          unitIndex,
          expectedCellIndex,
          position: vector(position),
          expected: expected.block,
          found: current.name,
        });
      }

      if (cellsInBatch >= batchSize) {
        cellsInBatch = 0;
        await yieldControl();
        if (signal?.aborted) return finishInterrupted(report);
      }
    }
    report.checkedPlacementUnits++;
    // The public report is cell-oriented. Unit completion is intentionally
    // derivable from the cells today, but retaining the counter helps later
    // multi-cell item support without changing the persisted schema.
    if (unitComplete) report.correctPlacementUnits++;
    else report.mismatchedPlacementUnits++;
  }

  report.complete = true;
  report.matches = totalIssues(report.issueCounts) === 0;
  return report;
}

function createReport(units: readonly BlueprintPlacementUnit[]): BuildVerificationReport {
  return {
    complete: false,
    interrupted: false,
    matches: false,
    placementUnitCount: units.length,
    expectedWorldCellCount: countExpectedWorldCells(units),
    checkedPlacementUnits: 0,
    checkedWorldCells: 0,
    correctPlacementUnits: 0,
    mismatchedPlacementUnits: 0,
    correct: 0,
    repaired: 0,
    missing: 0,
    conflicting: 0,
    unloaded: 0,
    stateMismatched: 0,
    issueCounts: {
      missing: 0,
      conflicting: 0,
      unloaded: 0,
      stateMismatched: 0,
    },
    issues: [],
  };
}

function finishInterrupted(report: BuildVerificationReport): BuildVerificationReport {
  report.interrupted = true;
  report.matches = false;
  return report;
}

function recordIssue(
  report: BuildVerificationReport,
  maximum: number,
  issue: BuildVerificationIssue,
): void {
  switch (issue.kind) {
    case "missing":
      report.missing++;
      report.issueCounts.missing++;
      break;
    case "conflicting":
      report.conflicting++;
      report.issueCounts.conflicting++;
      break;
    case "unloaded":
      report.unloaded++;
      report.issueCounts.unloaded++;
      break;
    case "state-mismatched":
      report.stateMismatched++;
      report.issueCounts.stateMismatched++;
      break;
  }
  if (report.issues.length < maximum) report.issues.push(issue);
}

function toPlacementUnits(input: BlueprintVerificationInput): readonly BlueprintPlacementUnit[] {
  if (input.length === 0) return [];
  const first = input[0]!;
  return "expectedCells" in first
    ? input as readonly BlueprintPlacementUnit[]
    : normalizeBlueprintPlacementUnits(input as readonly BlueprintBlock[]);
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_BUILD_VERIFICATION_BATCH_SIZE;
  return Math.min(MAX_BUILD_VERIFICATION_BATCH_SIZE, Math.max(1, Math.floor(value)));
}

function boundedIssueSamples(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_BUILD_VERIFICATION_ISSUE_SAMPLES;
  return Math.min(MAX_BUILD_VERIFICATION_ISSUE_SAMPLES, Math.max(0, Math.floor(value)));
}

function totalIssues(counts: BuildVerificationIssueCounts): number {
  return counts.missing + counts.conflicting + counts.unloaded + counts.stateMismatched;
}

/**
 * Unit-level hints are the durable placement contract. The anchor fallback
 * keeps manually assembled in-memory units compatible with normalized legacy
 * cells, which carry the same hint on both fields.
 */
function placementHintFor(unit: BlueprintPlacementUnit): PlacementHint | undefined {
  return unit.hint ?? unit.anchor.hint;
}

function isAnchorCell(cell: BlueprintBlock, anchor: BlueprintBlock): boolean {
  return cell.x === anchor.x && cell.y === anchor.y && cell.z === anchor.z;
}

function matchesPlacementHint(
  block: { getProperties?: () => unknown },
  hint: PlacementHint,
  rotation: BuildRotation,
): boolean {
  const properties = readBlockProperties(block);
  return (hint.facing === undefined || properties.facing === rotateFacing(hint.facing, rotation)) &&
    (hint.half === undefined || properties.half === hint.half);
}

/** Rotate a local blueprint cardinal clockwise around Y into world facing. */
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

function vector(position: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: position.x, y: position.y, z: position.z };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
