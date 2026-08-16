import { z } from "zod";
import { Vec3 } from "vec3";
import type { DB } from "../../memory/db.js";
import {
  countExpectedWorldCells,
  countPlacementUnitMaterials,
  getBlueprint,
  getBlueprintSource,
  getConstructionJob,
  setConstructionStatusIfCurrent,
  updateConstructionProgressIfCurrent,
  type BlueprintBlock,
  type BlueprintPlacementUnit,
  type ConstructionJobRow,
  type ConstructionStatus,
} from "../../construction/store.js";
import { assertCurrentConstructionSourceAccess } from "../../construction/sourceAccess.js";
import { placeBuildPlacement } from "../../construction/placementAdapter.js";
import { verifyBlueprintWorld, type BuildVerificationReport } from "../../construction/verifier.js";
import { AIR_BLOCKS, blueprintWorldPosition, REPLACEABLE_BUILD_BLOCKS } from "../../construction/site.js";
import type { Cardinal, PlacementHint } from "../../construction/buildOps/types.js";
import { snapshotBlock, type BlockSnapshot } from "../../world/blockSnapshot.js";
import {
  digAt,
  type BlockMutationConflict,
  type BlockMutationEvent,
  type BlockMutationFailure,
  type BlockMutationHookFailure,
  type BlockMutationHooks,
} from "../../world/blockExecutor.js";
import type { BlockMutationResult } from "../../world/types.js";
import type { WorldTransactionService } from "../../world/transactions/service.js";
import type { WorldTransactionDetail } from "../../world/transactions/types.js";
import { UnresolvedConstructionAttemptError } from "../../world/transactions/store.js";
import { countInInventory } from "../helpers.js";
import { retrieveItem } from "../resources/retrieveItem.js";
import { defineSkill, type SkillContext, type SkillDefinition, type SkillResult } from "../types.js";

/** Blocks that are never executable through the ordinary survival builder. */
export const UNSAFE_BLUEPRINT_BLOCKS = new Set([
  "air",
  "bedrock",
  "command_block",
  "chain_command_block",
  "repeating_command_block",
  "structure_block",
  "jigsaw",
  "barrier",
  "light",
  "end_portal",
  "end_portal_frame",
  "nether_portal",
  "fire",
  "soul_fire",
  "lava",
  "water",
]);

const params = z.object({
  jobId: z.number().int().positive(),
});

/** A full build/repair scan yields at this deterministic cadence. */
export const BUILD_EXECUTION_BATCH_SIZE = 128;
/** One repair pass is intentionally bounded; it never turns into a retry loop. */
export const MAX_BUILD_REPAIR_UNITS = 128;

const SCAFFOLD_BLOCKS = ["dirt", "cobblestone"] as const;
const MAX_SCAFFOLD_HEIGHT = 6;

// Mutation ordinals must remain stable across retries of one construction
// attempt. The compiler/store cap is 4,096 placement units, so disjoint fixed
// ranges leave no collision between normal work, repair, and temporary support.
const MAX_PLACEMENT_UNITS = 4_096;
const PRIMARY_ORDINAL_BASE = 0;
const REPAIR_ORDINAL_BASE = PRIMARY_ORDINAL_BASE + MAX_PLACEMENT_UNITS;
const PRIMARY_SCAFFOLD_ORDINAL_BASE = REPAIR_ORDINAL_BASE + MAX_PLACEMENT_UNITS;
const SCAFFOLD_ORDINALS_PER_UNIT = MAX_SCAFFOLD_HEIGHT * 2;
const REPAIR_SCAFFOLD_ORDINAL_BASE =
  PRIMARY_SCAFFOLD_ORDINAL_BASE + MAX_PLACEMENT_UNITS * SCAFFOLD_ORDINALS_PER_UNIT;

export interface BuildBlueprintDependencies {
  readonly db: DB;
  /** Required durable journal: construction never has an unjournaled mutation path. */
  readonly transactions: WorldTransactionService;
  readonly serverKey: string;
  /** Used to reauthorize source-backed blueprints immediately before clicks. */
  readonly ownerUsername: string;
  /** Exact configured profile version used to compile/register source-backed designs. */
  readonly configuredVersion: string;
  /**
   * Reads the live Mineflayer version at each source-backed execution boundary.
   * Never substitute the configured profile when this is unavailable.
   */
  readonly getLiveVersion: () => string | undefined;
}

interface PendingUnit {
  readonly unit: BlueprintPlacementUnit;
  readonly unitIndex: number;
  readonly expected: BlueprintBlock;
  readonly position: Vec3;
  readonly hint?: PlacementHint;
}

interface PlannedScaffold {
  readonly block: (typeof SCAFFOLD_BLOCKS)[number];
  readonly positions: readonly Vec3[];
}

interface PlannedUnit extends PendingUnit {
  readonly scaffold?: PlannedScaffold;
}

interface TargetScan {
  readonly correctWorldCells: number;
  readonly pending: readonly PendingUnit[];
  readonly totalWorldCells: number;
}

interface ExecutionPlan {
  readonly units: readonly PlannedUnit[];
  readonly mutationCount: number;
}

interface TrackedMutation {
  readonly hooks: BlockMutationHooks;
  readonly hasUncertainPlannedChange: () => boolean;
  /** A controlled early stop after this still represents a partial build attempt. */
  readonly wasApplied: () => boolean;
}

/**
 * A placement may be confirmed even if cancellation or scaffold cleanup makes
 * the enclosing unit fail afterwards. Preserve that fact so durable progress
 * counts the world state, rather than only fully completed loop iterations.
 */
type PlacementExecution =
  | { readonly ok: true; readonly placed: boolean; readonly confirmed: boolean }
  | {
    readonly ok: false;
    readonly placed: boolean;
    readonly confirmed: boolean;
    readonly result: SkillResult;
  };

type ScanResult =
  | { readonly ok: true; readonly scan: TargetScan }
  | { readonly ok: false; readonly result: SkillResult };

type PlanResult =
  | { readonly ok: true; readonly plan: ExecutionPlan }
  | { readonly ok: false; readonly result: SkillResult };

type RepairScanResult =
  | {
    readonly ok: true;
    readonly candidates: readonly PendingUnit[];
    readonly missing: number;
    readonly conflicting: number;
    readonly unloaded: number;
    readonly stateMismatched: number;
  }
  | { readonly ok: false; readonly result: SkillResult };

/**
 * Execute one registered construction job using normal player inventory clicks.
 *
 * There is deliberately no `buildBlueprint(db)` fallback: every placement and
 * temporary scaffold mutation belongs to a journaled construction attempt.
 */
