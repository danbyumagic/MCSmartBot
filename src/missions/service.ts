import type { AgentTrigger, Bus } from "../bus/index.js";
import type { Bot } from "mineflayer";
import {
  canonicalizeBuildSource,
  hashBuildSource,
} from "../construction/buildOps/compiler.js";
import type { BuildBlockRegistry } from "../construction/buildOps/types.js";
import type { ConstructionManager } from "../construction/manager.js";
import {
  fingerprintBlueprintExecution,
  getBlueprint,
  getBlueprintSource,
  registerCompiledBlueprint,
} from "../construction/store.js";
import { analyzeBuildSite, type BuildSiteAnalysis } from "../construction/site.js";
import type { DB } from "../memory/db.js";
import {
  resolveCurrentExecutionRole,
  snapshotExecutionActor,
  type ExecutionActor,
} from "../permissions/executionActor.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { TaskEngine } from "../tasks/engine.js";
import { createTaskPlan, getTaskPlan, type TaskPlanDetail } from "../tasks/store.js";
import type { Logger } from "../util/logger.js";
import {
  bindMissionConstructionJobs,
  compileMissionDefinition,
  type CompiledMission,
  type MissionCompiledBuild,
  type MissionCompileError,
  type MissionCompileReport,
  type MissionCompileResult,
} from "./compiler.js";
import {
  appendMissionStepLinks,
  attachMissionRunTaskPlan,
  createMissionRun,
  getMissionDefinition,
  getMissionRun,
  listActiveMissionRuns,
  listMissionDefinitions,
  listMissionRuns,
  saveMissionDefinition,
  transitionMissionRun,
  type MissionStoreError,
} from "./store.js";
import { hashMissionSource, parseMissionDefinition } from "./schema.js";
import type {
  MissionDefinition,
  MissionDefinitionDetail,
  MissionDefinitionSummary,
  MissionJsonValue,
  MissionRunDetail,
  MissionRunSummary,
} from "./types.js";

/** Keep tool/service error payloads concise and deterministic. */
export const MAX_MISSION_SERVICE_ERRORS = 32;

export type MissionServiceErrorCode =
  | "MISSION_INVALID"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "WORLD_UNAVAILABLE"
  | "MATERIALIZATION_FAILED"
  | "INVALID_STATE"
  | "PERSISTENCE_FAILED";

export interface MissionServiceError {
  readonly code: MissionServiceErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly compileErrors?: readonly MissionCompileError[];
}

export type MissionServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MissionServiceError };

export interface MissionRunMaterialization {
  readonly run: MissionRunDetail;
  readonly plan: TaskPlanDetail;
  readonly constructionJobIds: readonly number[];
  readonly report: MissionCompileReport;
}

export interface MissionBuildPreview {
  readonly stepId: string;
  readonly available: boolean;
  readonly reason?: string;
  readonly safe?: boolean;
  readonly correctWorldCells?: number;
  readonly pendingWorldCells?: number;
  readonly issueCounts?: BuildSiteAnalysis["issueCounts"];
  readonly issues?: readonly BuildSiteAnalysis["issues"][number][];
}

export interface MissionPreview {
  readonly compilation: CompiledMission;
  /** Empty for no-build missions; unavailable entries never simulate a world. */
  readonly buildSites: readonly MissionBuildPreview[];
}

export type MissionPreviewResult =
  | { readonly ok: true; readonly value: MissionPreview }
  | { readonly ok: false; readonly errors: readonly MissionCompileError[] };

