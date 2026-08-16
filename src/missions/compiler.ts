import type { DB } from "../memory/db.js";
import {
  canonicalizeBuildSource,
  compileBuildDefinitionForVersion,
  hashBuildSource,
} from "../construction/buildOps/compiler.js";
import { parseBuildSource } from "../construction/buildOps/schema.js";
import type {
  BuildBlockRegistry,
  BuildCompileError,
  BuildCompileReport,
  BuildSourceDefinition,
  CompiledBuild,
  Vec3Tuple,
} from "../construction/buildOps/types.js";
import {
  MAX_BLUEPRINT_SOURCE_BYTES,
  countExpectedWorldCells,
  fingerprintBlueprintExecution,
  getBlueprintByName,
  getBlueprintSource,
  type BlueprintExecutionFingerprint,
  type BlueprintRow,
  type BlueprintSourceRow,
} from "../construction/store.js";
import { roleSatisfies } from "../permissions/capabilities.js";
import {
  snapshotExecutionActor,
  type ExecutionActor,
} from "../permissions/executionActor.js";
import type { CapabilityAccess } from "../permissions/capabilities.js";
import type { SkillRegistry } from "../skills/registry.js";
import { safeParseMissionDefinition } from "./schema.js";
import {
  MAX_MISSION_EXPANDED_STEPS,
  MAX_MISSION_JSON_DEPTH,
  MAX_MISSION_JSON_KEY_LENGTH,
  MAX_MISSION_JSON_VALUES,
  MAX_MISSION_SOURCE_BYTES,
  MAX_MISSION_WORLD_CHANGES,
  MISSION_EXPANDED_TASKS_METADATA_KEY,
  MISSION_NAMED_BLUEPRINT_FINGERPRINT_METADATA_KEY,
  type MissionBuildStep,
  type MissionDefinition,
  type MissionExpandedTaskMetadata,
  type MissionJsonValue,
  type MissionStep,
} from "./types.js";
import {
  MAX_MISSION_COMPILE_REPORT_BYTES,
  type MissionStepLinkInput,
} from "./store.js";
import type { TaskStepInput } from "../tasks/store.js";

/** The compiler deliberately caps diagnostics instead of reflecting arbitrary input back to callers. */
export const MAX_MISSION_COMPILE_ERRORS = 64;
export const MAX_MISSION_COMPILE_WARNINGS = 32;
/** Full BuildOps summaries fit this cap; legacy raw blueprints are sampled. */
export const MAX_MISSION_BUILD_MATERIAL_SAMPLES = 128;
/** Material samples across one persisted compile report stay compact. */
export const MAX_MISSION_REPORT_MATERIAL_SAMPLES = 64;

/**
 * These legacy public skills can change many world cells without using the
 * MissionScript transaction budget on every mutation. They stay callable as
 * ordinary skills, but are not safe durable mission steps until that substrate
 * exists. Keep this list explicit and narrow so new public skills are not
 * silently exposed by a broad effect-based allow rule.
 */
export const MISSION_SKILL_SAFETY_DENYLIST: ReadonlySet<string> = new Set([
  "mineUntil",
  "chopTrees",
  "harvestFarm",
  // This public orchestration skill falls back to mineUntil when storage,
  // input, or fuel is missing. It cannot be a MissionScript step until those
  // mutations participate in the mission journal/budget.
  "supplyContainer",
  // Raw block activation can toggle redstone, doors, and other multi-block
  // world effects without a block transaction. Keep it out of generic mission
  // expansion until that interaction has explicit bounded accounting.
  "activateBlock",
]);

/**
 * These public capabilities require MissionScript-specific accounting rather
 * than the generic one-task expansion. In particular, accepting clearRegion
 * through `op: "skill"` would let a caller evade the exact region estimate.
 */
export const MISSION_RESERVED_SKILLS: ReadonlySet<string> = new Set([
  "clearRegion",
]);

/**
 * Raw blueprints have neither a compiler report nor a source grant that can
 * prove current owner authorization for hazardous placement. Keep this local
 * to MissionScript rather than importing the live builder (which would create
 * a runtime dependency cycle), and fail before run/job/plan materialization.
 */
export const MISSION_UNSAFE_RAW_BUILD_BLOCKS: ReadonlySet<string> = new Set([
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
  // TNT is executable only via an owner-authorized BuildOps source that the
  // construction boundary revalidates immediately before every mutation.
  "tnt",
]);

export type MissionCompileErrorCode =
  | "MISSION_INVALID"
  | "ACTOR_INVALID"
  | "SKILL_NOT_FOUND"
  | "SKILL_NOT_PUBLIC"
  | "SKILL_RESERVED_FOR_MISSION_OP"
  | "SKILL_UNSAFE_FOR_MISSION"
  | "SKILL_PARAMS_INVALID"
  | "SKILL_PARAMS_NOT_JSON"
  | "ROLE_DENIED"
  | "CLEAR_SKILL_INVALID"
  | "CLEAR_VOLUME_LIMIT"
  | "BLUEPRINT_NOT_FOUND"
  | "BLUEPRINT_SOURCE_INVALID"
  | "BLUEPRINT_SOURCE_MISMATCH"
  | "BUILD_INVALID"
  | "BUILD_ACCESS_DENIED"
  | "INTERNAL_SKILL_INVALID"
  | "EXPANDED_STEP_LIMIT"
  | "WORLD_CHANGE_LIMIT"
  | "COMPILE_REPORT_LIMIT"
  | "COMPILE_METADATA_LIMIT"
  | "CONSTRUCTION_JOB_BINDING_INVALID";

export interface MissionCompileError {
  /** Null only when no structurally valid logical step can be identified. */
  readonly stepId: string | null;
  readonly code: MissionCompileErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, MissionJsonValue>>;
}

export interface MissionCompileWarning {
  readonly stepId: string;
  readonly code: string;
  readonly message: string;
}

/** A bounded projection of a build needed by a mission/desktop preview. */
export interface MissionCompiledBuildSummary {
  readonly blueprintName: string;
  readonly blueprintId: number | null;
  readonly sourceHash: string | null;
  readonly targetVersion: string | null;
  readonly worldCellCount: number;
  readonly bounds: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
  readonly materials: Readonly<Record<string, number>>;
  /** Exact number of distinct material kinds before response sampling. */
  readonly materialKinds: number;
  readonly materialsTruncated: boolean;
  readonly requiredRole: CapabilityAccess;
}