export function buildBlueprint(
  deps: BuildBlueprintDependencies,
): SkillDefinition<z.infer<typeof params>> {
  const { db } = deps;
  const retrieve = retrieveItem(db);

  return defineSkill({
    name: "buildBlueprint",
    policy: { minimumRole: "operator", effect: "world-change", reversible: true, mission: "internal" },
    description:
      "Build a registered bounded blueprint through verified inventory placement. " +
      "Every mutation is journaled, then the full target is compared before completion.",
    params,
    longRunning: true,
    async run({ jobId }, ctx) {
      let job = getConstructionJob(db, jobId);
      if (!job) return missingJob(jobId);
      if (job.status === "cancelled") {
        return failure(
          "TARGET_UNAVAILABLE",
          `construction job ${jobId} is cancelled`,
          false,
          { jobId },
        );
      }

      const blueprint = getBlueprint(db, job.blueprintId);
      if (!blueprint) {
        return failure(
          "NOT_CONFIGURED",
          `construction job ${jobId} has no blueprint`,
          false,
          { jobId },
        );
      }

      // Check exact durable ownership before any validation path can write a
      // status. In particular, a direct skill invocation must never block a
      // scheduled job merely because it is in the wrong dimension.
      if (!jobBelongsToExecution(job, ctx.execution.planId)) {
        return failure(
          "TARGET_UNAVAILABLE",
          `construction job ${jobId} is not owned by this execution context`,
          true,
          {
            jobId,
            expectedPlanId: job.lastPlanId,
            ...(ctx.execution.planId === undefined ? { currentPlanId: null } : { currentPlanId: ctx.execution.planId }),
          },
        );
      }

      const dimension = ctx.bot.game?.dimension?.trim();
      if (!dimension) {
        return blockWithoutMutation(db, job, ctx, failure(
          "WORLD_UNAVAILABLE",
          "the current Minecraft dimension is unavailable; construction did not start",
          true,
          { jobId, expectedDimension: job.dimension },
        ));
      }
      if (dimension !== job.dimension) {
        return blockWithoutMutation(db, job, ctx, failure(
          "TARGET_UNAVAILABLE",
          `build ${jobId} is in ${job.dimension} but bot is in ${dimension}`,
          true,
          { jobId, expectedDimension: job.dimension, currentDimension: dimension },
        ));
      }
      // A task-engine scheduled job is already running; focused/direct callers
      // begin as pending. Never revive paused/cancelled work here.
      const started = setConstructionStatusIfCurrent(db, {
        jobId,
        status: "running",
        expectedStatuses: ["pending", "running", "blocked", "failed"],
        ...(ctx.execution.planId === undefined
          ? { expectedNoPlan: true as const }
          : { expectedPlanId: ctx.execution.planId }),
      });
      if (!started) return inactiveAttempt(db, jobId, ctx.execution.planId);
      job = getConstructionJob(db, jobId) ?? job;
      // Re-read after the conditional transition. A scheduler can link a plan
      // between the first ownership check and this write; never let a direct
      // invocation continue under a NULL-plan journal in that interleaving.
      if (!jobBelongsToExecution(job, ctx.execution.planId)) {
        return inactiveAttempt(db, jobId, ctx.execution.planId);
      }

      const activeCondition = {
        jobId,
        expectedStatuses: ["running"] as const,
        ...(ctx.execution.planId === undefined
          ? { expectedNoPlan: true as const }
          : { expectedPlanId: ctx.execution.planId }),
      };
      const totalWorldCells = countExpectedWorldCells(blueprint.placementUnits);
      let journal: WorldTransactionDetail | undefined;
      const tracked: TrackedMutation[] = [];
      let resolvedWorldCells = 0;
      let sourceAllowsHazardousBlocks = false;

      const assertLiveSourceAccess = (): SkillResult | undefined => {
        try {
          const sourceBacked = getBlueprintSource(db, blueprint.id) !== undefined;
          let liveVersion: string | undefined;
          if (sourceBacked) {
            liveVersion = deps.getLiveVersion();
            if (typeof liveVersion !== "string" || liveVersion.trim().length === 0) {
              throw new Error("the live Minecraft version is unavailable for this source-backed blueprint");
            }
          }
          const grant = assertCurrentConstructionSourceAccess({
            db,
            ownerUsername: deps.ownerUsername,
            blueprint,
            actor: ctx.execution.actor,
            configuredVersion: deps.configuredVersion,
            ...(liveVersion === undefined ? {} : { liveVersion }),
          });
          sourceAllowsHazardousBlocks = grant?.requiredAccess === "owner";
          return undefined;
        } catch (error) {
          sourceAllowsHazardousBlocks = false;
          return failure(
            "PERMISSION_DENIED",
            `construction execution is no longer authorized: ${errorMessage(error)}`,
            false,
            { jobId, blueprint: blueprint.name },
          );
        }
      };

      const isActive = (): boolean => {
        if (ctx.signal.aborted) return false;
        const current = getConstructionJob(db, jobId);
        return current?.status === "running" &&
          current !== undefined && jobBelongsToExecution(current, ctx.execution.planId);
      };

      const writeProgress = (count: number): boolean => updateConstructionProgressIfCurrent(db, {
        ...activeCondition,
        placedCount: count,
      });

      const markStatus = (status: ConstructionStatus, error?: string): boolean =>
        setConstructionStatusIfCurrent(db, {
          ...activeCondition,
          status,
          ...(error === undefined ? {} : { error }),
        });

      const annotateTransaction = (
        result: SkillResult,
        transaction: WorldTransactionDetail | undefined,
      ): SkillResult => ({
        ...result,
        details: {
          ...result.details,
          ...(transaction === undefined ? {} : { transaction: transactionSummary(transaction) }),
        },
      });

      const unresolvedAttemptFailure = (attempt: WorldTransactionDetail): SkillResult => {
        const planned = attempt.changes.filter((change) => change.status === "planned").length;
        const result = failure(
          "WORLD_UNAVAILABLE",
          `construction job ${jobId} has ${planned} uncertain journaled mutation(s) awaiting reconciliation`,
          true,
          {
            jobId,
            priorPlanId: attempt.taskPlanId,
            pendingChanges: planned,
          },
        );
        markStatus("blocked", result.summary);
        return annotateTransaction(result, attempt);
      };

      const findUnresolvedAttempt = (): SkillResult | undefined => {
        const attempt = deps.transactions.findUnresolvedConstructionAttempt({
          serverKey: deps.serverKey,
          dimension,
          constructionJobId: job.id,
        });
        return attempt === undefined ? undefined : unresolvedAttemptFailure(attempt);
      };

      const finalizeNormalFailure = (result: SkillResult): SkillResult => {
        let terminal: WorldTransactionDetail | undefined;
        if (journal) {
          const uncertain = tracked.some((entry) => entry.hasUncertainPlannedChange());
          const applied = tracked.some((entry) => entry.wasApplied());
          if (uncertain) {
            terminal = deps.transactions.cancel(journal.id, result.summary);
          } else if (applied) {
            // The journal has verified actions, but the requested construction
            // attempt ended early. Preserve that distinction as `partial`
            // instead of letting an all-applied prefix look like a completed
            // whole build.
            terminal = deps.transactions.cancel(journal.id, result.summary);
          } else {
            try {
              terminal = deps.transactions.complete(journal.id);
            } catch {
              terminal = deps.transactions.cancel(journal.id, result.summary);
            }
          }
        }
        writeProgress(resolvedWorldCells);
        markStatus(statusForFailure(result), result.summary);
        return annotateTransaction(result, terminal);
      };

      const beginConstructionJournal = (): WorldTransactionDetail => deps.transactions.beginOrReuseConstructionAttempt({
        serverKey: deps.serverKey,
        dimension,
        constructionJobId: job.id,
        actor: ctx.execution.actor,
        label: `build ${blueprint.name}`,
        ...(ctx.execution.planId === undefined ? {} : { taskPlanId: ctx.execution.planId }),
        ...(budgetScope(ctx.execution) === undefined ? {} : { budgetScope: budgetScope(ctx.execution) }),
        correlation: ctx.execution.missionRunId === undefined
          ? (ctx.execution.transactionCorrelation ?? {})
          : { ...(ctx.execution.transactionCorrelation ?? {}), missionRunId: ctx.execution.missionRunId },
      });

      const finalizeInterrupted = (phase: string): SkillResult => {
        const result = failure(
          "INTERRUPTED",
          `construction job ${jobId} interrupted during ${phase}`,
          true,
          { jobId, blueprint: blueprint.name, placed: resolvedWorldCells, total: totalWorldCells },
        );
        const terminal = journal
          ? deps.transactions.cancel(journal.id, result.summary)
          : undefined;
        writeProgress(resolvedWorldCells);
        // This guarded write only applies when the control plane did not already
        // preserve a paused/cancelled status for the same task plan.
        markStatus("blocked", result.summary);
        return annotateTransaction(result, terminal);
      };

      const createTrackedMutation = (ordinal: number): TrackedMutation => {
        if (!journal) throw new Error("construction mutation requested without an open transaction");
        const source = deps.transactions.createConstructionMutationHooks({
          transactionId: journal.id,
          ordinal,
          maxWorldChanges: ctx.execution.maxWorldChanges,
        });
        let planned = false;
        let terminal = false;
        let applied = false;
        const hooks: BlockMutationHooks = {
          planned: async (event: BlockMutationEvent): Promise<void | BlockMutationHookFailure> => {
            // Recheck immediately before the durable planned row and the
            // subsequent Mineflayer click. Reach/equip/look can all await, so
            // the outer check alone is not a source-access or pause boundary.
            const authorization = ensureMutationAuthorized();
            if (authorization) {
              return Object.freeze({
                ok: false as const,
                code: authorization.code ?? "UNKNOWN",
                summary: authorization.summary,
                recoverable: authorization.recoverable ?? true,
                ...(authorization.details === undefined ? {} : { details: authorization.details }),
              });
            }
            const outcome = await source.planned?.(event);
            if (!isHookFailure(outcome)) planned = true;
            return outcome;
          },
          beforeMutation: async (): Promise<void | BlockMutationHookFailure> => {
            // This is deliberately after the executor's final stale reread and
            // immediately before its Mineflayer call. A pause, role revocation,
            // or live-version mismatch that races journal planning must stop the
            // already-planned row as a failed no-click mutation.
            const authorization = ensureMutationAuthorized();
            if (authorization) {
              return Object.freeze({
                ok: false as const,
                code: authorization.code ?? "UNKNOWN",
                summary: authorization.summary,
                recoverable: authorization.recoverable ?? true,
                ...(authorization.details === undefined ? {} : { details: authorization.details }),
              });
            }
            return undefined;
          },
          applied: async (event: BlockMutationEvent): Promise<void> => {
            await source.applied?.(event);
            terminal = true;
            applied = true;
          },
          conflicted: async (event: BlockMutationConflict): Promise<void> => {
            await source.conflicted?.(event);
            terminal = true;
          },
          failed: async (event: BlockMutationFailure): Promise<void> => {
            await source.failed?.(event);
            terminal = true;
          },
        };
        const entry: TrackedMutation = Object.freeze({
          hooks: Object.freeze(hooks),
          hasUncertainPlannedChange: () => planned && !terminal,
          wasApplied: () => applied,
        });
        tracked.push(entry);
        return entry;
      };

      const ensureMutationAuthorized = (): SkillResult | undefined => {
        // Do not terminalize here: the caller may have just received a verified
        // post-click result and needs to persist its exact progress before the
        // common interruption finalizer changes the job state.
        if (!isActive()) return interruptedResult("execution");
        return assertLiveSourceAccess();
      };

      const place = async (
        unit: PendingUnit,
        ordinal: number,
        item: string,
      ): Promise<PlacementExecution> => {
        const authorization = ensureMutationAuthorized();
        if (authorization) return { ok: false, result: authorization, placed: false, confirmed: false };
        const current = readSnapshot(ctx.bot, unit.position);
        if (!current) {
          return { ok: false, result: mutationFailure(jobId, item, unit.position, failure(
            "WORLD_UNAVAILABLE",
            `world data unavailable at ${formatPosition(unit.position)}`,
            true,
          )), placed: false, confirmed: false };
        }
        if (matchesUnitSnapshot(current, unit.expected.block, unit.hint)) {
          return { ok: true, placed: false, confirmed: true };
        }
        if (!current.replaceable) {
          return { ok: false, result: mutationFailure(jobId, item, unit.position, failure(
            "AREA_UNSAFE",
            `refusing to replace '${current.name}' at ${formatPosition(unit.position)}`,
            false,
            { found: current.name, expected: unit.expected.block },
          )), placed: false, confirmed: false };
        }
        const mutation = createTrackedMutation(ordinal);
        const result = await placeBuildPlacement(ctx.bot as never, {
          position: vector(unit.position),
          item,
          hint: unit.hint,
          signal: ctx.signal,
          expected: current,
          expectedAfter: (after) => matchesUnitSnapshot(after, unit.expected.block, unit.hint),
          hooks: mutation.hooks,
        });
        if (!result.ok) {
          // The shared executor returns INTERRUPTED after a verified, journaled
          // click when cancellation races its final postcondition check.
          const confirmed = mutation.wasApplied() ||
            (result.after !== undefined && matchesUnitSnapshot(result.after, unit.expected.block, unit.hint));
          return {
            ok: false,
            result: mutationFailure(jobId, item, unit.position, result),
            placed: confirmed,
            confirmed,
          };
        }
        return { ok: true, placed: true, confirmed: true };
      };

      const digScaffold = async (
        position: Vec3,
        block: string,
        ordinal: number,
      ): Promise<SkillResult | undefined> => {
        const authorization = ensureMutationAuthorized();
        if (authorization) return authorization;
        const current = readSnapshot(ctx.bot, position);
        if (!current) {
          return mutationFailure(jobId, block, position, failure(
            "WORLD_UNAVAILABLE",
            `world data unavailable while cleaning temporary scaffold at ${formatPosition(position)}`,
            true,
          ));
        }
        if (current.name !== block) {
          return mutationFailure(jobId, block, position, failure(
            "STALE_STATE",
            `temporary scaffold at ${formatPosition(position)} changed to '${current.name}'; refusing to dig it`,
            false,
            { expected: block, found: current.name },
          ));
        }
        const mutation = createTrackedMutation(ordinal);
        const result = await digAt(ctx.bot as never, {
          position: vector(position),
          signal: ctx.signal,
          expected: current,
          hooks: mutation.hooks,
        });
        if (!result.ok) return mutationFailure(jobId, block, position, result);
        // `digAt` intentionally accepts any changed post-state for generic
        // mining. Temporary support cleanup is narrower: a solid replacement
        // could be another player's block or a server-side side effect, so it
        // must leave this construction partial rather than count as cleanup.
        const after = result.after;
        if (!after) {
          return mutationFailure(jobId, block, position, failure(
            "WORLD_UNAVAILABLE",
            `temporary scaffold cleanup returned no observable post-state at ${formatPosition(position)}`,
            true,
          ));
        }
        if (!after.replaceable) {
          return mutationFailure(jobId, block, position, failure(
            "STALE_STATE",
            `temporary scaffold cleanup left non-replaceable '${after.name}' at ${formatPosition(position)}`,
            false,
            {
              expected: "replaceable block",
              observed: after.name,
              after: vector(after.position),
            },
          ));
        }
        return undefined;
      };

      /**
       * An old temporary support can look exactly like an ordinary player dirt
       * or cobblestone block. Its durable journal proves only that SmartBot
       * once placed it, not that the still-live block is ours to remove. A
       * retry therefore never digs historical residue: it blocks before any
       * new mutation or completion when a latest uncleaned support candidate
       * is still non-replaceable.
       */
      const ensureNoHistoricalScaffoldResidue = async (): Promise<SkillResult | undefined> => {
        const history = deps.transactions.listConstructionMutationHistory({
          serverKey: deps.serverKey,
          dimension,
          constructionJobId: job.id,
          minOrdinal: PRIMARY_SCAFFOLD_ORDINAL_BASE,
        });
        if (history.truncated) {
          return failure(
            "WORLD_UNAVAILABLE",
            `construction job ${jobId} has too many distinct historical support positions to inspect safely`,
            true,
            { jobId },
          );
        }

        for (const [index, change] of history.changes.entries()) {
          if (ctx.signal.aborted) {
            return interruptedResult("historical scaffold safety check");
          }
          const isPlacement = change.action === "place" &&
            isScaffoldBlock(change.intended.name) &&
            isScaffoldPlacementOrdinal(change.ordinal);
          const isUnexpectedCleanup = change.action === "dig" &&
            isScaffoldBlock(change.before.name) &&
            isScaffoldCleanupOrdinal(change.ordinal) &&
            change.confirmedAfter !== null &&
            !isReplaceableSnapshot(change.confirmedAfter);
          if (!isPlacement && !isUnexpectedCleanup) {
            continue;
          }
          const position = new Vec3(change.position.x, change.position.y, change.position.z);
          const current = readSnapshot(ctx.bot, position);
          if (!current) {
            return failure(
              "WORLD_UNAVAILABLE",
              `world data unavailable while checking historical temporary scaffold at ${formatPosition(position)}`,
              true,
              { jobId, position: vector(position), ordinal: change.ordinal },
            );
          }
          if (!current.replaceable) {
            return failure(
              "AREA_UNSAFE",
              isUnexpectedCleanup
                ? `temporary scaffold cleanup at ${formatPosition(position)} left '${current.name}'; refusing to ignore or build through it`
                : `historical temporary scaffold candidate at ${formatPosition(position)} is '${current.name}'; refusing to remove or build through it`,
              false,
              {
                jobId,
                position: vector(position),
                ordinal: change.ordinal,
                ...(isPlacement ? { intendedScaffold: change.intended.name } : {
                  intendedScaffold: change.before.name,
                  cleanupObserved: change.confirmedAfter?.name ?? null,
                }),
                observed: current.name,
              },
            );
          }
          if ((index + 1) % BUILD_EXECUTION_BATCH_SIZE === 0) {
            await yieldToEventLoop();
          }
        }
        return undefined;
      };

      const executeUnit = async (
        planned: PlannedUnit,
        phase: "primary" | "repair",
      ): Promise<PlacementExecution> => {
        const scaffoldPlaced: Array<{ position: Vec3; level: number }> = [];
        const scaffold = planned.scaffold;
        const cleanup = async (): Promise<SkillResult | undefined> => {
          if (!scaffold) return undefined;
          for (const entry of [...scaffoldPlaced].reverse()) {
            if (ctx.signal.aborted) return interruptedResult("temporary scaffold cleanup");
            const cleanupResult = await digScaffold(
              entry.position,
              scaffold.block,
              scaffoldCleanupOrdinal(phase, planned.unitIndex, entry.level),
            );
            if (cleanupResult) return cleanupResult;
          }
          return undefined;
        };

        if (scaffold) {
          for (const [level, position] of scaffold.positions.entries()) {
            const scaffoldUnit: PendingUnit = {
              unit: planned.unit,
              unitIndex: planned.unitIndex,
              expected: { x: 0, y: 0, z: 0, block: scaffold.block },
              position,
            };
            const scaffoldResult = await place(
              scaffoldUnit,
              scaffoldPlacementOrdinal(phase, planned.unitIndex, level),
              scaffold.block,
            );
            if (!scaffoldResult.ok) {
              if (!ctx.signal.aborted && scaffoldPlaced.length > 0) {
                const cleanupResult = await cleanup();
                if (cleanupResult) {
                  return { ok: false, result: cleanupResult, placed: false, confirmed: false };
                }
              }
              // A temporary support is never blueprint progress.
              return { ...scaffoldResult, placed: false, confirmed: false };
            }
            // A pre-existing matching scaffold is never accepted by `place` for
            // this branch because it returns placed:false; do not later dig a
            // player-owned block that coincidentally has the scaffold material.
            if (!scaffoldResult.placed) {
              return {
                ok: false,
                placed: false,
                confirmed: false,
                result: failure(
                  "STALE_STATE",
                  `temporary scaffold position ${formatPosition(position)} was already '${scaffold.block}'`,
                  false,
                  { jobId, position: vector(position), block: scaffold.block },
                ),
              };
            }
            scaffoldPlaced.push({ position, level });
          }
        }

        const primary = await place(
          planned,
          phase === "primary" ? primaryOrdinal(planned.unitIndex) : repairOrdinal(planned.unitIndex),
          planned.unit.item,
        );
        if (!primary.ok) {
          if (!ctx.signal.aborted && scaffoldPlaced.length > 0) {
            const cleanupResult = await cleanup();
            if (cleanupResult) {
              return {
                ok: false,
                result: cleanupResult,
                placed: primary.placed,
                confirmed: primary.confirmed,
              };
            }
          }
          return primary;
        }
        if (ctx.signal.aborted) {
          return {
            ok: false,
            result: interruptedResult("placement"),
            placed: primary.placed,
            confirmed: primary.confirmed,
          };
        }
        const cleanupResult = await cleanup();
        if (cleanupResult) {
          return {
            ok: false,
            result: cleanupResult,
            placed: primary.placed,
            confirmed: primary.confirmed,
          };
        }
        return primary;
      };

      try {
        const sourceFailure = assertLiveSourceAccess();
        if (sourceFailure) return finalizeNormalFailure(sourceFailure);

        const scanned = await scanBuildTargets(
          ctx,
          blueprint.placementUnits,
          job,
          sourceAllowsHazardousBlocks,
        );
        if (!scanned.ok) {
          if (scanned.result.code === "INTERRUPTED") return finalizeInterrupted("preflight");
          return finalizeNormalFailure(scanned.result);
        }
        resolvedWorldCells = scanned.scan.correctWorldCells;
        if (!writeProgress(resolvedWorldCells)) return finalizeInterrupted("preflight");

        // This is job-wide rather than plan-wide. A retry receives a new task
        // plan, yet an old planned row can still be the same physical click.
        // The transaction store repeats this invariant atomically during
        // begin/reuse to close the query-to-insert race.
        const unresolved = findUnresolvedAttempt();
        if (unresolved) return unresolved;

        const historicalScaffoldFailure = await ensureNoHistoricalScaffoldResidue();
        if (historicalScaffoldFailure) {
          if (historicalScaffoldFailure.code === "INTERRUPTED") {
            return finalizeInterrupted("historical scaffold safety check");
          }
          return finalizeNormalFailure(historicalScaffoldFailure);
        }

        if (scanned.scan.pending.length === 0) {
          // Inspect an existing same-attempt journal even when the target cells
          // now look correct. A planned click (including a scaffold cleanup
          // outside the blueprint) is ambiguous until reconnect reconciliation
          // classifies it; never let a name-only scan erase that uncertainty.
          journal = beginConstructionJournal();
          if (journal.changes.some((change) => change.status === "planned")) {
            const result = failure(
              "WORLD_UNAVAILABLE",
              `construction job ${jobId} has ${journal.changes.filter((change) => change.status === "planned").length} uncertain journaled mutation(s) awaiting reconciliation`,
              true,
              { jobId },
            );
            markStatus("blocked", result.summary);
            return annotateTransaction(result, journal);
          }
          if (journal.changes.length > 0) {
            // Terminalize a legacy/open resolved attempt before creating the
            // empty verification attempt whose completed status authorizes the
            // job completion below.
            deps.transactions.complete(journal.id);
            journal = beginConstructionJournal();
          }
          const verification = await verifyBuild(ctx, blueprint.placementUnits, job);
          if (verification.interrupted) return finalizeInterrupted("verification");
          if (!verification.matches) {
            return finalizeNormalFailure(verificationFailure(jobId, blueprint.name, verification, 0));
          }
          const completed = deps.transactions.complete(journal.id);
          if (completed?.status !== "completed") {
            return finalizeNormalFailure(failure(
              "UNKNOWN",
              `construction journal ${journal.id} did not complete after a matching world verification`,
              false,
              { jobId, transaction: transactionSummary(completed) },
            ));
          }
          if (!markStatus("completed")) return finalizeInterrupted("completion");
          return successResult(
            jobId,
            blueprint.name,
            0,
            resolvedWorldCells,
            totalWorldCells,
            verification,
            0,
            completed,
          );
        }

        const materialResult = await acquireMaterials(
          countPlacementUnitMaterials(scanned.scan.pending.map((entry) => entry.unit)),
          job.storageName,
          retrieve,
          ctx,
          ensureMutationAuthorized,
        );
        if (materialResult) return finalizeNormalFailure(materialResult);
        if (!isActive()) return finalizeInterrupted("material preparation");

        const primaryPlan = await planExecution(
          ctx,
          scanned.scan.pending,
          blueprint.placementUnits,
          job,
          countPlacementUnitMaterials(scanned.scan.pending.map((entry) => entry.unit)),
        );
        if (!primaryPlan.ok) {
          if (primaryPlan.result.code === "INTERRUPTED") return finalizeInterrupted("preflight");
          return finalizeNormalFailure(primaryPlan.result);
        }

        journal = beginConstructionJournal();

        // A planned row may represent a click immediately before a crash. Never
        // rerun that ordinal until the runtime's scoped live reconciliation has
        // classified it.
        if (journal.changes.some((change) => change.status === "planned")) {
          const result = failure(
            "WORLD_UNAVAILABLE",
            `construction job ${jobId} has ${journal.changes.filter((change) => change.status === "planned").length} uncertain journaled mutation(s) awaiting reconciliation`,
            true,
            { jobId },
          );
          markStatus("blocked", result.summary);
          return annotateTransaction(result, journal);
        }
        // Be defensive around a legacy/open row whose mutations are all already
        // terminal. Complete it, then start a fresh attempt for this execution.
        if (journal.changes.length > 0) {
          deps.transactions.complete(journal.id);
          journal = beginConstructionJournal();
        }

        const primaryBudget = deps.transactions.preflightWorldChanges({
          transactionId: journal.id,
          maxWorldChanges: ctx.execution.maxWorldChanges,
          requestedChanges: primaryPlan.plan.mutationCount,
        });
        if (!primaryBudget.ok) {
          const terminal = deps.transactions.cancel(journal.id, primaryBudget.summary);
          const result = failure(
            primaryBudget.code,
            primaryBudget.summary,
            primaryBudget.recoverable,
            { jobId, ...primaryBudget.details },
          );
          markStatus("blocked", result.summary);
          return annotateTransaction(result, terminal);
        }

        let placed = 0;
        for (const [offset, planned] of primaryPlan.plan.units.entries()) {
          if (!isActive()) return finalizeInterrupted("placement");
          const executed = await executeUnit(planned, "primary");
          if (executed.confirmed) {
            const worldCells = planned.unit.expectedCells.length;
            if (executed.placed) placed += worldCells;
            resolvedWorldCells += worldCells;
            if (!writeProgress(resolvedWorldCells)) return finalizeInterrupted("placement");
          }
          if (!executed.ok) {
            if (executed.result.code === "INTERRUPTED") return finalizeInterrupted("placement");
            return finalizeNormalFailure(executed.result);
          }
          if ((offset + 1) % BUILD_EXECUTION_BATCH_SIZE === 0 || offset + 1 === primaryPlan.plan.units.length) {
            ctx.reportProgress(`placed ${resolvedWorldCells}/${totalWorldCells} expected world cells`);
            await yieldToEventLoop();
          }
        }

        let verification = await verifyBuild(ctx, blueprint.placementUnits, job);
        if (verification.interrupted) return finalizeInterrupted("post-build verification");
        // Full verification is authoritative if another actor changed a cell
        // during the batch; it also ensures a later repair failure reports the
        // exact observed partial total, not simply attempted click count.
        resolvedWorldCells = verification.correct;
        if (!writeProgress(resolvedWorldCells)) return finalizeInterrupted("post-build verification");

        // Once construction enters the repair phase, every failure is reported
        // against a fresh full comparison.  A click can have succeeded just
        // before an executor error, or another actor can change a cell during
        // repair; returning only the local failure would hide the durable
        // state that an operator needs to decide whether a retry is safe.
        const finalizeRepairFailure = async (
          result: SkillResult,
          repaired: number,
          phase: string,
        ): Promise<SkillResult> => {
          const current = await verifyBuild(ctx, blueprint.placementUnits, job);
          if (current.interrupted) return finalizeInterrupted(`${phase} verification`);
          resolvedWorldCells = current.correct;
          if (!writeProgress(resolvedWorldCells)) return finalizeInterrupted(`${phase} verification`);
          return finalizeNormalFailure(withVerification(result, current, repaired));
        };
        if (verification.matches) {
          const completed = deps.transactions.complete(journal.id);
          if (completed?.status !== "completed") {
            return finalizeNormalFailure(failure(
              "UNKNOWN",
              `construction journal ${journal.id} did not complete after a matching world verification`,
              false,
              { jobId, transaction: transactionSummary(completed) },
            ));
          }
          resolvedWorldCells = verification.correct;
          writeProgress(resolvedWorldCells);
          if (!markStatus("completed")) return finalizeInterrupted("completion");
          return successResult(jobId, blueprint.name, placed, scanned.scan.correctWorldCells, totalWorldCells, verification, 0, completed);
        }

        // A repair can only touch currently replaceable one-cell units. Any
        // conflict, unloaded cell, or wrong state is reported without replacement.
        if (verification.conflicting > 0 || verification.unloaded > 0 || verification.stateMismatched > 0) {
          return finalizeRepairFailure(verificationFailure(jobId, blueprint.name, verification, 0), 0, "repair preflight");
        }
        const repairScan = await collectRepairCandidates(
          ctx,
          blueprint.placementUnits,
          job,
          sourceAllowsHazardousBlocks,
        );
        if (!repairScan.ok) {
          if (repairScan.result.code === "INTERRUPTED") return finalizeInterrupted("repair preflight");
          return finalizeRepairFailure(repairScan.result, 0, "repair preflight");
        }
        if (repairScan.missing > MAX_BUILD_REPAIR_UNITS) {
          return finalizeRepairFailure(failure(
            "STALE_STATE",
            `construction job ${jobId} has ${repairScan.missing} missing units; one repair pass is limited to ${MAX_BUILD_REPAIR_UNITS}`,
            true,
            { jobId, missing: repairScan.missing, repairLimit: MAX_BUILD_REPAIR_UNITS },
          ), 0, "repair preflight");
        }
        if (repairScan.conflicting > 0 || repairScan.unloaded > 0 || repairScan.stateMismatched > 0) {
          return finalizeRepairFailure(failure(
            repairScan.unloaded > 0 ? "WORLD_UNAVAILABLE" : "STALE_STATE",
            `construction job ${jobId} changed during repair preflight; refusing a mixed-state repair pass`,
            true,
            {
              jobId,
              missing: repairScan.missing,
              conflicting: repairScan.conflicting,
              unloaded: repairScan.unloaded,
              stateMismatched: repairScan.stateMismatched,
            },
          ), 0, "repair preflight");
        }
        if (repairScan.candidates.length === 0 || repairScan.missing !== repairScan.candidates.length) {
          return finalizeRepairFailure(verificationFailure(jobId, blueprint.name, verification, 0), 0, "repair preflight");
        }

        const repairMaterials = countPlacementUnitMaterials(repairScan.candidates.map((entry) => entry.unit));
        const repairMaterialResult = await acquireMaterials(
          repairMaterials,
          job.storageName,
          retrieve,
          ctx,
          ensureMutationAuthorized,
        );
        if (repairMaterialResult) return finalizeRepairFailure(repairMaterialResult, 0, "repair material preparation");
        const repairPlan = await planExecution(ctx, repairScan.candidates, blueprint.placementUnits, job, repairMaterials);
        if (!repairPlan.ok) {
          if (repairPlan.result.code === "INTERRUPTED") return finalizeInterrupted("repair preflight");
          return finalizeRepairFailure(repairPlan.result, 0, "repair planning");
        }
        const repairBudget = deps.transactions.preflightWorldChanges({
          transactionId: journal.id,
          maxWorldChanges: ctx.execution.maxWorldChanges,
          requestedChanges: repairPlan.plan.mutationCount,
        });
        if (!repairBudget.ok) {
          return finalizeRepairFailure(failure(
            repairBudget.code,
            repairBudget.summary,
            repairBudget.recoverable,
            { jobId, ...repairBudget.details },
          ), 0, "repair budget preflight");
        }

        let repaired = 0;
        for (const planned of repairPlan.plan.units) {
          if (!isActive()) return finalizeInterrupted("repair");
          const executed = await executeUnit(planned, "repair");
          if (executed.confirmed) {
            const worldCells = planned.unit.expectedCells.length;
            if (executed.placed) repaired += worldCells;
            resolvedWorldCells += worldCells;
            if (!writeProgress(resolvedWorldCells)) return finalizeInterrupted("repair");
          }
          if (!executed.ok) {
            if (executed.result.code === "INTERRUPTED") return finalizeInterrupted("repair");
            return finalizeRepairFailure(executed.result, repaired, "repair");
          }
        }

        verification = await verifyBuild(ctx, blueprint.placementUnits, job);
        if (verification.interrupted) return finalizeInterrupted("final verification");
        resolvedWorldCells = verification.correct;
        if (!writeProgress(resolvedWorldCells)) return finalizeInterrupted("final verification");
        if (!verification.matches) return finalizeNormalFailure(verificationFailure(jobId, blueprint.name, verification, repaired));
        const completed = deps.transactions.complete(journal.id);
        if (completed?.status !== "completed") {
          return finalizeNormalFailure(failure(
            "UNKNOWN",
            `construction journal ${journal.id} did not complete after repaired world verification`,
            false,
            { jobId, transaction: transactionSummary(completed) },
          ));
        }
        resolvedWorldCells = verification.correct;
        writeProgress(resolvedWorldCells);
        if (!markStatus("completed")) return finalizeInterrupted("completion");
        return successResult(jobId, blueprint.name, placed + repaired, scanned.scan.correctWorldCells, totalWorldCells, verification, repaired, completed);
      } catch (error) {
        if (error instanceof UnresolvedConstructionAttemptError) {
          const result = failure(
            "WORLD_UNAVAILABLE",
            `construction job ${jobId} has an uncertain prior mutation awaiting reconciliation`,
            true,
            {
              jobId,
              transactionId: error.transactionId,
              priorPlanId: error.taskPlanId,
            },
          );
          markStatus("blocked", result.summary);
          return result;
        }
        if (ctx.signal.aborted || errorMessage(error) === "aborted") return finalizeInterrupted("execution");
        return finalizeNormalFailure(failure(
          "UNKNOWN",
          `construction job ${jobId} failed: ${errorMessage(error)}`,
          true,
          { jobId, blueprint: blueprint.name },
        ));
      }
    },
  });
}

