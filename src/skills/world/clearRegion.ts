import { Vec3 } from "vec3";
import { z } from "zod";
import { digAt } from "../../world/blockExecutor.js";
import {
  isAirSnapshot,
  snapshotBlock,
  type BlockSnapshot,
} from "../../world/blockSnapshot.js";
import type { BlockMutationResult, BlockPosition } from "../../world/types.js";
import { defineSkill, type SkillContext, type SkillResult } from "../types.js";
import { collectNewDrops, nearbyDropIds, type DropPickupReport } from "./dropPickup.js";
import {
  beginWorldJournal,
  cancelWorldJournal,
  completeWorldJournal,
  createJournalMutation,
  isStartedWorldJournal,
  preflightWorldJournal,
  transactionDetails,
  type WorldSkillDependencies,
} from "./journal.js";

const coordinate = z.number().finite().int().min(-30_000_000).max(30_000_000);
const verticalCoordinate = z.number().finite().int().min(-64).max(320);
const positionSchema = z.object({ x: coordinate, y: verticalCoordinate, z: coordinate });
const blockName = z.string().trim().min(1).max(128).regex(/^[a-z0-9_:-]+$/, "must be a canonical block name");
const MAX_REGION_VOLUME = 4_096n;
const MAX_UNAVAILABLE_SAMPLES = 20;

interface ClearCounts {
  scanned: number;
  candidates: number;
  confirmed: number;
  air: number;
  preserved: number;
  containers: number;
  undiggable: number;
  pickupObserved: number;
  pickupApproached: number;
  pickupUnreachable: number;
}

interface Candidate {
  readonly position: BlockPosition;
  readonly before: BlockSnapshot;
}

interface RawBlock {
  readonly blockEntity?: unknown;
  readonly entity?: unknown;
}

/**
 * A bounded top-down demolition action. It has no hidden confirmation: owner
 * authority is verified at the tool/engine boundary. The only preconditions
 * here are concrete coordinates, loaded world data, policy-selected container
 * behavior, and a journal/budget that can represent every candidate.
 */
export function createClearRegionSkill(deps: WorldSkillDependencies) {
  return defineSkill({
    name: "clearRegion",
    policy: { minimumRole: "owner", effect: "destructive", reversible: true, mission: "public" },
    longRunning: true,
    description:
      "Clear an inclusive bounded rectangular region top-down. By default it preserves containers and block entities; set includeContainers only when the owner explicitly includes them.",
    params: z.object({
      from: positionSchema.describe("One inclusive corner of the region."),
      to: positionSchema.describe("The other inclusive corner of the region."),
      includeContainers: z.boolean().default(false).describe("Include containers and block-entity blocks only when explicitly requested."),
      preserve: z.array(blockName).max(64).default([]).describe("Exact canonical block names to leave unchanged."),
      collectDrops: z.boolean().default(true).describe("Make a bounded best-effort pickup attempt for newly observed drops."),
      label: z.string().trim().min(1).max(256).optional().describe("Optional journal label for this bounded demolition."),
    }),
    async run({ from, to, includeContainers, preserve, collectDrops, label }, ctx) {
      const bounds = normalizeBounds(from, to);
      const volume = inclusiveVolume(bounds);
      if (volume > MAX_REGION_VOLUME) {
        return {
          ok: false,
          summary: `region contains ${volume.toString()} blocks; the maximum is ${MAX_REGION_VOLUME.toString()}`,
          code: "AREA_UNSAFE",
          recoverable: false,
          details: { bounds, volume: volume.toString(), maximum: Number(MAX_REGION_VOLUME) },
        };
      }
      if (ctx.signal.aborted) return interruptedBeforeJournal(bounds, emptyCounts());

      const preserveNames = new Set(preserve.map((name) => name.toLowerCase()));
      const scanned = scanRegion(ctx, bounds, preserveNames, includeContainers);
      if ("result" in scanned) return scanned.result;
      const { candidates, counts } = scanned;

      const journal = beginWorldJournal(deps, ctx, {
        kind: "clear-region",
        label: label ?? `clear ${formatBounds(bounds)}`,
      });
      if (!isStartedWorldJournal(journal)) return journal;
      const preflight = preflightWorldJournal(deps, journal, ctx, candidates.length);
      if (preflight) return withCounts(preflight, counts, candidates.length);

      for (const [ordinal, candidate] of candidates.entries()) {
        if (ctx.signal.aborted) {
          const transaction = cancelWorldJournal(deps, journal, "clearRegion interrupted before the next dig");
          return interruptedAfterJournal(bounds, counts, transactionDetails(transaction), candidates.length);
        }
        const dropIds = collectDrops ? nearbyDropIds(ctx.bot, candidate.position) : undefined;
        const mutation = createJournalMutation(deps, journal, ctx, ordinal);
        const result = await digAt(ctx.bot as never, {
          position: candidate.position,
          signal: ctx.signal,
          expected: candidate.before,
          hooks: mutation.hooks,
        });
        const confirmed = isConfirmedDig(result);
        if (confirmed) {
          counts.confirmed++;
          ctx.reportProgress(`clearRegion confirmed ${counts.confirmed}/${candidates.length} at ${formatPosition(candidate.position)}`);
        }
        if (result.ok && collectDrops && dropIds) {
          const pickup = await collectNewDrops(ctx, candidate.position, dropIds);
          addPickupCounts(counts, pickup);
        }
        if (!result.ok) {
          const transaction = cancelWorldJournal(deps, journal, result.summary);
          return failedDuringClear(result, bounds, counts, candidates.length, transactionDetails(transaction));
        }
      }

      let transaction;
      try {
        transaction = completeWorldJournal(deps, journal);
      } catch (error) {
        transaction = cancelWorldJournal(deps, journal, `clearRegion journal completion failed: ${errorMessage(error)}`);
        return {
          ok: false,
          summary: "cleared the requested blocks, but their journal could not be completed safely",
          code: "UNKNOWN",
          recoverable: true,
          details: resultDetails(bounds, counts, candidates.length, transactionDetails(transaction)),
        };
      }
      return {
        ok: true,
        summary: summaryForClear(bounds, counts, candidates.length),
        details: resultDetails(bounds, counts, candidates.length, transactionDetails(transaction)),
        data: resultDetails(bounds, counts, candidates.length, transactionDetails(transaction)),
      };
    },
  });
}