/** The persistence-safe material projection used in a mission compile report. */
export interface MissionCompileBuildReport extends Omit<MissionCompiledBuildSummary, "materials" | "materialsTruncated"> {
  readonly stepId: string;
  readonly materials: Readonly<Record<string, number>>;
  readonly materialsTruncated: boolean;
}

/**
 * A named build references an existing durable blueprint. An inline build is
 * fully compiled but deliberately not persisted by this pure phase.
 */
export type MissionCompiledBuild =
  | {
      readonly kind: "named";
      readonly summary: MissionCompiledBuildSummary;
      readonly origin: Vec3Tuple;
      readonly rotation: 0 | 90 | 180 | 270;
      readonly blueprint: BlueprintRow;
      readonly source: BlueprintSourceRow | null;
      readonly compiled: CompiledBuild | null;
      /** Durable content/source snapshot to revalidate during materialization. */
      readonly fingerprint: BlueprintExecutionFingerprint;
    }
  | {
      readonly kind: "inline";
      readonly summary: MissionCompiledBuildSummary;
      readonly origin: Vec3Tuple;
      readonly rotation: 0 | 90 | 180 | 270;
      readonly source: BuildSourceDefinition;
      readonly compiled: CompiledBuild;
    };

/** A normal task is fully ready to be inserted into a durable task plan. */
export interface MissionCompiledSkillTask {
  readonly kind: "skill";
  readonly skill: string;
  readonly params: Readonly<Record<string, MissionJsonValue>>;
  readonly maxAttempts: number;
}

/** A construction task acquires its durable job ID only during materialization. */
export interface MissionCompiledConstructionTask {
  readonly kind: "construction";
  readonly skill: "prepareBlueprintMaterials" | "buildBlueprint";
  /**
   * Schema-resolved parameters produced with a positive placeholder job ID.
   * Materialization replaces only that ID, so a future internal-schema change
   * cannot leave a durable mission plan with invalid construction params.
   */
  readonly params: Readonly<Record<string, MissionJsonValue>>;
  readonly maxAttempts: number;
}

export type MissionCompiledTask = MissionCompiledSkillTask | MissionCompiledConstructionTask;

export interface MissionCompiledLogicalStep {
  readonly logicalStepId: string;
  readonly logicalPosition: number;
  readonly expandedStartPosition: number;
  readonly expandedStepCount: number;
  readonly estimatedWorldChanges: number;
  readonly tasks: readonly MissionCompiledTask[];
  readonly build: MissionCompiledBuild | null;
}

export interface MissionCompileReport {
  readonly name: string;
  readonly logicalStepCount: number;
  readonly expandedStepCount: number;
  readonly estimatedWorldChanges: number;
  readonly maxExpandedSteps: number;
  readonly maxWorldChanges: number;
  readonly maxRuntimeMinutes: number;
  readonly requiredRole: CapabilityAccess;
  readonly builds: readonly MissionCompileBuildReport[];
  readonly warnings: readonly MissionCompileWarning[];
}

export interface CompiledMission {
  readonly definition: MissionDefinition;
  /** Snapshot made before any resolution callback can run. */
  readonly actor: ExecutionActor;
  readonly logicalSteps: readonly MissionCompiledLogicalStep[];
  readonly report: MissionCompileReport;
}

export type MissionCompileResult =
  | { readonly ok: true; readonly value: CompiledMission }
  | { readonly ok: false; readonly errors: readonly MissionCompileError[] };

/** A test-friendly read-only shape for resolving named blueprints. */
export interface MissionNamedBlueprint {
  readonly blueprint: BlueprintRow;
  readonly source: BlueprintSourceRow | null;
}

export interface MissionCompilerDeps {
  readonly registry: SkillRegistry;
  readonly actor: ExecutionActor;
  /** Resolves exactly the BuildOps target version; it must not fall back. */
  readonly registryForVersion: (targetVersion: string) => BuildBlockRegistry | undefined;
  /** Optional database used only through read-only blueprint store functions. */
  readonly db?: DB;
  /** Optional read-only resolver, useful for tests and profile adapters. */
  readonly resolveNamedBlueprint?: (name: string) => MissionNamedBlueprint | undefined;
}

/** A concrete post-job form which MissionService can persist without re-parsing source JSON. */
export interface BoundMissionCompilation {
  readonly taskSteps: readonly TaskStepInput[];
  readonly stepLinks: readonly MissionStepLinkInput[];
  readonly compileReport: MissionCompileReport;
}

/**
 * Compile every logical step before any caller creates a run, plan, or job.
 * This function has no write-capable dependency and must remain pure with
 * respect to SQLite and the Minecraft client.
 */