async function scanBuildTargets(
  ctx: SkillContext,
  units: readonly BlueprintPlacementUnit[],
  job: Pick<ConstructionJobRow, "originX" | "originY" | "originZ" | "rotation">,
  allowHazardousBlocks: boolean,
): Promise<ScanResult> {
  const pending: PendingUnit[] = [];
  let correctWorldCells = 0;
  const totalWorldCells = countExpectedWorldCells(units);
  for (const [unitIndex, unit] of units.entries()) {
    if (ctx.signal.aborted) return { ok: false, result: interruptedResult("preflight") };
    const valid = validatePlacementUnit(unit, unitIndex, allowHazardousBlocks);
    if (!valid.ok) return valid;
    const hint = rotateHint(unit.hint, job.rotation);
    const position = blueprintWorldPosition(valid.expected, job, job.rotation);
    const current = readSnapshot(ctx.bot, position);
    if (!current) {
      return { ok: false, result: failure(
        "WORLD_UNAVAILABLE",
        `world data unavailable at ${formatPosition(position)}`,
        true,
        { position: vector(position), unitIndex },
      ) };
    }
    if (matchesUnitSnapshot(current, valid.expected.block, hint)) {
      correctWorldCells += unit.expectedCells.length;
    } else if (current.name === valid.expected.block && hint !== undefined) {
      return { ok: false, result: failure(
        "STALE_STATE",
        `block state at ${formatPosition(position)} does not match the required placement hint`,
        true,
        { position: vector(position), expected: valid.expected.block, found: current.name, hint },
      ) };
    } else if (current.replaceable) {
      pending.push(Object.freeze({ unit, unitIndex, expected: valid.expected, position, ...(hint === undefined ? {} : { hint }) }));
    } else {
      return { ok: false, result: failure(
        "AREA_UNSAFE",
        `refusing to replace '${current.name}' at ${formatPosition(position)} with '${valid.expected.block}'`,
        false,
        { position: vector(position), expected: valid.expected.block, found: current.name, unitIndex },
      ) };
    }
    if ((unitIndex + 1) % BUILD_EXECUTION_BATCH_SIZE === 0) {
      ctx.reportProgress(`preflight checked ${unitIndex + 1}/${units.length} placement units`);
      await yieldToEventLoop();
      if (ctx.signal.aborted) return { ok: false, result: interruptedResult("preflight") };
    }
  }
  return { ok: true, scan: Object.freeze({ correctWorldCells, pending: Object.freeze(pending), totalWorldCells }) };
}

