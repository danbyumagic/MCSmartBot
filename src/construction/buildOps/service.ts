import type { DB } from "../../memory/db.js";
import {
  snapshotExecutionActor,
  type ExecutionActor,
} from "../../permissions/executionActor.js";
import {
  registerCompiledBlueprint,
  type BlueprintRow,
} from "../store.js";
import {
  canonicalizeBuildSource,
  compileBuildDefinitionForVersion,
} from "./compiler.js";
import { parseBuildSource } from "./schema.js";
import type {
  BuildBlockRegistry,
  BuildCompileError,
  BlueprintPlacement,
  CompiledBuild,
} from "./types.js";

export type BuildOpsServiceErrorCode =
  | BuildCompileError["code"]
  | "ACCESS_DENIED"
  | "PLACEMENT_HINT_UNSUPPORTED"
  | "UNSUPPORTED_EXECUTION"
  | "PERSISTENCE_FAILED";

export interface BuildOpsServiceError {
  readonly code: BuildOpsServiceErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type BuildOpsPreviewResult =
  | { readonly ok: true; readonly value: CompiledBuild }
  | { readonly ok: false; readonly error: BuildOpsServiceError };

export type BuildOpsRegistrationResult =
  | { readonly ok: true; readonly value: { readonly blueprint: BlueprintRow; readonly compiled: CompiledBuild } }
  | { readonly ok: false; readonly error: BuildOpsServiceError };

export interface BuildOpsService {
  /** Pure compiler preview: no database, task, or world mutation. */
  previewBuildDefinition(input: { readonly definition: unknown }): BuildOpsPreviewResult;
  /** Compile, enforce the registration boundary, then atomically persist source plus cells. */
  registerBuildDefinition(input: {
    readonly definition: unknown;
    readonly creator: ExecutionActor;
    /** Optional durable display name; source name remains canonical/auditable. */
    readonly name?: string;
  }): BuildOpsRegistrationResult;
}

export function createBuildOpsService(deps: {
  db: DB;
  registryForVersion: (targetVersion: string) => BuildBlockRegistry | undefined;
  now?: () => number;
}): BuildOpsService {
  const now = deps.now ?? Date.now;

  function previewBuildDefinition(input: { readonly definition: unknown }): BuildOpsPreviewResult {
    const result = compileBuildDefinitionForVersion(input.definition, {
      registryForVersion: deps.registryForVersion,
    });
    if (result.ok) return { ok: true, value: result.value };
    return { ok: false, error: compileError(result.errors[0]) };
  }

  function registerBuildDefinition(input: {
    readonly definition: unknown;
    readonly creator: ExecutionActor;
    readonly name?: string;
  }): BuildOpsRegistrationResult {
    const preview = previewBuildDefinition({ definition: input.definition });
    if (!preview.ok) return preview;
    let creator: ExecutionActor;
    try {
      creator = snapshotExecutionActor(input.creator);
    } catch (error) {
      return failure("ACCESS_DENIED", `invalid registration actor: ${errorMessage(error)}`);
    }
    const compiled = preview.value;
    if (compiled.report.requiredAccess === "owner" && creator.role !== "owner") {
      return failure(
        "ACCESS_DENIED",
        "this generated design contains owner-only materials and requires an owner actor",
        { requiredAccess: compiled.report.requiredAccess, actorRole: creator.role },
      );
    }
    try {
      // Reparse into defaults/trimmed values before persistence. The compiler
      // also parsed it, but this keeps the stored source/hash contract explicit.
      const parsed = parseBuildSource(input.definition);
      const blueprint = registerCompiledBlueprint(deps.db, {
        name: input.name ?? compiled.name,
        blocks: compiled.placements.map(toBlueprintBlock),
        sourceSchema: compiled.schema,
        targetVersion: compiled.targetVersion,
        sourceJson: canonicalizeBuildSource(parsed),
        sourceHash: compiled.report.sourceHash,
        compileReportJson: JSON.stringify(compiled.report),
        creator,
      }, now());
      return { ok: true, value: { blueprint, compiled } };
    } catch (error) {
      return failure("PERSISTENCE_FAILED", `could not persist compiled BuildOps source: ${errorMessage(error)}`);
    }
  }

  return { previewBuildDefinition, registerBuildDefinition };
}

function toBlueprintBlock(placement: BlueprintPlacement): {
  x: number;
  y: number;
  z: number;
  block: string;
  hint?: BlueprintPlacement["hint"];
} {
  return {
    x: placement.x,
    y: placement.y,
    z: placement.z,
    block: placement.block,
    ...(placement.hint === undefined ? {} : {
      hint: {
        ...(placement.hint.facing === undefined ? {} : { facing: placement.hint.facing }),
        ...(placement.hint.half === undefined ? {} : { half: placement.hint.half }),
      },
    }),
  };
}

function compileError(error: BuildCompileError | undefined): BuildOpsServiceError {
  if (!error) return { code: "PERSISTENCE_FAILED", message: "BuildOps compiler returned no diagnostic" };
  return {
    code: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  };
}

function failure(
  code: Exclude<BuildOpsServiceErrorCode, BuildCompileError["code"]>,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): BuildOpsRegistrationResult {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