export function compileMissionDefinition(
  input: unknown,
  deps: MissionCompilerDeps,
): MissionCompileResult {
  const parsed = safeParseMissionDefinition(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: Object.freeze(parsed.error.issues.slice(0, MAX_MISSION_COMPILE_ERRORS).map((issue) => ({
        stepId: issueStepId(input, issue.path),
        code: "MISSION_INVALID" as const,
        message: issue.message,
        ...(issue.path.length === 0 ? {} : {
          details: Object.freeze({ path: issue.path.map(String).join(".") }),
        }),
      }))),
    };
  }

  let actor: ExecutionActor;
  try {
    actor = snapshotExecutionActor(deps.actor);
  } catch (error) {
    return {
      ok: false,
      errors: Object.freeze([{
        stepId: null,
        code: "ACTOR_INVALID",
        message: `invalid mission actor: ${errorMessage(error)}`,
      }]),
    };
  }

  const definition = parsed.data;
  const errors: MissionCompileError[] = [];
  const warnings: MissionCompileWarning[] = [];
  const logicalSteps: MissionCompiledLogicalStep[] = [];
  let expandedStepCount = 0;
  let estimatedWorldChanges = 0;
  let requiredRole: CapabilityAccess = "viewer";

  for (const [logicalPosition, step] of definition.steps.entries()) {
    const result = compileLogicalStep(step, logicalPosition, actor, deps, warnings, errors);
    if (!result) continue;

    const nextExpanded = expandedStepCount + result.tasks.length;
    if (nextExpanded > definition.limits.maxExpandedSteps || nextExpanded > MAX_MISSION_EXPANDED_STEPS) {
      addError(errors, {
        stepId: step.id,
        code: "EXPANDED_STEP_LIMIT",
        message: `step '${step.id}' would expand the mission to ${nextExpanded} tasks; maximum is ${definition.limits.maxExpandedSteps}`,
        details: {
          attemptedExpandedSteps: nextExpanded,
          maximum: definition.limits.maxExpandedSteps,
        },
      });
      continue;
    }

    const nextWorldChanges = estimatedWorldChanges + result.estimatedWorldChanges;
    if (nextWorldChanges > definition.limits.maxWorldChanges || nextWorldChanges > MAX_MISSION_WORLD_CHANGES) {
      addError(errors, {
        stepId: step.id,
        code: "WORLD_CHANGE_LIMIT",
        message: `step '${step.id}' would raise the estimated world-change count to ${nextWorldChanges}; maximum is ${definition.limits.maxWorldChanges}`,
        details: {
          attemptedWorldChanges: nextWorldChanges,
          maximum: definition.limits.maxWorldChanges,
        },
      });
      continue;
    }

    const compiledStep: MissionCompiledLogicalStep = Object.freeze({
      logicalStepId: step.id,
      logicalPosition,
      expandedStartPosition: expandedStepCount,
      expandedStepCount: result.tasks.length,
      estimatedWorldChanges: result.estimatedWorldChanges,
      tasks: Object.freeze(result.tasks.slice()),
      build: result.build,
    });
    logicalSteps.push(compiledStep);
    expandedStepCount = nextExpanded;
    estimatedWorldChanges = nextWorldChanges;
    requiredRole = higherRole(requiredRole, result.requiredRole);
  }

  if (errors.length > 0) {
    return { ok: false, errors: Object.freeze(errors.slice(0, MAX_MISSION_COMPILE_ERRORS)) };
  }

  const allBuilds = logicalSteps
    .filter((step): step is MissionCompiledLogicalStep & { readonly build: MissionCompiledBuild } => step.build !== null)
    .map((step) => ({ stepId: step.logicalStepId, summary: step.build.summary }));
  const samplesPerBuild = Math.max(1, Math.floor(
    MAX_MISSION_REPORT_MATERIAL_SAMPLES / Math.max(1, allBuilds.length),
  ));
  const builds = allBuilds.map(({ stepId, summary }) => reportBuildSummary(stepId, summary, samplesPerBuild));
  const report: MissionCompileReport = Object.freeze({
    name: definition.name,
    logicalStepCount: definition.steps.length,
    expandedStepCount,
    estimatedWorldChanges,
    maxExpandedSteps: definition.limits.maxExpandedSteps,
    maxWorldChanges: definition.limits.maxWorldChanges,
    maxRuntimeMinutes: definition.limits.maxRuntimeMinutes,
    requiredRole,
    builds: Object.freeze(builds),
    warnings: Object.freeze(warnings.slice(0, MAX_MISSION_COMPILE_WARNINGS)),
  });
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > MAX_MISSION_COMPILE_REPORT_BYTES) {
    return {
      ok: false,
      errors: Object.freeze([{
        stepId: null,
        code: "COMPILE_REPORT_LIMIT",
        message: `mission compile report exceeds ${MAX_MISSION_COMPILE_REPORT_BYTES} bytes after bounded projection`,
      }]),
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      definition,
      actor,
      logicalSteps: Object.freeze(logicalSteps),
      report,
    }),
  };
}

/** Concise alias for callers that already operate only on MissionScript v1. */
export const compileMission = compileMissionDefinition;

/**
 * Bind construction job IDs after the service has created them atomically.
 * The returned task rows and link metadata satisfy Task 12's immutable
 * `expandedTasks` contract directly; this helper neither touches the DB nor
 * creates jobs/plans itself.
 */
export function bindMissionConstructionJobs(
  compilation: CompiledMission,
  constructionJobIds: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
): BoundMissionCompilation {
  const taskSteps: TaskStepInput[] = [];
  const stepLinks: MissionStepLinkInput[] = [];

  for (const step of compilation.logicalSteps) {
    const constructionJobId = step.build === null
      ? undefined
      : lookupConstructionJobId(constructionJobIds, step.logicalStepId);
    if (step.build !== null && constructionJobId === undefined) {
      throw bindingError(
        `build step '${step.logicalStepId}' is missing its construction job binding`,
        step.logicalStepId,
      );
    }
    const resolvedTasks = step.tasks.map((task) => resolveTask(task, constructionJobId, step.logicalStepId));
    const metadata = metadataForStep(step, resolvedTasks);
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
    if (metadataBytes > MAX_MISSION_SOURCE_BYTES) {
      throw bindingError(
        `resolved metadata for step '${step.logicalStepId}' exceeds ${MAX_MISSION_SOURCE_BYTES} bytes`,
        step.logicalStepId,
        "COMPILE_METADATA_LIMIT",
      );
    }
    taskSteps.push(...resolvedTasks.map((task) => Object.freeze({
      skill: task.skill,
      params: cloneJsonRecord(task.params),
      maxAttempts: task.maxAttempts,
    })));
    stepLinks.push(Object.freeze({
      logicalStepId: step.logicalStepId,
      logicalPosition: step.logicalPosition,
      expandedStartPosition: step.expandedStartPosition,
      expandedStepCount: step.expandedStepCount,
      ...(constructionJobId === undefined ? {} : { constructionJobId }),
      compileMetadata: metadata,
    }));
  }

  return Object.freeze({
    taskSteps: Object.freeze(taskSteps),
    stepLinks: Object.freeze(stepLinks),
    compileReport: compilation.report,
  });
}

/** Compatibility spelling for service callers that prefer an imperative verb. */
export const materializeMissionCompilation = bindMissionConstructionJobs;

interface StepCompileSuccess {
  readonly tasks: readonly MissionCompiledTask[];
  readonly estimatedWorldChanges: number;
  readonly requiredRole: CapabilityAccess;
  readonly build: MissionCompiledBuild | null;
}

