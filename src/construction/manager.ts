import type { AgentTrigger, Bus } from "../bus/index.js";
import type { DB } from "../memory/db.js";
import type { TaskEngine } from "../tasks/engine.js";
import type { Logger } from "../util/logger.js";
import {
  snapshotExecutionActor,
  type ExecutionActor,
} from "../permissions/executionActor.js";
import { assertCurrentConstructionSourceAccess } from "./sourceAccess.js";
import type { BuildRotation } from "./site.js";
import {
  createConstructionJob,
  getBlueprint,
  getBlueprintByName,
  getBlueprintSource,
  listBlueprints,
  getConstructionJob,
  listConstructionJobsByPlan,
  listTerminalMissionConstructionPlans,
  findResumableConstructionJob,
  linkPendingConstructionJobsToPlan,
  markConstructionPlan,
  reconcileConstructionJobsForTerminalTaskPlan,
  setConstructionJobsStatusByPlan,
  setConstructionStatus,
  upsertBlueprint,
  type BlueprintInput,
  type BlueprintRow,
  type BlueprintSourceRow,
  type ConstructionJobRow,
  type ConstructionTerminalTaskPlanStatus,
  type ListTerminalMissionConstructionPlansInput,
  type TerminalMissionConstructionPlan,
} from "./store.js";

/** Never put an entire generated 4,096-cell design into an agent turn. */
export const MAX_BLUEPRINT_PLACEMENT_SAMPLE = 32;

/** Keep an editable source useful without making a read tool an unbounded blob. */
export const MAX_BLUEPRINT_SOURCE_PREVIEW_BYTES = 32 * 1024;

export interface BlueprintListEntry {
  readonly id: number;
  readonly name: string;
  readonly blockCount: number;
  readonly size: readonly [number, number, number];
  readonly materials: Readonly<Record<string, number>>;
  readonly source: BlueprintSourceMetadata | null;
}

export interface BlueprintReadModel extends BlueprintListEntry {
  /** Deterministic sample only; construction execution reads full cells separately. */
  readonly placements: readonly { readonly x: number; readonly y: number; readonly z: number; readonly block: string }[];
  readonly source: BlueprintSourcePreview | null;
}

export interface BlueprintSourceMetadata {
  readonly schema: string;
  readonly targetVersion: string;
  readonly sourceHash: string;
  readonly creator: BlueprintSourceRow["creator"];
  readonly tsCreated: number;
  readonly tsUpdated: number;
}

export interface BlueprintSourcePreview extends BlueprintSourceMetadata {
  /** Parsed canonical source when compact enough for an agent response. */
  readonly definition: unknown | null;
  readonly bytes: number;
  readonly truncated: boolean;
  /** Parsed compiler report; it already contains bounded diagnostics. */
  readonly report: unknown | null;
}

export interface StartConstructionInput {
  blueprintName: string;
  dimension?: string;
  originX: number;
  originY: number;
  originZ: number;
  storageName?: string;
  rotation?: BuildRotation;
  /** Immutable provenance is persisted with every construction task plan. */
  actor: ExecutionActor;
}

/**
 * Explicit no-schedule construction operation for durable composite callers.
 * A MissionService can create all pending jobs inside its run transaction,
 * then link them to its one task plan without calling `startBuild`.
 */
export type CreatePendingBuildInput =
  | (Omit<StartConstructionInput, "blueprintName"> & {
      blueprintName: string;
      blueprintId?: never;
    })
  | (Omit<StartConstructionInput, "blueprintName"> & {
      blueprintName?: never;
      blueprintId: number;
    });