async function planExecution(
  ctx: SkillContext,
  pending: readonly PendingUnit[],
  allUnits: readonly BlueprintPlacementUnit[],
  job: Pick<ConstructionJobRow, "originX" | "originY" | "originZ" | "rotation">,
  reservedMaterials: ReadonlyMap<string, number>,
): Promise<PlanResult> {
  const blueprintPositions = new Set<string>();
  for (const unit of allUnits) {
    for (const cell of unit.expectedCells) {
      blueprintPositions.add(positionKey(blueprintWorldPosition(cell, job, job.rotation)));
    }
  }
  const virtual = new Map<string, VirtualCell>();
  const readVirtual = (position: Vec3): VirtualCell | undefined => {
    const key = positionKey(position);
    const cached = virtual.get(key);
    if (cached) return cached;
    const snapshot = readSnapshot(ctx.bot, position);
    if (!snapshot) return undefined;
    const value = virtualCell(snapshot);
    virtual.set(key, value);
    return value;
  };

  const planned: PlannedUnit[] = [];
  // Plan the entire operation against inventory that is reserved for both its
  // final blocks and every temporary support it will require. Even though
  // cleanup ordinarily returns a block, relying on a future drop to satisfy a
  // later planned support would make the preflight promise false on a laggy
  // server or if a cleanup becomes partial.
  const reservedScaffoldMaterials = new Map<string, number>();
  for (const [offset, pendingUnit] of pending.entries()) {
    if (ctx.signal.aborted) return { ok: false, result: interruptedResult("execution-plan preflight") };
    // Refresh the target into the virtual model. It may have changed after the
    // earlier full scan; the executor still performs the authoritative reread.
    const targetCell = readVirtual(pendingUnit.position);
    if (!targetCell) {
      return { ok: false, result: failure(
        "WORLD_UNAVAILABLE",
        `world data unavailable while planning ${formatPosition(pendingUnit.position)}`,
        true,
        { position: vector(pendingUnit.position), unitIndex: pendingUnit.unitIndex },
      ) };
    }
    let scaffold: PlannedScaffold | undefined;
    const reference = inspectVirtualReference(pendingUnit.position, readVirtual);
    if (!reference.exists) {
      if (reference.unavailable) {
        return { ok: false, result: failure(
          "WORLD_UNAVAILABLE",
          `world data unavailable near ${formatPosition(pendingUnit.position)} while planning support`,
          true,
          { position: vector(pendingUnit.position), unitIndex: pendingUnit.unitIndex },
        ) };
      }
      const plannedScaffold = planTemporaryScaffold(
        ctx,
        pendingUnit.position,
        blueprintPositions,
        reservedMaterials,
        reservedScaffoldMaterials,
        readVirtual,
      );
      if (!plannedScaffold.ok) return plannedScaffold;
      scaffold = plannedScaffold.scaffold;
      reservedScaffoldMaterials.set(
        scaffold.block,
        (reservedScaffoldMaterials.get(scaffold.block) ?? 0) + scaffold.positions.length,
      );
      for (const position of scaffold.positions) virtual.set(positionKey(position), solidVirtualCell(scaffold.block));
    }

    planned.push(Object.freeze({ ...pendingUnit, ...(scaffold === undefined ? {} : { scaffold }) }));
    // Simulate the normal one-cell placement followed by immediate safe scaffold
    // cleanup. This makes a second floating unit plan its own support instead of
    // accidentally borrowing an ephemeral block that will be removed.
    virtual.set(positionKey(pendingUnit.position), solidVirtualCell(pendingUnit.expected.block));
    if (scaffold) {
      for (const position of scaffold.positions) virtual.set(positionKey(position), emptyVirtualCell());
    }

    if ((offset + 1) % BUILD_EXECUTION_BATCH_SIZE === 0) {
      ctx.reportProgress(`planned ${offset + 1}/${pending.length} pending placement units`);
      await yieldToEventLoop();
      if (ctx.signal.aborted) return { ok: false, result: interruptedResult("execution-plan preflight") };
    }
  }
  const mutationCount = planned.reduce(
    (total, entry) => total + 1 + (entry.scaffold?.positions.length ?? 0) * 2,
    0,
  );
  return { ok: true, plan: Object.freeze({ units: Object.freeze(planned), mutationCount }) };
}