function compileLogicalStep(
  step: MissionStep,
  logicalPosition: number,
  actor: ExecutionActor,
  deps: MissionCompilerDeps,
  warnings: MissionCompileWarning[],
  errors: MissionCompileError[],
): StepCompileSuccess | undefined {
  switch (step.op) {
    case "skill":
      return compileSkillStep(step, actor, deps, errors);
    case "clear":
      return compileClearStep(step, actor, deps, errors);
    case "build":
      return compileBuildStep(step, logicalPosition, actor, deps, warnings, errors);
  }
}

function compileSkillStep(
  step: Extract<MissionStep, { readonly op: "skill" }>,
  actor: ExecutionActor,
  deps: MissionCompilerDeps,
  errors: MissionCompileError[],
): StepCompileSuccess | undefined {
  const skill = deps.registry.get(step.skill);
  if (!skill) {
    addError(errors, {
      stepId: step.id,
      code: "SKILL_NOT_FOUND",
      message: `step '${step.id}' references unknown skill '${step.skill}'`,
    });
    return undefined;
  }

  let params: Readonly<Record<string, MissionJsonValue>> | undefined;
  const parsed = skill.params.safeParse(step.params);
  if (!parsed.success) {
    addError(errors, {
      stepId: step.id,
      code: "SKILL_PARAMS_INVALID",
      message: formatZodIssues(`invalid params for skill '${step.skill}'`, parsed.error.issues),
    });
  } else {
    const normalized = missionJsonRecord(parsed.data);
    if (!normalized.ok) {
      addError(errors, {
        stepId: step.id,
        code: "SKILL_PARAMS_NOT_JSON",
        message: `validated params for skill '${step.skill}' are not bounded JSON: ${normalized.message}`,
      });
    } else {
      params = normalized.value;
    }
  }

  if (skill.policy.mission !== "public") {
    addError(errors, {
      stepId: step.id,
      code: "SKILL_NOT_PUBLIC",
      message: `skill '${step.skill}' is not available to MissionScript`,
      details: { missionExposure: skill.policy.mission },
    });
  }
  if (MISSION_SKILL_SAFETY_DENYLIST.has(skill.name)) {
    addError(errors, {
      stepId: step.id,
      code: "SKILL_UNSAFE_FOR_MISSION",
      message: `skill '${step.skill}' is not yet safe for bounded durable mission execution`,
    });
  }
  if (MISSION_RESERVED_SKILLS.has(skill.name)) {
    addError(errors, {
      stepId: step.id,
      code: "SKILL_RESERVED_FOR_MISSION_OP",
      message: `skill '${step.skill}' must use its dedicated MissionScript operation`,
    });
  }
  if (!roleSatisfies(actor.role, skill.policy)) {
    addError(errors, roleDenied(step.id, step.skill, actor, skill.policy.minimumRole));
  }

  if (
    params === undefined ||
    skill.policy.mission !== "public" ||
    MISSION_SKILL_SAFETY_DENYLIST.has(skill.name) ||
    MISSION_RESERVED_SKILLS.has(skill.name) ||
    !roleSatisfies(actor.role, skill.policy)
  ) return undefined;

  return {
    tasks: [Object.freeze({ kind: "skill", skill: skill.name, params, maxAttempts: step.maxAttempts })],
    estimatedWorldChanges: 0,
    requiredRole: skill.policy.minimumRole,
    build: null,
  };
}

function compileClearStep(
  step: Extract<MissionStep, { readonly op: "clear" }>,
  actor: ExecutionActor,
  deps: MissionCompilerDeps,
  errors: MissionCompileError[],
): StepCompileSuccess | undefined {
  const skill = deps.registry.get("clearRegion");
  let params: Readonly<Record<string, MissionJsonValue>> | undefined;
  let policyValid = false;
  if (!skill) {
    addError(errors, {
      stepId: step.id,
      code: "CLEAR_SKILL_INVALID",
      message: "clearRegion is not registered, so clear steps cannot be compiled",
    });
  } else {
    policyValid = skill.policy.mission === "public" &&
      skill.policy.minimumRole === "owner" &&
      skill.policy.effect === "destructive";
    if (!policyValid) {
      addError(errors, {
        stepId: step.id,
        code: "CLEAR_SKILL_INVALID",
        message: "clearRegion must remain a public owner destructive skill for MissionScript clear steps",
      });
    }
    const parsed = skill.params.safeParse({
      from: tuplePosition(step.from),
      to: tuplePosition(step.to),
      includeContainers: step.includeContainers,
    });
    if (!parsed.success) {
      addError(errors, {
        stepId: step.id,
        code: "CLEAR_SKILL_INVALID",
        message: formatZodIssues("invalid generated clearRegion params", parsed.error.issues),
      });
    } else {
      const normalized = missionJsonRecord(parsed.data);
      if (!normalized.ok) {
        addError(errors, {
          stepId: step.id,
          code: "CLEAR_SKILL_INVALID",
          message: `generated clearRegion params are not bounded JSON: ${normalized.message}`,
        });
      } else {
        params = normalized.value;
      }
    }
    if (!roleSatisfies(actor.role, skill.policy)) {
      addError(errors, roleDenied(step.id, "clearRegion", actor, skill.policy.minimumRole));
    }
  }

  const volume = inclusiveVolume(step.from, step.to);
  if (volume > BigInt(MAX_MISSION_WORLD_CHANGES)) {
    addError(errors, {
      stepId: step.id,
      code: "CLEAR_VOLUME_LIMIT",
      message: `clear step '${step.id}' covers ${volume.toString()} cells; maximum is ${MAX_MISSION_WORLD_CHANGES}`,
      details: { volume: volume.toString(), maximum: MAX_MISSION_WORLD_CHANGES },
    });
  }

  if (
    !skill || !policyValid || params === undefined || !roleSatisfies(actor.role, skill.policy) ||
    volume > BigInt(MAX_MISSION_WORLD_CHANGES)
  ) return undefined;

  return {
    tasks: [Object.freeze({ kind: "skill", skill: "clearRegion", params, maxAttempts: step.maxAttempts })],
    estimatedWorldChanges: Number(volume),
    requiredRole: "owner",
    build: null,
  };
}

