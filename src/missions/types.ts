import type { BuildSourceDefinition, Vec3Tuple } from "../construction/buildOps/types.js";
import type { ExecutionActor, ExecutionSource } from "../permissions/executionActor.js";

/** Stable, data-only MissionScript envelope identifier. */
export const MISSION_SCHEMA = "smartbot.mission/v1" as const;

/** Application-level caps; a compiler may impose smaller request-specific limits. */
export const MAX_MISSION_LOGICAL_STEPS = 32;
export const MAX_MISSION_EXPANDED_STEPS = 64;
export const MAX_MISSION_WORLD_CHANGES = 4_096;
export const MAX_MISSION_RUNTIME_MINUTES = 240;
export const MAX_MISSION_NAME_LENGTH = 120;
export const MAX_MISSION_STEP_ID_LENGTH = 64;
export const MAX_MISSION_SOURCE_BYTES = 64 * 1024;
/** Applies to arbitrary skill params and persisted mission metadata alike. */
export const MAX_MISSION_JSON_DEPTH = 32;
export const MAX_MISSION_JSON_VALUES = 4_096;
export const MAX_MISSION_JSON_KEY_LENGTH = 256;
export const MAX_MISSION_LIST_RESULTS = 100;
export const MAX_MISSION_LINKS_PER_RUN = MAX_MISSION_LOGICAL_STEPS;

/** Strict JSON values permitted inside a public skill parameter object. */
export type MissionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly MissionJsonValue[]
  | { readonly [key: string]: MissionJsonValue };

export interface MissionLimits {
  readonly maxLogicalSteps: number;
  readonly maxExpandedSteps: number;
  readonly maxWorldChanges: number;
  readonly maxRuntimeMinutes: number;
}

interface MissionStepBase {
  readonly id: string;
  readonly maxAttempts: number;
}

/** A future compiler resolves this only against a public registered skill. */
export interface MissionSkillStep extends MissionStepBase {
  readonly op: "skill";
  readonly skill: string;
  /** Structural parsing accepts JSON only; Task 13 validates this against the skill schema. */
  readonly params: Readonly<Record<string, MissionJsonValue>>;
}

/** Bounded demolition compiles to the existing `clearRegion` skill in Task 13. */
export interface MissionClearStep extends MissionStepBase {
  readonly op: "clear";
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
  readonly includeContainers: boolean;
}

export interface MissionNamedBuildStep extends MissionStepBase {
  readonly op: "build";
  readonly blueprintName: string;
  readonly origin: Vec3Tuple;
  readonly rotation: 0 | 90 | 180 | 270;
}

export interface MissionInlineBuildStep extends MissionStepBase {
  readonly op: "build";
  readonly definition: BuildSourceDefinition;
  readonly origin: Vec3Tuple;
  readonly rotation: 0 | 90 | 180 | 270;
}

export type MissionBuildStep = MissionNamedBuildStep | MissionInlineBuildStep;
export type MissionStep = MissionSkillStep | MissionClearStep | MissionBuildStep;

/** Fully parsed, bounded MissionScript v1 definition. */
export interface MissionDefinition {
  readonly schema: typeof MISSION_SCHEMA;
  readonly name: string;
  readonly limits: MissionLimits;
  readonly steps: readonly MissionStep[];
}

export interface MissionDefinitionCreator {
  readonly username: string;
  readonly source: ExecutionSource;
}

export interface MissionDefinitionRow {
  readonly id: number;
  readonly tsCreated: number;
  readonly tsUpdated: number;
  readonly name: string;
  readonly schema: typeof MISSION_SCHEMA;
  readonly sourceJson: string;
  readonly sourceHash: string;
  readonly creator: MissionDefinitionCreator;
  readonly enabled: boolean;
}

export type MissionRunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface MissionRunRow {
  readonly id: number;
  readonly tsCreated: number;
  readonly tsUpdated: number;
  readonly definitionId: number | null;
  readonly sourceSchema: typeof MISSION_SCHEMA;
  /** Immutable canonical source captured at run creation. */
  readonly sourceJson: string;
  readonly sourceHash: string;
  readonly actor: ExecutionActor;
  readonly limits: MissionLimits;
  readonly compileReport: Readonly<Record<string, MissionJsonValue>>;
  readonly taskPlanId: number | null;
  readonly transactionScope: string;
  readonly transactionCorrelation: Readonly<Record<string, MissionJsonValue>>;
  readonly deadlineAt: number;
  readonly status: MissionRunStatus;
  readonly tsStarted: number | null;
  readonly tsFinished: number | null;
  readonly lastError: string | null;
}

export interface MissionStepLinkRow {
  readonly id: number;
  readonly missionRunId: number;
  readonly logicalStepId: string;
  readonly logicalPosition: number;
  readonly expandedStartPosition: number;
  readonly expandedStepCount: number;
  readonly constructionJobId: number | null;
  readonly compileMetadata: Readonly<Record<string, MissionJsonValue>>;
}

/**
 * Reserved compile-metadata key containing the compiler-resolved durable task
 * expansion for one logical MissionScript step. The source may omit schema
 * defaults, so the task plan is compared with these resolved values rather
 * than byte-for-byte with raw MissionScript params.
 */
export const MISSION_EXPANDED_TASKS_METADATA_KEY = "expandedTasks" as const;

/**
 * Immutable named-blueprint content/source snapshot recorded alongside a
 * compiled task expansion.  Store validation rechecks it before a run can
 * begin, preventing a name/ID-preserving blueprint edit from changing what a
 * mission executes after compilation.
 */
export const MISSION_NAMED_BLUEPRINT_FINGERPRINT_METADATA_KEY = "namedBlueprintFingerprint" as const;

export interface MissionExpandedTaskMetadata {
  readonly skill: string;
  readonly params: Readonly<Record<string, MissionJsonValue>>;
  readonly maxAttempts: number;
}

export interface MissionRunDetail extends MissionRunRow {
  readonly stepLinks: readonly MissionStepLinkRow[];
}

export interface MissionDefinitionDetail extends MissionDefinitionRow {
  readonly definition: MissionDefinition;
}

/** List-safe definition projection: source bytes are available only by exact ID/name lookup. */
export interface MissionDefinitionSummary {
  readonly id: number;
  readonly tsCreated: number;
  readonly tsUpdated: number;
  readonly name: string;
  readonly schema: typeof MISSION_SCHEMA;
  readonly sourceHash: string;
  readonly creator: MissionDefinitionCreator;
  readonly enabled: boolean;
}

/** List-safe run projection: immutable source and link metadata require an exact lookup. */
export interface MissionRunSummary {
  readonly id: number;
  readonly tsCreated: number;
  readonly tsUpdated: number;
  readonly definitionId: number | null;
  readonly sourceSchema: typeof MISSION_SCHEMA;
  readonly sourceHash: string;
  readonly actor: ExecutionActor;
  readonly taskPlanId: number | null;
  readonly deadlineAt: number;
  readonly status: MissionRunStatus;
  readonly tsStarted: number | null;
  readonly tsFinished: number | null;
  readonly lastError: string | null;
}