export interface MissionService {
  start(): void;
  stop(): void;
  /** Re-derive nonterminal run state from the linked durable task plan. */
  reconcile(): void;
  validate(input: { readonly definition: unknown; readonly actor: ExecutionActor }): MissionCompileResult;
  preview(input: { readonly definition: unknown; readonly actor: ExecutionActor }): MissionPreviewResult;
  save(input: {
    readonly definition: unknown;
    readonly actor: ExecutionActor;
    readonly replace?: boolean;
    readonly enabled?: boolean;
  }): MissionServiceResult<MissionDefinitionDetail>;
  getDefinition(id: number): MissionDefinitionDetail | undefined;
  listDefinitions(input?: { readonly enabled?: boolean; readonly limit?: number }): MissionDefinitionSummary[];
  run(input: {
    readonly definitionId?: number;
    readonly definition?: unknown;
    readonly actor: ExecutionActor;
  }): MissionServiceResult<MissionRunMaterialization>;
  getRun(id: number): MissionRunDetail | undefined;
  listRuns(input?: {
    readonly definitionId?: number;
    readonly taskPlanId?: number;
    readonly status?: MissionRunSummary["status"];
    readonly limit?: number;
  }): MissionRunSummary[];
  manageRun(input: {
    readonly runId: number;
    readonly action: "pause" | "resume" | "cancel";
    readonly actor: ExecutionActor;
  }): MissionServiceResult<MissionRunDetail>;
}

export interface MissionServiceDeps {
  readonly db: DB;
  readonly bus: Bus;
  readonly log: Logger;
  readonly registry: SkillRegistry;
  readonly tasks: Pick<TaskEngine, "wake" | "pause" | "resume" | "cancel">;
  readonly construction: Pick<
    ConstructionManager,
    "createPendingBuild" | "linkPendingBuildsToPlan" | "getBuildsByPlan" |
    "pauseBuildsByPlan" | "resumeBuildsByPlan" | "cancelBuildsByPlan" |
    "reconcileTerminalBuildsByPlan" | "listTerminalMissionBuildPlans"
  >;
  readonly ownerUsername: string;
  readonly registryForVersion: (targetVersion: string) => BuildBlockRegistry | undefined;
  /** Build jobs must record a live dimension rather than guessing overworld. */
  readonly getLiveDimension: () => string | undefined;
  /** Optional because headless/testing profiles may not have a connected bot. */
  readonly getLiveBot?: () => Bot | undefined;
  readonly now?: () => number;
}

/**
 * The only MissionScript coordinator. It deliberately compiles to existing
 * task steps and construction jobs; it never invokes skill handlers itself.
 */