function compileBuildStep(
  step: MissionBuildStep,
  _logicalPosition: number,
  actor: ExecutionActor,
  deps: MissionCompilerDeps,
  warnings: MissionCompileWarning[],
  errors: MissionCompileError[],
): StepCompileSuccess | undefined {
  const internalSkills = resolveInternalBuildSkills(step.id, actor, deps.registry, errors);
  const build = "blueprintName" in step
    ? compileNamedBuild(step, actor, deps, warnings, errors)
    : compileInlineBuild(step, actor, deps, warnings, errors);
  if (!internalSkills || !build) return undefined;

  return {
    tasks: [
      Object.freeze({
        kind: "construction",
        skill: "prepareBlueprintMaterials",
        params: internalSkills.params.prepareBlueprintMaterials,
        maxAttempts: step.maxAttempts,
      }),
      Object.freeze({
        kind: "construction",
        skill: "buildBlueprint",
        params: internalSkills.params.buildBlueprint,
        maxAttempts: step.maxAttempts,
      }),
    ],
    estimatedWorldChanges: build.summary.worldCellCount,
    requiredRole: higherRole(internalSkills.requiredRole, build.summary.requiredRole),
    build,
  };
}

function resolveInternalBuildSkills(
  stepId: string,
  actor: ExecutionActor,
  registry: SkillRegistry,
  errors: MissionCompileError[],
): {
  readonly requiredRole: CapabilityAccess;
  readonly params: Readonly<{
    readonly prepareBlueprintMaterials: Readonly<Record<string, MissionJsonValue>>;
    readonly buildBlueprint: Readonly<Record<string, MissionJsonValue>>;
  }>;
} | undefined {
  const names = ["prepareBlueprintMaterials", "buildBlueprint"] as const;
  let requiredRole: CapabilityAccess = "viewer";
  let valid = true;
  const params: Partial<Record<(typeof names)[number], Readonly<Record<string, MissionJsonValue>>>> = {};
  for (const name of names) {
    const skill = registry.get(name);
    if (!skill || skill.policy.mission !== "internal") {
      addError(errors, {
        stepId,
        code: "INTERNAL_SKILL_INVALID",
        message: `internal construction skill '${name}' is unavailable or misconfigured`,
      });
      valid = false;
      continue;
    }
    // Build jobs do not exist during pure compilation. A positive placeholder
    // proves that the internal schema accepts its generated shape (including
    // defaults) before MissionService creates any durable row.
    const parsed = skill.params.safeParse({ jobId: 1 });
    if (!parsed.success) {
      addError(errors, {
        stepId,
        code: "INTERNAL_SKILL_INVALID",
        message: formatZodIssues(`invalid generated params for internal skill '${name}'`, parsed.error.issues),
      });
      valid = false;
      continue;
    }
    const normalized = missionJsonRecord(parsed.data);
    if (!normalized.ok || normalized.value.jobId !== 1) {
      addError(errors, {
        stepId,
        code: "INTERNAL_SKILL_INVALID",
        message: normalized.ok
          ? `internal skill '${name}' must preserve a positive jobId parameter`
          : `generated params for internal skill '${name}' are not bounded JSON: ${normalized.message}`,
      });
      valid = false;
      continue;
    }
    params[name] = normalized.value;
    if (!roleSatisfies(actor.role, skill.policy)) {
      addError(errors, roleDenied(stepId, name, actor, skill.policy.minimumRole));
      valid = false;
    }
    requiredRole = higherRole(requiredRole, skill.policy.minimumRole);
  }
  if (!valid || !params.prepareBlueprintMaterials || !params.buildBlueprint) return undefined;
  return Object.freeze({
    requiredRole,
    params: Object.freeze({
      prepareBlueprintMaterials: params.prepareBlueprintMaterials,
      buildBlueprint: params.buildBlueprint,
    }),
  });
}

function compileNamedBuild(
  step: Extract<MissionBuildStep, { readonly blueprintName: string }>,
  actor: ExecutionActor,
  deps: MissionCompilerDeps,
  warnings: MissionCompileWarning[],
  errors: MissionCompileError[],
): MissionCompiledBuild | undefined {
  let resolved: MissionNamedBlueprint | undefined;
  try {
    resolved = resolveNamedBlueprint(step.blueprintName, deps);
  } catch (error) {
    addError(errors, {
      stepId: step.id,
      code: "BLUEPRINT_SOURCE_INVALID",
      message: `could not read blueprint '${step.blueprintName}': ${errorMessage(error)}`,
    });
    return undefined;
  }
  if (!resolved) {
    addError(errors, {
      stepId: step.id,
      code: "BLUEPRINT_NOT_FOUND",
      message: `no blueprint named '${step.blueprintName}' exists`,
    });
    return undefined;
  }

  if (resolved.source === null) {
    const unsafeBlock = resolved.blueprint.blocks.find((block) =>
      block.block.length > 128 || !/^(?:minecraft:)?[a-z0-9_]+$/.test(block.block));
    if (unsafeBlock) {
      addError(errors, {
        stepId: step.id,
        code: "BLUEPRINT_SOURCE_INVALID",
        message: `raw blueprint '${resolved.blueprint.name}' contains an invalid block identifier`,
      });
      return undefined;
    }
    const prohibited = resolved.blueprint.blocks.find((block) =>
      MISSION_UNSAFE_RAW_BUILD_BLOCKS.has(normalizeRawBlockName(block.block)));
    if (prohibited) {
      addError(errors, {
        stepId: step.id,
        code: "BUILD_INVALID",
        message:
          `raw blueprint '${resolved.blueprint.name}' contains '${prohibited.block}', ` +
          "which requires a verified generated source or is never safe to execute",
      });
      return undefined;
    }
    const summary = summaryForRawBlueprint(resolved.blueprint);
    if (!hasBuildRole(actor, summary.requiredRole)) {
      addError(errors, buildAccessDenied(step.id, actor, summary.requiredRole));
      return undefined;
    }
    return Object.freeze({
      kind: "named",
      summary,
      origin: cloneTuple(step.origin),
      rotation: step.rotation,
      blueprint: resolved.blueprint,
      source: null,
      compiled: null,
      fingerprint: fingerprintBlueprintExecution(resolved.blueprint, null),
    });
  }

  const compiled = compileStoredBuildSource(step.id, resolved.blueprint, resolved.source, deps, warnings, errors);
  if (!compiled) return undefined;
  const summary = summaryForCompiledBuild(resolved.blueprint.name, resolved.blueprint.id, compiled.value);
  if (!hasBuildRole(actor, summary.requiredRole)) {
    addError(errors, buildAccessDenied(step.id, actor, summary.requiredRole));
    return undefined;
  }
  return Object.freeze({
    kind: "named",
    summary,
    origin: cloneTuple(step.origin),
    rotation: step.rotation,
    blueprint: resolved.blueprint,
    source: resolved.source,
    compiled: compiled.value,
    fingerprint: fingerprintBlueprintExecution(resolved.blueprint, resolved.source),
  });
}