function planTemporaryScaffold(
  ctx: SkillContext,
  target: Vec3,
  blueprintPositions: ReadonlySet<string>,
  reservedMaterials: ReadonlyMap<string, number>,
  reservedScaffoldMaterials: ReadonlyMap<string, number>,
  readVirtual: (position: Vec3) => VirtualCell | undefined,
): { readonly ok: true; readonly scaffold: PlannedScaffold } | { readonly ok: false; readonly result: SkillResult } {
  const offsets = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];
  let unavailable = false;
  for (const offset of offsets) {
    const top = target.plus(offset);
    let supportY: number | undefined;
    for (let depth = 1; depth <= MAX_SCAFFOLD_HEIGHT; depth++) {
      const candidate = new Vec3(top.x, top.y - depth, top.z);
      const cell = readVirtual(candidate);
      if (!cell) {
        unavailable = true;
        break;
      }
      if (isSolidVirtualCell(cell)) {
        supportY = candidate.y;
        break;
      }
      if (!cell.replaceable || blueprintPositions.has(positionKey(candidate))) break;
    }
    if (supportY === undefined) continue;
    const positions = Array.from(
      { length: top.y - supportY },
      (_, index) => new Vec3(top.x, supportY! + index + 1, top.z),
    );
    if (positions.length === 0 || positions.length > MAX_SCAFFOLD_HEIGHT) {
      continue;
    }
    let safePositions = true;
    for (const position of positions) {
      const cell = readVirtual(position);
      if (!cell) {
        // Do not misreport an unloaded support column as a material shortage.
        // A later retry can safely make this plan once the chunk is readable.
        unavailable = true;
        safePositions = false;
        break;
      }
      if (!cell.replaceable || blueprintPositions.has(positionKey(position))) {
        safePositions = false;
        break;
      }
    }
    if (!safePositions) continue;
    const scaffoldBlock = SCAFFOLD_BLOCKS.find((item) =>
      countInInventory(ctx.bot, item) -
        (reservedMaterials.get(item) ?? 0) -
        (reservedScaffoldMaterials.get(item) ?? 0) >= positions.length,
    );
    if (!scaffoldBlock) continue;
    return { ok: true, scaffold: Object.freeze({ block: scaffoldBlock, positions: Object.freeze(positions) }) };
  }
  if (unavailable) {
    return { ok: false, result: failure(
      "WORLD_UNAVAILABLE",
      `world data unavailable while planning a temporary scaffold near ${formatPosition(target)}`,
      true,
      { position: vector(target), requiresScaffold: true },
    ) };
  }
  return { ok: false, result: failure(
    "NO_MATERIAL",
    `no safe support path for block at ${formatPosition(target)}; carry spare dirt or cobblestone ` +
      `and keep the site within ${MAX_SCAFFOLD_HEIGHT} blocks of solid ground`,
    true,
    {
      position: vector(target),
      requiresScaffold: true,
      acceptedScaffoldBlocks: [...SCAFFOLD_BLOCKS],
      maxScaffoldHeight: MAX_SCAFFOLD_HEIGHT,
    },
  ) };
}