function scanRegion(
  ctx: SkillContext,
  bounds: Bounds,
  preserve: ReadonlySet<string>,
  includeContainers: boolean,
): { candidates: Candidate[]; counts: ClearCounts } | { result: SkillResult } {
  const counts = emptyCounts();
  const candidates: Candidate[] = [];
  const unavailable: BlockPosition[] = [];
  for (let y = bounds.max.y; y >= bounds.min.y; y--) {
    for (let z = bounds.min.z; z <= bounds.max.z; z++) {
      for (let x = bounds.min.x; x <= bounds.max.x; x++) {
        if (ctx.signal.aborted) {
          return { result: interruptedBeforeJournal(bounds, counts) };
        }
        const position = Object.freeze({ x, y, z });
        let raw: ReturnType<SkillContext["bot"]["blockAt"]>;
        try {
          raw = ctx.bot.blockAt(new Vec3(x, y, z));
        } catch {
          raw = null;
        }
        if (!raw) {
          if (unavailable.length < MAX_UNAVAILABLE_SAMPLES) unavailable.push(position);
          continue;
        }
        counts.scanned++;
        const snapshot = snapshotBlock(raw, position);
        if (isAirSnapshot(snapshot)) {
          counts.air++;
          continue;
        }
        if (preserve.has(snapshot.name.toLowerCase())) {
          counts.preserved++;
          continue;
        }
        if (!includeContainers && isContainerOrBlockEntity(raw as unknown as RawBlock, snapshot)) {
          counts.containers++;
          continue;
        }
        if (!snapshot.diggable || snapshot.name === "bedrock" || snapshot.name === "unknown") {
          counts.undiggable++;
          continue;
        }
        candidates.push(Object.freeze({ position, before: snapshot }));
      }
    }
  }
  if (unavailable.length > 0) {
    return {
      result: {
        ok: false,
        summary: `world data is unavailable for ${unavailable.length}${unavailable.length === MAX_UNAVAILABLE_SAMPLES ? "+" : ""} positions in the requested region; nothing was changed`,
        code: "WORLD_UNAVAILABLE",
        recoverable: true,
        details: {
          bounds,
          unavailableCount: unavailable.length,
          unavailableSamples: unavailable,
          scanned: counts.scanned,
        },
      },
    };
  }
  counts.candidates = candidates.length;
  return { candidates, counts };
}