function normalizeRawBlockName(block: string): string {
  return block.toLowerCase().replace(/^minecraft:/, "");
}

function compileInlineBuild(
  step: Extract<MissionBuildStep, { readonly definition: BuildSourceDefinition }>,
  actor: ExecutionActor,
  deps: MissionCompilerDeps,
  warnings: MissionCompileWarning[],
  errors: MissionCompileError[],
): MissionCompiledBuild | undefined {
  let source: BuildSourceDefinition;
  let canonicalSource: string;
  try {
    source = parseBuildSource(step.definition);
    canonicalSource = canonicalizeBuildSource(source);
  } catch (error) {
    addError(errors, {
      stepId: step.id,
      code: "BUILD_INVALID",
      message: `inline build source is invalid: ${errorMessage(error)}`,
    });
    return undefined;
  }
  const sourceBytes = new TextEncoder().encode(canonicalSource).byteLength;
  // Inline MissionScript source permits 64 KiB, while trusted blueprint source
  // persistence intentionally permits only 32 KiB. Reject here so an otherwise
  // valid preview cannot fail halfway through later materialization.
  if (sourceBytes > MAX_BLUEPRINT_SOURCE_BYTES) {
    addError(errors, {
      stepId: step.id,
      code: "BUILD_INVALID",
      message: `inline build source is ${sourceBytes} bytes; durable blueprint source maximum is ${MAX_BLUEPRINT_SOURCE_BYTES} bytes`,
      details: { bytes: sourceBytes, maximum: MAX_BLUEPRINT_SOURCE_BYTES },
    });
    return undefined;
  }
  const compiled = compileBuildDefinitionForVersion(source, { registryForVersion: deps.registryForVersion });
  if (!compiled.ok) {
    addBuildErrors(errors, step.id, compiled.errors);
    return undefined;
  }
  addBuildWarnings(warnings, step.id, compiled.value.report);
  const summary = summaryForCompiledBuild(source.name, null, compiled.value);
  if (!hasBuildRole(actor, summary.requiredRole)) {
    addError(errors, buildAccessDenied(step.id, actor, summary.requiredRole));
    return undefined;
  }
  return Object.freeze({
    kind: "inline",
    summary,
    origin: cloneTuple(step.origin),
    rotation: step.rotation,
    source,
    compiled: compiled.value,
  });
}

function compileStoredBuildSource(
  stepId: string,
  blueprint: BlueprintRow,
  sourceRow: BlueprintSourceRow,
  deps: MissionCompilerDeps,
  warnings: MissionCompileWarning[],
  errors: MissionCompileError[],
): { readonly value: CompiledBuild } | undefined {
  let source: BuildSourceDefinition;
  try {
    source = parseBuildSource(JSON.parse(sourceRow.sourceJson));
  } catch (error) {
    addError(errors, {
      stepId,
      code: "BLUEPRINT_SOURCE_INVALID",
      message: `blueprint '${blueprint.name}' has an invalid stored BuildOps source: ${errorMessage(error)}`,
    });
    return undefined;
  }
  const expectedHash = hashBuildSource(source);
  if (sourceRow.sourceHash.toLowerCase() !== expectedHash) {
    addError(errors, {
      stepId,
      code: "BLUEPRINT_SOURCE_MISMATCH",
      message: `blueprint '${blueprint.name}' stored source hash does not match its source`,
    });
  }
  if (sourceRow.schema !== source.schema || sourceRow.targetVersion !== source.targetVersion) {
    addError(errors, {
      stepId,
      code: "BLUEPRINT_SOURCE_MISMATCH",
      message: `blueprint '${blueprint.name}' stored source metadata does not match its source`,
    });
  }
  const compiled = compileBuildDefinitionForVersion(source, { registryForVersion: deps.registryForVersion });
  if (!compiled.ok) {
    addBuildErrors(errors, stepId, compiled.errors);
    return undefined;
  }
  if (!sameBlueprintCells(blueprint, compiled.value)) {
    addError(errors, {
      stepId,
      code: "BLUEPRINT_SOURCE_MISMATCH",
      message: `blueprint '${blueprint.name}' cells do not match its compiled BuildOps source`,
    });
  }
  if (errors.some((error) => error.stepId === stepId &&
    (error.code === "BLUEPRINT_SOURCE_MISMATCH" || error.code === "BLUEPRINT_SOURCE_INVALID"))) {
    return undefined;
  }
  addBuildWarnings(warnings, stepId, compiled.value.report);
  return { value: compiled.value };
}

function resolveNamedBlueprint(name: string, deps: MissionCompilerDeps): MissionNamedBlueprint | undefined {
  if (deps.resolveNamedBlueprint) return deps.resolveNamedBlueprint(name);
  if (!deps.db) return undefined;
  const blueprint = getBlueprintByName(deps.db, name);
  if (!blueprint) return undefined;
  return { blueprint, source: getBlueprintSource(deps.db, blueprint.id) ?? null };
}

function summaryForCompiledBuild(
  blueprintName: string,
  blueprintId: number | null,
  compiled: CompiledBuild,
): MissionCompiledBuildSummary {
  const materialSummary = summarizeMaterials(compiled.report.materials, MAX_MISSION_BUILD_MATERIAL_SAMPLES);
  return Object.freeze({
    blueprintName,
    blueprintId,
    sourceHash: compiled.report.sourceHash,
    targetVersion: compiled.targetVersion,
    worldCellCount: compiled.report.worldCellCount,
    bounds: Object.freeze({
      min: Object.freeze([...compiled.report.bounds.min]) as Vec3Tuple,
      max: Object.freeze([...compiled.report.bounds.max]) as Vec3Tuple,
    }),
    ...materialSummary,
    requiredRole: compiled.report.requiredAccess,
  });
}