async function collectRepairCandidates(
  ctx: SkillContext,
  units: readonly BlueprintPlacementUnit[],
  job: Pick<ConstructionJobRow, "originX" | "originY" | "originZ" | "rotation">,
  allowHazardousBlocks: boolean,
): Promise<RepairScanResult> {
  const candidates: PendingUnit[] = [];
  let missing = 0;
  let conflicting = 0;
  let unloaded = 0;
  let stateMismatched = 0;
  for (const [unitIndex, unit] of units.entries()) {
    if (ctx.signal.aborted) return { ok: false, result: interruptedResult("repair preflight") };
    const valid = validatePlacementUnit(unit, unitIndex, allowHazardousBlocks);
    if (!valid.ok) return valid;
    const hint = rotateHint(unit.hint, job.rotation);
    const position = blueprintWorldPosition(valid.expected, job, job.rotation);
    const current = readSnapshot(ctx.bot, position);
    if (!current) {
      unloaded++;
    } else if (matchesUnitSnapshot(current, valid.expected.block, hint)) {
      // Already repaired/correct; nothing to add.
    } else if (current.name === valid.expected.block && hint !== undefined) {
      stateMismatched++;
    } else if (current.replaceable) {
      missing++;
      // Store at most the repair cap plus one. Exact totals stay in `missing`,
      // while the worklist itself remains bounded even for a 4,096-cell plan.
      if (candidates.length <= MAX_BUILD_REPAIR_UNITS) {
        candidates.push(Object.freeze({ unit, unitIndex, expected: valid.expected, position, ...(hint === undefined ? {} : { hint }) }));
      }
    } else {
      conflicting++;
    }
    if ((unitIndex + 1) % BUILD_EXECUTION_BATCH_SIZE === 0) {
      await yieldToEventLoop();
      if (ctx.signal.aborted) return { ok: false, result: interruptedResult("repair preflight") };
    }
  }
  return {
    ok: true,
    candidates: Object.freeze(candidates),
    missing,
    conflicting,
    unloaded,
    stateMismatched,
  };
}