function isContainerOrBlockEntity(raw: RawBlock, snapshot: BlockSnapshot): boolean {
  if (raw.blockEntity !== undefined || raw.entity !== null && raw.entity !== undefined) return true;
  const name = snapshot.name;
  return name.endsWith("_chest") || name === "chest" || name === "barrel" ||
    name.endsWith("_shulker_box") || name === "hopper" || name === "dropper" ||
    name === "dispenser" || name === "furnace" || name === "smoker" ||
    name === "blast_furnace" || name === "brewing_stand" || name === "crafter" ||
    name === "chiseled_bookshelf" || name === "lectern" || name === "beehive" ||
    name === "bee_nest" || name === "decorated_pot" || name === "ender_chest";
}

interface Bounds {
  readonly min: BlockPosition;
  readonly max: BlockPosition;
}

function normalizeBounds(from: BlockPosition, to: BlockPosition): Bounds {
  return Object.freeze({
    min: Object.freeze({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) }),
    max: Object.freeze({ x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) }),
  });
}

function inclusiveVolume(bounds: Bounds): bigint {
  return BigInt(bounds.max.x - bounds.min.x + 1) *
    BigInt(bounds.max.y - bounds.min.y + 1) *
    BigInt(bounds.max.z - bounds.min.z + 1);
}

function emptyCounts(): ClearCounts {
  return {
    scanned: 0,
    candidates: 0,
    confirmed: 0,
    air: 0,
    preserved: 0,
    containers: 0,
    undiggable: 0,
    pickupObserved: 0,
    pickupApproached: 0,
    pickupUnreachable: 0,
  };
}

function addPickupCounts(counts: ClearCounts, pickup: DropPickupReport): void {
  counts.pickupObserved += pickup.observed;
  counts.pickupApproached += pickup.approached;
  counts.pickupUnreachable += pickup.unreachable;
}

function isConfirmedDig(result: BlockMutationResult): boolean {
  return result.after !== undefined && result.before !== undefined && result.after.key !== result.before.key;
}

function interruptedBeforeJournal(bounds: Bounds, counts: ClearCounts): SkillResult {
  return {
    ok: false,
    summary: "clearRegion interrupted before any mutation was started",
    code: "INTERRUPTED",
    recoverable: true,
    details: resultDetails(bounds, counts, 0),
  };
}

function interruptedAfterJournal(
  bounds: Bounds,
  counts: ClearCounts,
  transaction: Record<string, unknown> | undefined,
  candidates: number,
): SkillResult {
  return {
    ok: false,
    summary: `clearRegion interrupted after ${counts.confirmed}/${candidates} confirmed digs`,
    code: "INTERRUPTED",
    recoverable: true,
    details: resultDetails(bounds, counts, candidates, transaction),
  };
}

function failedDuringClear(
  result: BlockMutationResult,
  bounds: Bounds,
  counts: ClearCounts,
  candidates: number,
  transaction: Record<string, unknown> | undefined,
): SkillResult {
  return {
    ok: false,
    summary: `clearRegion stopped after ${counts.confirmed}/${candidates} confirmed digs: ${result.summary}`,
    code: result.code ?? "UNKNOWN",
    recoverable: result.recoverable ?? true,
    details: {
      ...resultDetails(bounds, counts, candidates, transaction),
      failedPosition: result.before?.position,
      failure: result.details,
    },
  };
}

function withCounts(result: SkillResult, counts: ClearCounts, candidates: number): SkillResult {
  return {
    ...result,
    details: {
      ...(result.details ?? {}),
      counts,
      candidates,
    },
  };
}

function resultDetails(
  bounds: Bounds,
  counts: ClearCounts,
  candidates: number,
  transaction?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    bounds,
    candidates,
    counts: { ...counts },
    ...(transaction === undefined ? {} : { transaction }),
  };
}

function summaryForClear(bounds: Bounds, counts: ClearCounts, candidates: number): string {
  return `cleared ${counts.confirmed}/${candidates} blocks in ${formatBounds(bounds)} ` +
    `(skipped air=${counts.air}, preserved=${counts.preserved}, containers=${counts.containers}, undiggable=${counts.undiggable})`;
}

function formatBounds(bounds: Bounds): string {
  return `${formatPosition(bounds.min)}..${formatPosition(bounds.max)}`;
}

function formatPosition(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