function summaryForRawBlueprint(blueprint: BlueprintRow): MissionCompiledBuildSummary {
  const blocks = blueprint.blocks;
  const xs = blocks.map((block) => block.x);
  const ys = blocks.map((block) => block.y);
  const zs = blocks.map((block) => block.z);
  const materials: Record<string, number> = {};
  for (const block of blocks) materials[block.block] = (materials[block.block] ?? 0) + 1;
  const materialSummary = summarizeMaterials(materials, MAX_MISSION_BUILD_MATERIAL_SAMPLES);
  return Object.freeze({
    blueprintName: blueprint.name,
    blueprintId: blueprint.id,
    sourceHash: null,
    targetVersion: null,
    worldCellCount: countExpectedWorldCells(blueprint.placementUnits),
    bounds: Object.freeze({
      min: Object.freeze([Math.min(...xs), Math.min(...ys), Math.min(...zs)]) as Vec3Tuple,
      max: Object.freeze([Math.max(...xs), Math.max(...ys), Math.max(...zs)]) as Vec3Tuple,
    }),
    ...materialSummary,
    requiredRole: "operator",
  });
}

function reportBuildSummary(
  stepId: string,
  summary: MissionCompiledBuildSummary,
  materialLimit: number,
): MissionCompileBuildReport {
  const materials = summarizeMaterials(summary.materials, materialLimit);
  return Object.freeze({
    stepId,
    blueprintName: summary.blueprintName,
    blueprintId: summary.blueprintId,
    sourceHash: summary.sourceHash,
    targetVersion: summary.targetVersion,
    worldCellCount: summary.worldCellCount,
    bounds: summary.bounds,
    materials: materials.materials,
    materialKinds: summary.materialKinds,
    materialsTruncated: summary.materialsTruncated || materials.materialsTruncated,
    requiredRole: summary.requiredRole,
  });
}

function summarizeMaterials(
  materials: Readonly<Record<string, number>>,
  maximum: number,
): Pick<MissionCompiledBuildSummary, "materials" | "materialKinds" | "materialsTruncated"> {
  const entries = Object.entries(materials).sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze({
    materials: Object.freeze(Object.fromEntries(entries.slice(0, maximum))),
    materialKinds: entries.length,
    materialsTruncated: entries.length > maximum,
  });
}

function sameBlueprintCells(blueprint: BlueprintRow, compiled: CompiledBuild): boolean {
  if (blueprint.blocks.length !== compiled.placements.length) return false;
  const cells = blueprint.blocks.map((block) => placementKey(block));
  const compiledCells = compiled.placements.map((block) => placementKey(block));
  cells.sort();
  compiledCells.sort();
  return cells.every((cell, index) => cell === compiledCells[index]);
}

function placementKey(block: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly block: string;
  readonly hint?: { readonly facing?: string; readonly half?: string };
}): string {
  return JSON.stringify([
    block.x,
    block.y,
    block.z,
    block.block,
    block.hint?.facing ?? null,
    block.hint?.half ?? null,
  ]);
}

function addBuildErrors(errors: MissionCompileError[], stepId: string, buildErrors: readonly BuildCompileError[]): void {
  for (const buildError of buildErrors) {
    addError(errors, {
      stepId,
      code: "BUILD_INVALID",
      message: buildError.message,
      ...(buildError.details ? { details: toErrorDetails(buildError.details) } : {}),
    });
  }
}

function addBuildWarnings(warnings: MissionCompileWarning[], stepId: string, report: BuildCompileReport): void {
  for (const warning of report.warnings) {
    if (warnings.length >= MAX_MISSION_COMPILE_WARNINGS) return;
    warnings.push(Object.freeze({ stepId, code: warning.code, message: warning.message }));
  }
}

function roleDenied(
  stepId: string,
  skill: string,
  actor: ExecutionActor,
  requiredRole: CapabilityAccess,
): MissionCompileError {
  return {
    stepId,
    code: "ROLE_DENIED",
    message: `step '${stepId}' requires ${requiredRole} access for '${skill}', but actor '${actor.username}' has ${actor.role}`,
    details: { skill, actorRole: actor.role, requiredRole },
  };
}

function buildAccessDenied(
  stepId: string,
  actor: ExecutionActor,
  requiredRole: CapabilityAccess,
): MissionCompileError {
  return {
    stepId,
    code: "BUILD_ACCESS_DENIED",
    message: `build step '${stepId}' requires ${requiredRole} access, but actor '${actor.username}' has ${actor.role}`,
    details: { actorRole: actor.role, requiredRole },
  };
}

function hasBuildRole(actor: ExecutionActor, requiredRole: CapabilityAccess): boolean {
  return roleRank(actor.role) >= roleRank(requiredRole);
}

function higherRole(left: CapabilityAccess, right: CapabilityAccess): CapabilityAccess {
  return roleRank(left) >= roleRank(right) ? left : right;
}

function roleRank(role: CapabilityAccess): number {
  switch (role) {
    case "viewer": return 0;
    case "operator": return 1;
    case "owner": return 2;
  }
}

function inclusiveVolume(from: Vec3Tuple, to: Vec3Tuple): bigint {
  return (BigInt(Math.abs(from[0] - to[0])) + 1n) *
    (BigInt(Math.abs(from[1] - to[1])) + 1n) *
    (BigInt(Math.abs(from[2] - to[2])) + 1n);
}

function tuplePosition(tuple: Vec3Tuple): { readonly x: number; readonly y: number; readonly z: number } {
  return Object.freeze({ x: tuple[0], y: tuple[1], z: tuple[2] });
}

function cloneTuple(tuple: Vec3Tuple): Vec3Tuple {
  return Object.freeze([tuple[0], tuple[1], tuple[2]]) as Vec3Tuple;
}