async function verifyBuild(
  ctx: SkillContext,
  units: readonly BlueprintPlacementUnit[],
  job: Pick<ConstructionJobRow, "originX" | "originY" | "originZ" | "rotation">,
): Promise<BuildVerificationReport> {
  return verifyBlueprintWorld(ctx.bot, units, job, job.rotation, {
    signal: ctx.signal,
    batchSize: BUILD_EXECUTION_BATCH_SIZE,
    maxIssueSamples: 32,
  });
}

async function acquireMaterials(
  needed: ReadonlyMap<string, number>,
  storageName: string | null,
  retrieve: ReturnType<typeof retrieveItem>,
  ctx: SkillContext,
  authorizeMutation: () => SkillResult | undefined,
): Promise<SkillResult | undefined> {
  for (const [item, quantity] of needed) {
    if (ctx.signal.aborted) return interruptedResult("material preparation");
    const have = countInInventory(ctx.bot, item);
    if (have >= quantity) continue;
    if (storageName) {
      const authorization = authorizeMutation();
      if (authorization) return authorization;
      const result = await retrieve.run({
        item,
        quantity,
        chestName: storageName,
        excludeChestName: undefined,
      }, ctx);
      if (!result.ok) return result;
    }
    const current = countInInventory(ctx.bot, item);
    if (current < quantity) {
      return failure(
        "NO_MATERIAL",
        `construction needs ${quantity} ${item} but only has ${current}`,
        true,
        { item, required: quantity, current, storageName },
      );
    }
  }
  return undefined;
}

function validatePlacementUnit(
  unit: BlueprintPlacementUnit,
  unitIndex: number,
  allowHazardousBlocks: boolean,
): { readonly ok: true; readonly expected: BlueprintBlock } | { readonly ok: false; readonly result: SkillResult } {
  if (unit.expectedCells.length !== 1) {
    return { ok: false, result: failure(
      "UNSUPPORTED_STATE",
      `placement unit ${unitIndex} requires ${unit.expectedCells.length} world cells; multi-cell survival placement is not verified`,
      false,
      { unitIndex, item: unit.item, expectedWorldCells: unit.expectedCells.length },
    ) };
  }
  const expected = unit.expectedCells[0]!;
  if (unit.item !== expected.block || unit.anchor.block !== expected.block ||
      unit.anchor.x !== expected.x || unit.anchor.y !== expected.y || unit.anchor.z !== expected.z) {
    return { ok: false, result: failure(
      "UNSUPPORTED_STATE",
      `placement unit ${unitIndex} does not describe one verified item-to-cell placement`,
      false,
      { unitIndex, item: unit.item, expected },
    ) };
  }
  const unsafe = UNSAFE_BLUEPRINT_BLOCKS.has(unit.item) || UNSAFE_BLUEPRINT_BLOCKS.has(expected.block);
  const hazardous = unit.item === "tnt" || expected.block === "tnt";
  if (unsafe || (hazardous && !allowHazardousBlocks)) {
    return { ok: false, result: failure(
      "AREA_UNSAFE",
      hazardous
        ? `hazardous blueprint block '${unit.item}' requires a current owner-authorized generated source`
        : `unsafe blueprint block '${unit.item}' is not allowed`,
      false,
      { unitIndex, block: unit.item, hazardous },
    ) };
  }
  return { ok: true, expected };
}

interface VirtualCell {
  readonly name: string;
  readonly boundingBox: "block" | "empty" | "unknown";
  readonly replaceable: boolean;
}

function virtualCell(snapshot: BlockSnapshot): VirtualCell {
  return Object.freeze({
    name: snapshot.name,
    boundingBox: snapshot.boundingBox,
    replaceable: snapshot.replaceable,
  });
}

function solidVirtualCell(name: string): VirtualCell {
  return Object.freeze({ name, boundingBox: "block", replaceable: false });
}

function emptyVirtualCell(): VirtualCell {
  return Object.freeze({ name: "air", boundingBox: "empty", replaceable: true });
}

function isSolidVirtualCell(cell: VirtualCell): boolean {
  return !AIR_BLOCKS.has(cell.name) && cell.boundingBox !== "empty";
}

function inspectVirtualReference(
  target: Vec3,
  readVirtual: (position: Vec3) => VirtualCell | undefined,
): { readonly exists: boolean; readonly unavailable: boolean } {
  const offsets = [
    new Vec3(0, -1, 0),
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
    new Vec3(0, 1, 0),
  ];
  let unavailable = false;
  for (const offset of offsets) {
    const cell = readVirtual(target.plus(offset));
    if (!cell) {
      unavailable = true;
      continue;
    }
    if (isSolidVirtualCell(cell)) return { exists: true, unavailable };
  }
  return { exists: false, unavailable };
}

function matchesUnitSnapshot(
  snapshot: BlockSnapshot,
  expectedBlock: string,
  hint: PlacementHint | undefined,
): boolean {
  if (snapshot.name !== expectedBlock) return false;
  return (hint?.facing === undefined || snapshot.properties.facing === hint.facing) &&
    (hint?.half === undefined || snapshot.properties.half === hint.half);
}

function rotateHint(hint: PlacementHint | undefined, rotation: ConstructionJobRow["rotation"]): PlacementHint | undefined {
  if (!hint) return undefined;
  return Object.freeze({
    ...(hint.facing === undefined ? {} : { facing: rotateCardinal(hint.facing, rotation) }),
    ...(hint.half === undefined ? {} : { half: hint.half }),
  });
}

function rotateCardinal(facing: Cardinal, rotation: ConstructionJobRow["rotation"]): Cardinal {
  const order: readonly Cardinal[] = ["north", "east", "south", "west"];
  const index = order.indexOf(facing);
  return order[(index + rotation / 90) % order.length]!;
}

function primaryOrdinal(unitIndex: number): number {
  return PRIMARY_ORDINAL_BASE + unitIndex;
}

function repairOrdinal(unitIndex: number): number {
  return REPAIR_ORDINAL_BASE + unitIndex;
}

function scaffoldPlacementOrdinal(phase: "primary" | "repair", unitIndex: number, level: number): number {
  return scaffoldOrdinalBase(phase) + unitIndex * SCAFFOLD_ORDINALS_PER_UNIT + level;
}

function scaffoldCleanupOrdinal(phase: "primary" | "repair", unitIndex: number, level: number): number {
  return scaffoldOrdinalBase(phase) + unitIndex * SCAFFOLD_ORDINALS_PER_UNIT + MAX_SCAFFOLD_HEIGHT + level;
}

function scaffoldOrdinalBase(phase: "primary" | "repair"): number {
  return phase === "primary" ? PRIMARY_SCAFFOLD_ORDINAL_BASE : REPAIR_SCAFFOLD_ORDINAL_BASE;
}