export interface ConstructionManager {
  start(): void;
  stop(): void;
  registerBlueprint(input: BlueprintInput): BlueprintRow;
  /** Bounded projection for agent-facing reads. */
  getBlueprint(name: string): BlueprintReadModel | undefined;
  /** Full placement list for local construction/site logic only. */
  getBlueprintForExecution(name: string): BlueprintRow | undefined;
  listBlueprints(): BlueprintListEntry[];
  /** Creates a pending job only; it never asks TaskEngine to create a plan. */
  createPendingBuild(input: CreatePendingBuildInput): ConstructionJobRow;
  /** Atomically links newly pending jobs into an already-persisted mission plan. */
  linkPendingBuildsToPlan(jobIds: readonly number[], planId: number): ConstructionJobRow[];
  /** Deterministic plural reader for plans that contain multiple builds. */
  getBuildsByPlan(planId: number): ConstructionJobRow[];
  /** Job-only lifecycle helpers; the mission caller owns the TaskEngine action. */
  pauseBuildsByPlan(planId: number): ConstructionJobRow[];
  resumeBuildsByPlan(planId: number): ConstructionJobRow[];
  cancelBuildsByPlan(planId: number): ConstructionJobRow[];
  /**
   * Repair jobs after a terminal task-plan event was missed across a process
   * restart. It never marks a job completed; verified completion remains
   * execution-owned.
   */
  reconcileTerminalBuildsByPlan(
    planId: number,
    taskPlanStatus: ConstructionTerminalTaskPlanStatus,
    error?: string,
  ): ConstructionJobRow[];
  /** Bounded cursor reader for missed terminal MissionScript build transitions. */
  listTerminalMissionBuildPlans(
    input?: ListTerminalMissionConstructionPlansInput,
  ): TerminalMissionConstructionPlan[];
  startBuild(input: StartConstructionInput): ConstructionJobRow;
  getBuild(id: number): ConstructionJobRow | undefined;
  /** Every control action carries the current requester, not a prior plan actor. */
  manageBuild(id: number, action: "pause" | "resume" | "cancel", actor: ExecutionActor): boolean;
  pauseByPlan(planId: number): ConstructionJobRow | undefined;
}