export function createMissionService(deps: MissionServiceDeps): MissionService {
  const now = deps.now ?? Date.now;
  let started = false;

  function resolveRunSource(input: {
    readonly definitionId?: number;
    readonly definition?: unknown;
  }): MissionServiceResult<{
    readonly definition: MissionDefinition;
    readonly definitionId?: number;
    readonly sourceHash: string;
  }> {
    const hasId = input.definitionId !== undefined;
    const hasDefinition = input.definition !== undefined;
    if (hasId === hasDefinition) {
      return failure(
        "MISSION_INVALID",
        "runMission requires exactly one of definitionId or definition",
      );
    }
    if (hasId) {
      try {
        const saved = getMissionDefinition(deps.db, input.definitionId!);
        if (!saved) return failure("NOT_FOUND", `no mission definition ${input.definitionId}`);
        if (!saved.enabled) {
          return failure("INVALID_STATE", `mission definition '${saved.name}' is disabled`);
        }
        return {
          ok: true,
          value: {
            definition: saved.definition,
            definitionId: saved.id,
            sourceHash: saved.sourceHash,
          },
        };
      } catch (error) {
        return storeFailure("could not read mission definition", error, "MISSION_INVALID");
      }
    }
    try {
      const definition = parseMissionDefinition(input.definition);
      return {
        ok: true,
        value: { definition, sourceHash: hashMissionSource(definition) },
      };
    } catch (error) {
      return failure("MISSION_INVALID", `invalid mission definition: ${errorMessage(error)}`);
    }
  }

  function buildDimension(compilation: CompiledMission): MissionServiceResult<string> {
    if (!compilation.logicalSteps.some((step) => step.build !== null)) {
      // It is never used for a no-build mission, but keeping this value local
      // avoids a special materialization path that could drift over time.
      return { ok: true, value: "overworld" };
    }
    const value = deps.getLiveDimension();
    const dimension = typeof value === "string" ? value.trim() : "";
    if (!dimension || dimension.length > 64) {
      return failure(
        "WORLD_UNAVAILABLE",
        "a connected Minecraft dimension is required before materializing build mission steps",
      );
    }
    return { ok: true, value: dimension };
  }

  function compileForActor(definition: unknown, requestedActor: ExecutionActor): MissionCompileResult {
    let actor: ExecutionActor;
    try {
      actor = snapshotExecutionActor(requestedActor);
    } catch (error) {
      return compileActorFailure(error);
    }
    const currentRole = resolveCurrentExecutionRole(deps.db, actor, deps.ownerUsername);
    if (!currentRole) {
      return {
        ok: false,
        errors: Object.freeze([{
          stepId: null,
          code: "ACTOR_INVALID",
          message: `actor '${actor.username}' no longer has a permitted role`,
        }]),
      };
    }
    return compileMissionDefinition(definition, {
      registry: deps.registry,
      actor: { ...actor, role: currentRole },
      registryForVersion: deps.registryForVersion,
      db: deps.db,
    });
  }

  /**
   * Tool adapters enforce this too, but MissionService is a durable write
   * boundary and must not depend on every future caller remembering a wrapper.
   */
  function authorizeMissionWriter(requestedActor: ExecutionActor): MissionServiceResult<ExecutionActor> {
    let actor: ExecutionActor;
    try {
      actor = snapshotExecutionActor(requestedActor);
    } catch (error) {
      return failure("PERMISSION_DENIED", `invalid mission actor: ${errorMessage(error)}`);
    }
    const currentRole = resolveCurrentExecutionRole(deps.db, actor, deps.ownerUsername);
    if (currentRole !== "owner" && currentRole !== "operator") {
      return failure(
        "PERMISSION_DENIED",
        `actor '${actor.username}' no longer has operator access to save or run missions`,
      );
    }
    return { ok: true, value: snapshotExecutionActor({ ...actor, role: currentRole }) };
  }

  function validate(input: { readonly definition: unknown; readonly actor: ExecutionActor }): MissionCompileResult {
    return compileForActor(input.definition, input.actor);
  }

  function preview(input: { readonly definition: unknown; readonly actor: ExecutionActor }): MissionPreviewResult {
    const compilation = compileForActor(input.definition, input.actor);
    if (!compilation.ok) return compilation;
    let bot: Bot | undefined;
    try {
      bot = deps.getLiveBot?.();
    } catch (error) {
      // Structural validation remains useful even while a connection object is
      // tearing down. Never let a read-only optional inspection turn that into
      // a preview failure.
      return previewWithUnavailableSites(
        compilation.value,
        `live bot inspection is unavailable: ${boundedInspectionReason(error)}`,
      );
    }
    const connected = bot?.entity && bot.game?.dimension;
    const buildSites = compilation.value.logicalSteps
      .filter((step) => step.build !== null)
      .map((step) => {
        const build = step.build!;
        if (!connected || !bot) {
          return Object.freeze({
            stepId: step.logicalStepId,
            available: false,
            reason: "bot is not connected; structural mission preview completed without a live site check",
          });
        }
        const inputCells = build.kind === "named"
          ? build.blueprint.placementUnits
          : build.compiled.placements.map((placement) => ({
            x: placement.x,
            y: placement.y,
            z: placement.z,
            block: placement.block,
            ...(placement.hint === undefined ? {} : { hint: { ...placement.hint } }),
          }));
        try {
          const site = analyzeBuildSite(bot, inputCells, {
            originX: build.origin[0],
            originY: build.origin[1],
            originZ: build.origin[2],
          }, build.rotation, { maxIssueSamples: 32 });
          return Object.freeze({
            stepId: step.logicalStepId,
            available: true,
            safe: site.safe,
            correctWorldCells: site.correctWorldCells,
            pendingWorldCells: site.pendingWorldCells,
            issueCounts: { ...site.issueCounts },
            issues: Object.freeze(site.issues.map((issue) => ({ ...issue, position: { ...issue.position } }))),
          });
        } catch (error) {
          return Object.freeze({
            stepId: step.logicalStepId,
            available: false,
            reason: `live site inspection is unavailable: ${boundedInspectionReason(error)}`,
          });
        }
      });
    return {
      ok: true,
      value: Object.freeze({ compilation: compilation.value, buildSites: Object.freeze(buildSites) }),
    };
  }

  function save(input: {
    readonly definition: unknown;
    readonly actor: ExecutionActor;
    readonly replace?: boolean;
    readonly enabled?: boolean;
  }): MissionServiceResult<MissionDefinitionDetail> {
    const writer = authorizeMissionWriter(input.actor);
    if (!writer.ok) return writer;
    const compiled = compileForActor(input.definition, writer.value);
    if (!compiled.ok) return compileFailure(compiled.errors);
    try {
      const definition = saveMissionDefinition(deps.db, {
        definition: compiled.value.definition,
        creator: compiled.value.actor,
        ...(input.replace === undefined ? {} : { replace: input.replace }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      }, now());
      return { ok: true, value: definition };
    } catch (error) {
      return storeFailure("could not save mission", error);
    }
  }

  function run(input: {
    readonly definitionId?: number;
    readonly definition?: unknown;
    readonly actor: ExecutionActor;
  }): MissionServiceResult<MissionRunMaterialization> {
    const writer = authorizeMissionWriter(input.actor);
    if (!writer.ok) return writer;
    const source = resolveRunSource(input);
    if (!source.ok) return source;
    const compiled = compileForActor(source.value.definition, writer.value);
    if (!compiled.ok) return compileFailure(compiled.errors);
    const dimension = buildDimension(compiled.value);
    if (!dimension.ok) return dimension;

    try {
      const materialize = deps.db.transaction(() => {
        // `createMissionRun` recaptures canonical source/hash from the saved
        // definition (when used) in the same outer transaction as every job
        // and task row below.
        const run = createMissionRun(deps.db, {
          ...(source.value.definitionId === undefined
            ? { definition: compiled.value.definition }
            : { definitionId: source.value.definitionId, definition: compiled.value.definition }),
          actor: compiled.value.actor,
          compileReport: reportJson(compiled.value.report),
          transactionCorrelation: {
            missionName: compiled.value.definition.name,
            sourceHash: source.value.sourceHash,
          },
        }, now());

        const jobIds = new Map<string, number>();
        for (const logical of compiled.value.logicalSteps) {
          if (logical.build === null) continue;
          const build = logical.build;
          const blueprintId = build.kind === "named"
            ? assertCurrentNamedBuildFingerprint(deps.db, build)
            : persistInlineBlueprint(run.id, logical.logicalStepId, build, compiled.value.actor);
          const job = deps.construction.createPendingBuild({
            blueprintId,
            dimension: dimension.value,
            originX: build.origin[0],
            originY: build.origin[1],
            originZ: build.origin[2],
            rotation: build.rotation,
            actor: compiled.value.actor,
          });
          jobIds.set(logical.logicalStepId, job.id);
        }

        const bound = bindMissionConstructionJobs(compiled.value, jobIds);
        const plan = createTaskPlan(deps.db, {
          title: boundedPlanTitle(compiled.value.definition.name, run.id),
          steps: bound.taskSteps.map((step) => ({
            skill: step.skill,
            params: { ...step.params },
            maxAttempts: step.maxAttempts,
          })),
          actor: compiled.value.actor,
        });
        const constructionJobIds = [...jobIds.values()];
        if (constructionJobIds.length > 0) {
          deps.construction.linkPendingBuildsToPlan(constructionJobIds, plan.id);
        }
        appendMissionStepLinks(deps.db, run.id, bound.stepLinks, now());
        attachMissionRunTaskPlan(deps.db, run.id, plan.id, now());
        const startedRun = transitionMissionRun(deps.db, run.id, "running", {}, now());
        if (!startedRun) throw new Error(`mission run ${run.id} disappeared during materialization`);
        return Object.freeze({
          run: startedRun,
          plan: getTaskPlan(deps.db, plan.id)!,
          constructionJobIds: Object.freeze(constructionJobIds.slice()),
          report: bound.compileReport,
        });
      });
      const created = materialize();
      // Do this only once every row is committed. The task engine can never
      // observe a partial plan/job/link set.
      deps.tasks.wake();
      return { ok: true, value: created };
    } catch (error) {
      return storeFailure("could not materialize mission", error, "MATERIALIZATION_FAILED");
    }
  }

  function manageRun(input: {
    readonly runId: number;
    readonly action: "pause" | "resume" | "cancel";
    readonly actor: ExecutionActor;
  }): MissionServiceResult<MissionRunDetail> {
    const run = getMissionRun(deps.db, input.runId);
    if (!run) return failure("NOT_FOUND", `no mission run ${input.runId}`);
    if (run.taskPlanId === null) {
      return failure("INVALID_STATE", `mission run ${run.id} has no durable task plan`);
    }
    let requester: ExecutionActor;
    try {
      requester = snapshotExecutionActor(input.actor);
    } catch (error) {
      return failure("PERMISSION_DENIED", `invalid mission control actor: ${errorMessage(error)}`);
    }
    const currentRole = resolveCurrentExecutionRole(deps.db, requester, deps.ownerUsername);
    if (currentRole !== "owner" && currentRole !== "operator") {
      return failure("PERMISSION_DENIED", `actor '${requester.username}' no longer has operator access`);
    }
    // Pause/cancel are safety controls: a currently authorized operator must
    // always be able to stop durable work even if an old blueprint was later
    // removed or its source/report is corrupt. Resume can lead to fresh world
    // work, so it recompiles the immutable source against the current requester
    // and current source-backed build boundary.
    if (input.action === "resume") {
      let definition: MissionDefinition;
      try {
        definition = parseMissionDefinition(JSON.parse(run.sourceJson));
      } catch (error) {
        return failure("PERSISTENCE_FAILED", `mission run ${run.id} has invalid immutable source: ${errorMessage(error)}`);
      }
      const authorization = compileForActor(definition, requester);
      if (!authorization.ok) return compileFailure(authorization.errors);
    }
    try {
      if (input.action === "pause") {
        if (run.status !== "running" || !deps.tasks.pause(run.taskPlanId)) {
          return failure("INVALID_STATE", `mission run ${run.id} cannot be paused from ${run.status}`);
        }
        deps.construction.pauseBuildsByPlan(run.taskPlanId);
        const paused = transitionMissionRun(deps.db, run.id, "paused", {}, now());
        return paused ? { ok: true, value: paused } : failure("NOT_FOUND", `mission run ${run.id} disappeared`);
      }
      if (input.action === "resume") {
        if (run.status !== "paused") {
          return failure("INVALID_STATE", `mission run ${run.id} cannot be resumed from ${run.status}`);
        }
        // Keep the mission non-runnable while the three durable substrates
        // are restored. TaskEngine's linked-run guard will not claim a plan
        // while this is pending, even though resume() schedules a drain.
        const pending = transitionMissionRun(deps.db, run.id, "pending", {}, now());
        if (!pending) return failure("NOT_FOUND", `mission run ${run.id} disappeared`);
        try {
          deps.construction.resumeBuildsByPlan(run.taskPlanId);
          if (!deps.tasks.resume(run.taskPlanId)) {
            throw new Error("linked task plan could not be resumed");
          }
          const resumed = transitionMissionRun(deps.db, run.id, "running", {}, now());
          if (!resumed) throw new Error("mission run disappeared during resume");
          deps.tasks.wake();
          return { ok: true, value: resumed };
        } catch (error) {
          // Best-effort compensation leaves every durable work source held;
          // even if a store failure prevents one of these writes, the engine
          // only runs a linked plan when its mission is `running`.
          deps.tasks.pause(run.taskPlanId);
          deps.construction.pauseBuildsByPlan(run.taskPlanId);
          try {
            transitionMissionRun(deps.db, run.id, "paused", {
              error: `mission resume did not complete: ${errorMessage(error)}`,
            }, now());
          } catch (transitionError) {
            deps.log.warn(
              { err: transitionError, missionRunId: run.id },
              "could not compensate an incomplete mission resume",
            );
          }
          return failure("INVALID_STATE", `mission run ${run.id} could not be resumed safely: ${errorMessage(error)}`);
        }
      }
      if (!deps.tasks.cancel(run.taskPlanId)) {
        return failure("INVALID_STATE", `mission run ${run.id} cannot be cancelled from ${run.status}`);
      }
      deps.construction.cancelBuildsByPlan(run.taskPlanId);
      const cancelled = transitionMissionRun(deps.db, run.id, "cancelled", {}, now());
      return cancelled
        ? { ok: true, value: cancelled }
        : failure("NOT_FOUND", `mission run ${run.id} disappeared`);
    } catch (error) {
      return storeFailure(`could not ${input.action} mission run ${run.id}`, error, "INVALID_STATE");
    }
  }

  function reconcile(): void {
    reconcileMissedTerminalMissionBuilds();
    // User-facing list results are intentionally capped, but restart recovery
    // cannot be. Page deterministic active IDs until exhaustion so an older
    // live run is not hidden behind a busy history of terminal runs.
    let afterId = 0;
    for (;;) {
      const batch = listActiveMissionRuns(deps.db, { afterId, limit: 100 });
      if (batch.length === 0) break;
      for (const summary of batch) {
        const run = getMissionRun(deps.db, summary.id);
        if (!run || run.taskPlanId === null) continue;
        const plan = getTaskPlan(deps.db, run.taskPlanId);
        try {
          if (!plan) {
            if (run.status !== "failed") transitionMissionRun(deps.db, run.id, "failed", {
              error: "linked task plan is missing during mission reconciliation",
            }, now());
            continue;
          }
          switch (plan.status) {
            case "completed":
              deps.construction.reconcileTerminalBuildsByPlan(run.taskPlanId, "completed");
              settleCompletedPlan(run);
              break;
            case "failed":
              deps.construction.reconcileTerminalBuildsByPlan(
                run.taskPlanId,
                "failed",
                plan.lastError ?? undefined,
              );
              if (run.status === "running" || run.status === "pending") {
                transitionMissionRun(deps.db, run.id, "failed", { error: plan.lastError ?? "mission task plan failed" }, now());
              }
              break;
            case "cancelled":
              deps.construction.reconcileTerminalBuildsByPlan(run.taskPlanId, "cancelled");
              if (run.status !== "cancelled") transitionMissionRun(deps.db, run.id, "cancelled", {}, now());
              break;
            case "paused":
              deps.construction.pauseBuildsByPlan(run.taskPlanId);
              if (run.status === "running" || run.status === "pending") transitionMissionRun(deps.db, run.id, "paused", {}, now());
              break;
            case "pending":
            case "running":
              // Restart recovery resets task plans to pending. The mission is
              // still active; retain `running` rather than inventing an invalid
              // running -> pending lifecycle transition.
              if (run.status === "pending") transitionMissionRun(deps.db, run.id, "running", {}, now());
              break;
          }
        } catch (error) {
          deps.log.warn({ err: error, missionRunId: run.id }, "mission reconciliation deferred");
        }
      }
      afterId = batch[batch.length - 1]!.id;
    }
  }

  /**
   * A task event can persist a terminal mission run just before process loss
   * prevents its linked construction job from observing the same event. This
   * scan is intentionally independent of active-run recovery, because the
   * run is already terminal in that crash window. The manager reader is
   * bounded; cursor paging visits every stale terminal plan deterministically.
   */
  function reconcileMissedTerminalMissionBuilds(): void {
    let afterPlanId = 0;
    for (;;) {
      let batch;
      try {
        batch = deps.construction.listTerminalMissionBuildPlans({ afterPlanId, limit: 100 });
      } catch (error) {
        deps.log.warn({ err: error }, "terminal mission construction reconciliation deferred");
        return;
      }
      if (batch.length === 0) return;
      for (const candidate of batch) {
        try {
          deps.construction.reconcileTerminalBuildsByPlan(
            candidate.planId,
            candidate.taskPlanStatus,
            candidate.taskPlanError ?? undefined,
          );
        } catch (error) {
          deps.log.warn(
            { err: error, taskPlanId: candidate.planId },
            "terminal mission construction reconciliation deferred",
          );
        }
      }
      afterPlanId = batch[batch.length - 1]!.planId;
    }
  }

  function settleCompletedPlan(run: MissionRunDetail): void {
    if (run.status !== "running" && run.status !== "pending") return;
    const jobs = deps.construction.getBuildsByPlan(run.taskPlanId!);
    const incomplete = jobs.find((job) => job.status !== "completed");
    transitionMissionRun(
      deps.db,
      run.id,
      incomplete ? "failed" : "completed",
      incomplete ? { error: `construction job ${incomplete.id} ended ${incomplete.status}` } : {},
      now(),
    );
  }

  const onTrigger = (trigger: AgentTrigger): void => {
    if (trigger.kind !== "taskPlanDone" && trigger.kind !== "taskPlanFailed") return;
    const run = getMissionRunByPlanSafe(trigger.planId);
    if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled") return;
    try {
      if (trigger.kind === "taskPlanDone") {
        deps.construction.reconcileTerminalBuildsByPlan(trigger.planId, "completed");
        settleCompletedPlan(run);
      } else if (run.status === "running" || run.status === "pending") {
        deps.construction.reconcileTerminalBuildsByPlan(trigger.planId, "failed", trigger.error);
        transitionMissionRun(deps.db, run.id, "failed", { error: trigger.error }, now());
      }
    } catch (error) {
      deps.log.warn({ err: error, missionRunId: run.id, planId: trigger.planId }, "mission event reconciliation deferred");
    }
  };

  function start(): void {
    if (started) return;
    started = true;
    deps.bus.on("agent.trigger", onTrigger);
    reconcile();
  }

  function stop(): void {
    if (!started) return;
    started = false;
    deps.bus.off("agent.trigger", onTrigger);
  }

  return {
    start,
    stop,
    reconcile,
    validate,
    preview,
    save,
    getDefinition: (id) => getMissionDefinition(deps.db, id),
    listDefinitions: (input) => listMissionDefinitions(deps.db, input),
    run,
    getRun: (id) => getMissionRun(deps.db, id),
    listRuns: (input) => listMissionRuns(deps.db, input),
    manageRun,
  };

  function persistInlineBlueprint(
    runId: number,
    logicalStepId: string,
    build: Extract<CompiledMission["logicalSteps"][number]["build"], { readonly kind: "inline" }>,
    actor: ExecutionActor,
  ): number {
    const source = canonicalizeBuildSource(build.source);
    const sourceHash = hashBuildSource(build.source);
    const name = missionInlineBlueprintName(runId, logicalStepId, sourceHash);
    const blueprint = registerCompiledBlueprint(deps.db, {
      name,
      blocks: build.compiled.placements.map((placement) => ({
        x: placement.x,
        y: placement.y,
        z: placement.z,
        block: placement.block,
        ...(placement.hint === undefined ? {} : { hint: { ...placement.hint } }),
      })),
      sourceSchema: build.source.schema,
      targetVersion: build.source.targetVersion,
      sourceJson: source,
      sourceHash,
      compileReportJson: JSON.stringify(build.compiled.report),
      creator: actor,
    }, now());
    return blueprint.id;
  }

  function getMissionRunByPlanSafe(planId: number): MissionRunDetail | undefined {
    try {
      // Avoid importing a second store reader into every event body; the
      // unique index guarantees this direct lookup is one run at most.
      const row = listMissionRuns(deps.db, { taskPlanId: planId, limit: 1 })[0];
      return row ? getMissionRun(deps.db, row.id) : undefined;
    } catch (error) {
      deps.log.warn({ err: error, planId }, "could not load mission by task plan");
      return undefined;
    }
  }
}

/**
 * A named build is compiled before MissionService opens its all-or-nothing
 * materialization transaction. Re-read its durable execution content inside
 * that transaction so a mutable no-job blueprint cannot be swapped between
 * compilation and job creation.
 */
function assertCurrentNamedBuildFingerprint(
  db: DB,
  build: Extract<MissionCompiledBuild, { readonly kind: "named" }>,
): number {
  const expected = build.fingerprint;
  const blueprint = getBlueprint(db, expected.blueprintId);
  if (!blueprint) {
    throw new Error("named blueprint disappeared after mission compilation");
  }
  const actual = fingerprintBlueprintExecution(blueprint, getBlueprintSource(db, blueprint.id) ?? null);
  if (
    actual.blueprintId !== expected.blueprintId ||
    actual.blueprintName !== expected.blueprintName ||
    actual.cellsHash !== expected.cellsHash ||
    actual.sourceHash !== expected.sourceHash ||
    actual.targetVersion !== expected.targetVersion
  ) {
    throw new Error("named blueprint changed after mission compilation");
  }
  return blueprint.id;
}

function compileActorFailure(error: unknown): MissionCompileResult {
  return {
    ok: false,
    errors: Object.freeze([{
      stepId: null,
      code: "ACTOR_INVALID",
      message: `invalid mission actor: ${errorMessage(error)}`,
    }]),
  };
}

function previewWithUnavailableSites(
  compilation: CompiledMission,
  reason: string,
): MissionPreviewResult {
  const buildSites = compilation.logicalSteps
    .filter((step) => step.build !== null)
    .map((step) => Object.freeze({
      stepId: step.logicalStepId,
      available: false,
      reason,
    }));
  return {
    ok: true,
    value: Object.freeze({ compilation, buildSites: Object.freeze(buildSites) }),
  };
}

function boundedInspectionReason(error: unknown): string {
  const message = errorMessage(error).replace(/[\r\n\t]+/g, " ").trim();
  return message.slice(0, 240) || "unknown live inspection error";
}

function compileFailure(errors: readonly MissionCompileError[]): MissionServiceResult<never> {
  const bounded = Object.freeze(errors.slice(0, MAX_MISSION_SERVICE_ERRORS));
  const denied = bounded.some((error) =>
    error.code === "ROLE_DENIED" || error.code === "BUILD_ACCESS_DENIED" || error.code === "ACTOR_INVALID");
  return failure(
    denied ? "PERMISSION_DENIED" : "MISSION_INVALID",
    denied ? "mission authorization failed" : "mission validation failed",
    { errorCount: errors.length },
    bounded,
  );
}

function reportJson(report: MissionCompileReport): Readonly<Record<string, MissionJsonValue>> {
  // Compiler report types are deliberately JSON-shaped. Serializing here makes
  // a fresh plain immutable boundary before it enters MissionStore.
  return JSON.parse(JSON.stringify(report)) as Readonly<Record<string, MissionJsonValue>>;
}

function boundedPlanTitle(name: string, runId: number): string {
  const suffix = ` [mission ${runId}]`;
  return `${name.slice(0, Math.max(1, 160 - suffix.length))}${suffix}`;
}

function missionInlineBlueprintName(runId: number, stepId: string, hash: string): string {
  const prefix = `mission-${runId}-`;
  const suffix = `-${hash.slice(0, 12)}`;
  return `${prefix}${stepId.slice(0, Math.max(1, 120 - prefix.length - suffix.length))}${suffix}`;
}

function failure<T = never>(
  code: MissionServiceErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  compileErrors?: readonly MissionCompileError[],
): MissionServiceResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...(compileErrors === undefined ? {} : { compileErrors }),
    },
  };
}

function storeFailure<T = never>(
  prefix: string,
  error: unknown,
  code: MissionServiceErrorCode = "PERSISTENCE_FAILED",
): MissionServiceResult<T> {
  const typed = error as Partial<MissionStoreError>;
  return failure(code, `${prefix}: ${errorMessage(error)}`, {
    ...(typeof typed.code === "string" ? { storeCode: typed.code } : {}),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