function isScaffoldBlock(name: string): name is (typeof SCAFFOLD_BLOCKS)[number] {
  return (SCAFFOLD_BLOCKS as readonly string[]).includes(name);
}

/** Journal snapshots from older rows may omit the derived replaceable flag. */
function isReplaceableSnapshot(snapshot: { readonly name: string; readonly replaceable?: boolean }): boolean {
  return snapshot.replaceable === true || REPLACEABLE_BUILD_BLOCKS.has(snapshot.name);
}

function isScaffoldPlacementOrdinal(ordinal: number): boolean {
  const relative = scaffoldNamespaceRelativeOrdinal(ordinal);
  return relative !== undefined && relative % SCAFFOLD_ORDINALS_PER_UNIT < MAX_SCAFFOLD_HEIGHT;
}

function isScaffoldCleanupOrdinal(ordinal: number): boolean {
  const relative = scaffoldNamespaceRelativeOrdinal(ordinal);
  return relative !== undefined && relative % SCAFFOLD_ORDINALS_PER_UNIT >= MAX_SCAFFOLD_HEIGHT;
}

function scaffoldNamespaceRelativeOrdinal(ordinal: number): number | undefined {
  if (isOrdinalInScaffoldNamespace(ordinal, PRIMARY_SCAFFOLD_ORDINAL_BASE)) {
    return ordinal - PRIMARY_SCAFFOLD_ORDINAL_BASE;
  }
  if (isOrdinalInScaffoldNamespace(ordinal, REPAIR_SCAFFOLD_ORDINAL_BASE)) {
    return ordinal - REPAIR_SCAFFOLD_ORDINAL_BASE;
  }
  return undefined;
}

function isOrdinalInScaffoldNamespace(ordinal: number, base: number): boolean {
  return ordinal >= base && ordinal < base + MAX_PLACEMENT_UNITS * SCAFFOLD_ORDINALS_PER_UNIT;
}

function budgetScope(execution: SkillContext["execution"]): string | undefined {
  return execution.transactionScope ?? (execution.missionRunId !== undefined
    ? `mission:${execution.missionRunId}`
    : execution.planId !== undefined
      ? `plan:${execution.planId}`
      : undefined);
}

function mutationFailure(
  jobId: number,
  block: string,
  position: Vec3,
  mutation: {
    readonly code?: BlockMutationResult["code"];
    readonly summary: string;
    readonly recoverable?: boolean;
    readonly details?: Record<string, unknown>;
  },
): SkillResult {
  return failure(
    mutation.code ?? "UNKNOWN",
    `construction job ${jobId} could not mutate ${block} at ${formatPosition(position)}: ${mutation.summary}`,
    mutation.recoverable ?? true,
    { jobId, block, position: vector(position), ...mutation.details },
  );
}

function verificationFailure(
  jobId: number,
  blueprint: string,
  report: BuildVerificationReport,
  repaired: number,
): SkillResult {
  return failure(
    report.unloaded > 0 ? "WORLD_UNAVAILABLE" :
      report.stateMismatched > 0 ? "STALE_STATE" : "TARGET_UNAVAILABLE",
    `construction job ${jobId} did not verify '${blueprint}' after placement`,
    true,
    {
      jobId,
      repaired,
      verification: serializeVerification(report),
    },
  );
}

/** Attach the authoritative bounded comparison to a repair-phase failure. */
function withVerification(
  result: SkillResult,
  report: BuildVerificationReport,
  repaired: number,
): SkillResult {
  return {
    ...result,
    details: {
      ...result.details,
      repaired,
      verification: serializeVerification(report),
    },
  };
}

function successResult(
  jobId: number,
  blueprint: string,
  placed: number,
  alreadyCorrect: number,
  total: number,
  verification: BuildVerificationReport,
  repaired: number,
  transaction?: WorldTransactionDetail,
): SkillResult {
  return {
    ok: true,
    summary: placed === 0
      ? `construction job ${jobId} already matches blueprint '${blueprint}'`
      : repaired > 0
        ? `built '${blueprint}' and verified ${verification.correct}/${total} expected world cells after ${repaired} repair action${repaired === 1 ? "" : "s"}`
        : `built '${blueprint}' and verified ${verification.correct}/${total} expected world cells`,
    data: {
      jobId,
      blueprint,
      placed,
      alreadyCorrect,
      total,
      placementUnitCount: verification.placementUnitCount,
      expectedWorldCellCount: verification.expectedWorldCellCount,
      repaired,
      verification: serializeVerification(verification),
      ...(transaction === undefined ? {} : { transaction: transactionSummary(transaction) }),
    },
  };
}

function serializeVerification(report: BuildVerificationReport): Record<string, unknown> {
  return {
    complete: report.complete,
    matches: report.matches,
    placementUnitCount: report.placementUnitCount,
    expectedWorldCellCount: report.expectedWorldCellCount,
    correctPlacementUnits: report.correctPlacementUnits,
    mismatchedPlacementUnits: report.mismatchedPlacementUnits,
    correct: report.correct,
    missing: report.missing,
    conflicting: report.conflicting,
    unloaded: report.unloaded,
    stateMismatched: report.stateMismatched,
    issueCounts: { ...report.issueCounts },
    issues: report.issues.map((issue) => ({ ...issue, position: { ...issue.position } })),
  };
}

function transactionSummary(transaction: WorldTransactionDetail | undefined): Record<string, unknown> | undefined {
  if (!transaction) return undefined;
  return {
    id: transaction.id,
    status: transaction.status,
    requestedChangeCount: transaction.requestedChangeCount,
    appliedChangeCount: transaction.appliedChangeCount,
    ...(transaction.lastError === null ? {} : { lastError: transaction.lastError }),
  };
}

function statusForFailure(result: SkillResult): ConstructionStatus {
  return result.code === "AREA_UNSAFE" || result.code === "INVALID_PARAMS" || result.code === "UNSUPPORTED_STATE"
    ? "failed"
    : "blocked";
}

function blockWithoutMutation(
  db: DB,
  job: ConstructionJobRow,
  ctx: SkillContext,
  result: SkillResult,
): SkillResult {
  setConstructionStatusIfCurrent(db, {
    jobId: job.id,
    status: statusForFailure(result),
    error: result.summary,
    expectedStatuses: ["pending", "running", "blocked", "failed"],
    ...(ctx.execution.planId === undefined
      ? { expectedNoPlan: true as const }
      : { expectedPlanId: ctx.execution.planId }),
  });
  return result;
}

function inactiveAttempt(db: DB, jobId: number, planId: number | undefined): SkillResult {
  const job = getConstructionJob(db, jobId);
  return failure(
    job?.status === "cancelled" ? "TARGET_UNAVAILABLE" : "INTERRUPTED",
    `construction job ${jobId} is no longer active`,
    job?.status !== "cancelled",
    { jobId, currentStatus: job?.status ?? null, planId },
  );
}

/** Exact ownership is required even for a direct (undefined-plan) invocation. */
function jobBelongsToExecution(
  job: Pick<ConstructionJobRow, "lastPlanId">,
  planId: number | undefined,
): boolean {
  return job.lastPlanId === null
    ? planId === undefined
    : planId === job.lastPlanId;
}

function missingJob(jobId: number): SkillResult {
  return failure("NOT_CONFIGURED", `no construction job ${jobId}`, false, { jobId });
}

function interruptedResult(phase: string): SkillResult {
  return failure("INTERRUPTED", `construction interrupted during ${phase}`, true, { phase });
}

function failure(
  code: NonNullable<SkillResult["code"]>,
  summary: string,
  recoverable: boolean,
  details?: Record<string, unknown>,
): SkillResult {
  return { ok: false, summary, code, recoverable, ...(details === undefined ? {} : { details }) };
}

function isHookFailure(value: void | BlockMutationHookFailure | undefined): value is BlockMutationHookFailure {
  return typeof value === "object" && value !== null && value.ok === false;
}

function readSnapshot(bot: SkillContext["bot"], position: Vec3): BlockSnapshot | undefined {
  try {
    const block = bot.blockAt(position);
    return block ? snapshotBlock(block, vector(position)) : undefined;
  } catch {
    return undefined;
  }
}

function readBotVersion(bot: SkillContext["bot"]): string | undefined {
  const version = (bot as unknown as { version?: unknown }).version;
  return typeof version === "string" && version.trim().length > 0 ? version.trim() : undefined;
}

function vector(position: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}

function positionKey(position: { x: number; y: number; z: number }): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function formatPosition(position: { x: number; y: number; z: number }): string {
  const value = vector(position);
  return `${value.x},${value.y},${value.z}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