function resolveTask(
  task: MissionCompiledTask,
  constructionJobId: number | undefined,
  stepId: string,
): MissionExpandedTaskMetadata {
  if (task.kind === "skill") {
    return Object.freeze({
      skill: task.skill,
      params: cloneJsonRecord(task.params),
      maxAttempts: task.maxAttempts,
    });
  }
  if (constructionJobId === undefined) {
    throw bindingError(`construction task '${task.skill}' for '${stepId}' has no job ID`, stepId);
  }
  return Object.freeze({
    skill: task.skill,
    params: Object.freeze({ ...task.params, jobId: constructionJobId }),
    maxAttempts: task.maxAttempts,
  });
}

function metadataForStep(
  step: MissionCompiledLogicalStep,
  resolvedTasks: readonly MissionExpandedTaskMetadata[],
): Readonly<Record<string, MissionJsonValue>> {
  const metadata: Record<string, MissionJsonValue> = {
    [MISSION_EXPANDED_TASKS_METADATA_KEY]: Object.freeze(resolvedTasks.map((task) => Object.freeze({
      skill: task.skill,
      params: cloneJsonRecord(task.params),
      maxAttempts: task.maxAttempts,
    }))),
    estimatedWorldChanges: step.estimatedWorldChanges,
  };
  if (step.build) {
    metadata.blueprintName = step.build.summary.blueprintName;
    if (step.build.summary.sourceHash !== null) metadata.sourceHash = step.build.summary.sourceHash;
    if (step.build.summary.targetVersion !== null) metadata.targetVersion = step.build.summary.targetVersion;
    if (step.build.kind === "named") {
      metadata[MISSION_NAMED_BLUEPRINT_FINGERPRINT_METADATA_KEY] = Object.freeze({
        blueprintId: step.build.fingerprint.blueprintId,
        blueprintName: step.build.fingerprint.blueprintName,
        cellsHash: step.build.fingerprint.cellsHash,
        sourceHash: step.build.fingerprint.sourceHash,
        targetVersion: step.build.fingerprint.targetVersion,
      });
    }
  }
  return Object.freeze(metadata);
}

function lookupConstructionJobId(
  bindings: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  stepId: string,
): number | undefined {
  const value = isReadonlyMap(bindings) ? bindings.get(stepId) : bindings[stepId];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw bindingError(`construction job ID for step '${stepId}' must be a positive integer`, stepId);
  }
  return value;
}

function isReadonlyMap(
  value: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
): value is ReadonlyMap<string, number> {
  return typeof (value as ReadonlyMap<string, number>).get === "function";
}

function bindingError(
  message: string,
  stepId: string,
  code: MissionCompileErrorCode = "CONSTRUCTION_JOB_BINDING_INVALID",
): Error & { readonly code: MissionCompileErrorCode; readonly stepId: string } {
  const error = Object.assign(new Error(message), {
    code,
    stepId,
  });
  error.name = "MissionCompilationBindingError";
  return error;
}

function missionJsonRecord(value: unknown):
  | { readonly ok: true; readonly value: Readonly<Record<string, MissionJsonValue>> }
  | { readonly ok: false; readonly message: string } {
  const normalized = missionJsonValue(value);
  if (!normalized.ok) return normalized;
  if (!isRecord(normalized.value)) return { ok: false, message: "must be a JSON object" };
  return { ok: true, value: normalized.value };
}

/** Defend the durable JSON boundary even if a future Zod transform returns a class instance. */
function missionJsonValue(value: unknown):
  | { readonly ok: true; readonly value: MissionJsonValue }
  | { readonly ok: false; readonly message: string } {
  const seen = new WeakSet<object>();
  let count = 0;
  const visit = (current: unknown, depth: number): MissionJsonValue | undefined => {
    count++;
    if (count > MAX_MISSION_JSON_VALUES) throw new Error(`contains more than ${MAX_MISSION_JSON_VALUES} JSON values`);
    if (depth > MAX_MISSION_JSON_DEPTH) throw new Error(`exceeds ${MAX_MISSION_JSON_DEPTH} JSON nesting levels`);
    if (current === null || typeof current === "boolean" || typeof current === "string") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("contains a non-finite number");
      return current;
    }
    if (typeof current !== "object") throw new Error("contains a non-JSON value");
    if (seen.has(current)) throw new Error("contains a cyclic or shared object reference");
    seen.add(current);
    if (Array.isArray(current)) return Object.freeze(current.map((entry) => visit(entry, depth + 1)!));
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("contains a non-plain object");
    const result: Record<string, MissionJsonValue> = {};
    for (const key of Object.keys(current).sort()) {
      if (key.length > MAX_MISSION_JSON_KEY_LENGTH) throw new Error(`has a key longer than ${MAX_MISSION_JSON_KEY_LENGTH}`);
      const child = (current as Record<string, unknown>)[key];
      if (child === undefined) throw new Error(`has undefined at '${key}'`);
      result[key] = visit(child, depth + 1)!;
    }
    return Object.freeze(result);
  };
  try {
    return { ok: true, value: visit(value, 0)! };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function cloneJsonRecord(value: Readonly<Record<string, MissionJsonValue>>): Readonly<Record<string, MissionJsonValue>> {
  const cloned = missionJsonRecord(value);
  if (!cloned.ok) throw new Error(`internal mission JSON invariant failed: ${cloned.message}`);
  return cloned.value;
}

function toErrorDetails(value: Readonly<Record<string, unknown>>): Readonly<Record<string, MissionJsonValue>> {
  const normalized = missionJsonRecord(value);
  return normalized.ok ? normalized.value : Object.freeze({ reason: normalized.message });
}

function addError(errors: MissionCompileError[], error: MissionCompileError): void {
  if (errors.length < MAX_MISSION_COMPILE_ERRORS) errors.push(Object.freeze(error));
}

function formatZodIssues(prefix: string, issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[]): string {
  const sample = issues.slice(0, 4).map((issue) =>
    `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
  return sample ? `${prefix}: ${sample}` : prefix;
}

function issueStepId(input: unknown, path: readonly (string | number)[]): string | null {
  if (path[0] !== "steps" || typeof path[1] !== "number") return null;
  if (!isRecord(input) || !Array.isArray(input.steps)) return null;
  const step = input.steps[path[1]];
  return isRecord(step) && typeof step.id === "string" && step.id.trim().length > 0 ? step.id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