export function createConstructionManager(deps: {
  db: DB;
  bus: Bus;
  log: Logger;
  tasks: TaskEngine;
  ownerUsername: string;
  /** The profile version that compiled BuildOps sources must match exactly. */
  configuredVersion: string;
  /** Read at each source-backed start/resume boundary; never cache a bot version. */
  getLiveVersion: () => string | undefined;
  now?: () => number;
}): ConstructionManager {
  const now = deps.now ?? Date.now;
  let started = false;

  function schedule(job: ConstructionJobRow, actor: ExecutionActor): ConstructionJobRow {
    const plan = deps.tasks.create({
      title: `build ${job.blueprintName} at ${job.originX},${job.originY},${job.originZ}`,
      steps: [
        {
          skill: "prepareBlueprintMaterials",
          params: { jobId: job.id },
          maxAttempts: 2,
        },
        {
          skill: "buildBlueprint",
          params: { jobId: job.id },
          maxAttempts: 3,
        },
      ],
      actor,
    });
    if (!markConstructionPlan(deps.db, job.id, plan.id, now())) {
      // A pause/cancel can win after the task plan is persisted but before it
      // is linked to the construction job. The controller cannot see that
      // unlinked plan, so cancel it here rather than leaving runnable orphan
      // work behind.
      deps.tasks.cancel(plan.id);
      deps.log.warn(
        { constructionJobId: job.id, planId: plan.id, blueprint: job.blueprintName },
        "discarded unlinked construction plan after control-plane transition",
      );
      return getConstructionJob(deps.db, job.id)!;
    }
    deps.log.info(
      { constructionJobId: job.id, planId: plan.id, blueprint: job.blueprintName },
      "construction scheduled",
    );
    return getConstructionJob(deps.db, job.id)!;
  }

  function assertCurrentSourceAccess(blueprint: BlueprintRow, actor: ExecutionActor): void {
    // Raw/private rows retain their established behavior. A generated source,
    // however, cannot enqueue preparation or placement unless both selected
    // profile and live client identify the exact source target version.
    if (!getBlueprintSource(deps.db, blueprint.id)) return;
    const liveVersion = deps.getLiveVersion();
    if (liveVersion === undefined) {
      throw new Error(
        `blueprint '${blueprint.name}' is source-backed, but the live Minecraft version is unavailable`,
      );
    }
    assertCurrentConstructionSourceAccess({
      db: deps.db,
      ownerUsername: deps.ownerUsername,
      blueprint,
      actor,
      configuredVersion: deps.configuredVersion,
      liveVersion,
    });
  }

  function resolvePendingBuild(input: CreatePendingBuildInput): {
    actor: ExecutionActor;
    blueprint: BlueprintRow;
  } {
    const actor = snapshotExecutionActor(input.actor);
    const hasName = typeof input.blueprintName === "string" && input.blueprintName.trim().length > 0;
    const hasId = Number.isSafeInteger(input.blueprintId) && (input.blueprintId as number) > 0;
    if (hasName === hasId) {
      throw new Error("construction build requires exactly one of blueprintName or blueprintId");
    }
    const blueprint = hasName
      ? getBlueprintByName(deps.db, input.blueprintName!.trim())
      : getBlueprint(deps.db, input.blueprintId!);
    if (!blueprint) {
      throw new Error(hasName
        ? `no blueprint named '${input.blueprintName!.trim()}'`
        : `no blueprint ${input.blueprintId}`);
    }
    assertCurrentSourceAccess(blueprint, actor);
    return { actor, blueprint };
  }

  const onTrigger = (trigger: AgentTrigger): void => {
    if (trigger.kind !== "taskPlanDone" && trigger.kind !== "taskPlanFailed") return;
    const jobs = listConstructionJobsByPlan(deps.db, trigger.planId);
    if (jobs.length === 0) return;
    if (trigger.kind === "taskPlanDone") {
      // A durable task plan finishing only means its steps returned success.
      // `buildBlueprint` is the construction completion authority: it performs
      // the final live-world comparison and writes `completed` only once every
      // required cell matches. Never turn an incomplete/blocked job into a
      // falsely completed build just because the surrounding plan ended.
      setConstructionJobsStatusByPlan(
        deps.db,
        trigger.planId,
        "failed",
        "task plan completed without a verified construction completion",
        now(),
      );
      return;
    }
    // The skill records material shortages as blocked so an explicit resume
    // can create a fresh plan after the inventory or storage index is fixed.
    setConstructionJobsStatusByPlan(deps.db, trigger.planId, "failed", trigger.error, now());
  };

  function start(): void {
    if (started) return;
    started = true;
    deps.bus.on("agent.trigger", onTrigger);
  }

  function stop(): void {
    if (!started) return;
    started = false;
    deps.bus.off("agent.trigger", onTrigger);
  }

  function createPendingBuild(input: CreatePendingBuildInput): ConstructionJobRow {
    const { blueprint } = resolvePendingBuild(input);
    return createPendingJob(blueprint, input);
  }

  function createPendingJob(
    blueprint: BlueprintRow,
    input: Omit<StartConstructionInput, "blueprintName">,
  ): ConstructionJobRow {
    return createConstructionJob(deps.db, {
      blueprintId: blueprint.id,
      dimension: input.dimension,
      originX: input.originX,
      originY: input.originY,
      originZ: input.originZ,
      storageName: input.storageName,
      rotation: input.rotation,
    }, now());
  }

  function linkPendingBuildsToPlan(
    jobIds: readonly number[],
    planId: number,
  ): ConstructionJobRow[] {
    return linkPendingConstructionJobsToPlan(deps.db, jobIds, planId, now());
  }

  function getBuildsByPlan(planId: number): ConstructionJobRow[] {
    return listConstructionJobsByPlan(deps.db, planId);
  }

  function pauseBuildsByPlan(planId: number): ConstructionJobRow[] {
    return setConstructionJobsStatusByPlan(deps.db, planId, "paused", undefined, now());
  }

  function resumeBuildsByPlan(planId: number): ConstructionJobRow[] {
    return setConstructionJobsStatusByPlan(deps.db, planId, "running", undefined, now());
  }

  function cancelBuildsByPlan(planId: number): ConstructionJobRow[] {
    return setConstructionJobsStatusByPlan(deps.db, planId, "cancelled", undefined, now());
  }

  function reconcileTerminalBuildsByPlan(
    planId: number,
    taskPlanStatus: ConstructionTerminalTaskPlanStatus,
    error?: string,
  ): ConstructionJobRow[] {
    return reconcileConstructionJobsForTerminalTaskPlan(
      deps.db,
      planId,
      taskPlanStatus,
      error,
      now(),
    );
  }

  function listTerminalMissionBuildPlans(
    input: ListTerminalMissionConstructionPlansInput = {},
  ): TerminalMissionConstructionPlan[] {
    return listTerminalMissionConstructionPlans(deps.db, input);
  }

  function startBuild(input: StartConstructionInput): ConstructionJobRow {
    const { actor, blueprint } = resolvePendingBuild(input);
    const existing = findResumableConstructionJob(deps.db, {
      blueprintId: blueprint.id,
      dimension: input.dimension ?? "overworld",
      originX: input.originX,
      originY: input.originY,
      originZ: input.originZ,
      rotation: input.rotation ?? 0,
    });
    if (existing) {
      if (["paused", "blocked", "failed"].includes(existing.status)) {
        if (!manageBuild(existing.id, "resume", actor)) {
          throw new Error(`could not resume construction job ${existing.id}`);
        }
      }
      deps.log.info(
        { constructionJobId: existing.id, blueprint: blueprint.name },
        "reused matching construction job",
      );
      return getConstructionJob(deps.db, existing.id)!;
    }
    const job = createPendingJob(blueprint, input);
    return schedule(job, actor);
  }

  function manageBuild(
    id: number,
    action: "pause" | "resume" | "cancel",
    requester: ExecutionActor,
  ): boolean {
    const actor = snapshotExecutionActor(requester);
    const job = getConstructionJob(deps.db, id);
    if (!job) return false;
    if (action === "pause") {
      if (!["pending", "running", "blocked"].includes(job.status)) return false;
      if (job.lastPlanId) deps.tasks.pause(job.lastPlanId);
      return setConstructionStatus(deps.db, id, "paused", undefined, now());
    }
    if (action === "cancel") {
      if (["completed", "cancelled"].includes(job.status)) return false;
      if (job.lastPlanId) deps.tasks.cancel(job.lastPlanId);
      return setConstructionStatus(deps.db, id, "cancelled", undefined, now());
    }
    if (!["paused", "blocked", "failed"].includes(job.status)) return false;
    const blueprint = getBlueprint(deps.db, job.blueprintId);
    if (!blueprint) return false;
    try {
      // An older plan's actor is audit history, never authority for a new
      // requester. Reauthorize the requester just before a fresh plan can add
      // material or make a world mutation.
      assertCurrentSourceAccess(blueprint, actor);
    } catch (error) {
      deps.log.warn(
        { constructionJobId: job.id, blueprint: blueprint.name, error: errorMessage(error) },
        "construction resume denied by current source access",
      );
      return false;
    }

    // A paused plan retains immutable actor provenance. Do not revive it for a
    // different requester (which could silently execute under an old owner).
    // Cancel the prior plan after authorization and enqueue a fresh attempt
    // with the requester snapshot instead. This also avoids reusing a paused
    // active plan through TaskEngine's matching-plan deduplication.
    if (job.lastPlanId !== null) deps.tasks.cancel(job.lastPlanId);
    if (!setConstructionStatus(deps.db, id, "pending", undefined, now())) return false;
    schedule(getConstructionJob(deps.db, id)!, actor);
    return true;
  }

  function pauseByPlan(planId: number): ConstructionJobRow | undefined {
    // Compatibility projection for emergency-stop callers that historically
    // displayed one construction job ID. The actual transition is plural so a
    // shared mission plan cannot leave a sibling build runnable.
    return pauseBuildsByPlan(planId).find((job) => job.status === "paused");
  }

  return {
    start,
    stop,
    registerBlueprint: (input) => upsertBlueprint(deps.db, input, now()),
    getBlueprint: (name) => {
      const row = getBlueprintByName(deps.db, name);
      return row ? toBlueprintReadModel(getBlueprint(deps.db, row.id)!, getBlueprintSource(deps.db, row.id)) : undefined;
    },
    getBlueprintForExecution: (name) => {
      const row = getBlueprintByName(deps.db, name);
      return row ? getBlueprint(deps.db, row.id) : undefined;
    },
    listBlueprints: () => listBlueprints(deps.db).map((blueprint) =>
      toBlueprintListEntry(blueprint, getBlueprintSource(deps.db, blueprint.id))),
    createPendingBuild,
    linkPendingBuildsToPlan,
    getBuildsByPlan,
    pauseBuildsByPlan,
    resumeBuildsByPlan,
    cancelBuildsByPlan,
    reconcileTerminalBuildsByPlan,
    listTerminalMissionBuildPlans,
    startBuild,
    getBuild: (id) => getConstructionJob(deps.db, id),
    manageBuild,
    pauseByPlan,
  };
}

function toBlueprintReadModel(
  blueprint: BlueprintRow,
  source: BlueprintSourceRow | undefined,
): BlueprintReadModel {
  return {
    ...toBlueprintListEntry(blueprint, source),
    placements: blueprint.blocks.slice(0, MAX_BLUEPRINT_PLACEMENT_SAMPLE).map((block) => ({ ...block })),
    source: source ? toBlueprintSourcePreview(source) : null,
  };
}

function toBlueprintListEntry(
  blueprint: BlueprintRow,
  source: BlueprintSourceRow | undefined,
): BlueprintListEntry {
  const xs = blueprint.blocks.map((entry) => entry.x);
  const ys = blueprint.blocks.map((entry) => entry.y);
  const zs = blueprint.blocks.map((entry) => entry.z);
  const materials = new Map<string, number>();
  for (const entry of blueprint.blocks) {
    materials.set(entry.block, (materials.get(entry.block) ?? 0) + 1);
  }
  return {
    id: blueprint.id,
    name: blueprint.name,
    blockCount: blueprint.blocks.length,
    size: [
      Math.max(...xs) - Math.min(...xs) + 1,
      Math.max(...ys) - Math.min(...ys) + 1,
      Math.max(...zs) - Math.min(...zs) + 1,
    ],
    materials: Object.fromEntries(materials),
    source: source ? toBlueprintSourceMetadata(source) : null,
  };
}

function toBlueprintSourceMetadata(source: BlueprintSourceRow): BlueprintSourceMetadata {
  return {
    schema: source.schema,
    targetVersion: source.targetVersion,
    sourceHash: source.sourceHash,
    creator: { ...source.creator },
    tsCreated: source.tsCreated,
    tsUpdated: source.tsUpdated,
  };
}

function toBlueprintSourcePreview(source: BlueprintSourceRow): BlueprintSourcePreview {
  const bytes = Buffer.byteLength(source.sourceJson, "utf8");
  return {
    ...toBlueprintSourceMetadata(source),
    definition: bytes <= MAX_BLUEPRINT_SOURCE_PREVIEW_BYTES
      ? parseJson(source.sourceJson)
      : null,
    bytes,
    truncated: bytes > MAX_BLUEPRINT_SOURCE_PREVIEW_BYTES,
    report: parseJson(source.compileReportJson),
  };
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Existing raw blueprints can have no source; source-backed rows are
    // validated on write, but a corrupted local DB must not crash a read tool.
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
