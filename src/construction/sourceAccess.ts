import type { DB } from "../memory/db.js";
import {
  resolveCurrentExecutionRole,
  type ExecutionActor,
} from "../permissions/executionActor.js";
import {
  getBlueprintSource,
  type BlueprintRow,
  type BlueprintSourceCreator,
} from "./store.js";

/** The compiler may only persist executable generated designs at these levels. */
export type ConstructionSourceRequiredAccess = "operator" | "owner";

/**
 * The execution-time, non-secret subset of a validated source envelope.
 * A caller receives this only after the actor has been reauthorized against
 * the current role table.
 */
export interface ConstructionSourceAccessGrant {
  readonly requiredAccess: ConstructionSourceRequiredAccess;
  readonly targetVersion: string;
  readonly sourceHash: string;
  readonly creator: BlueprintSourceCreator;
}

export interface AssertCurrentConstructionSourceAccessInput {
  readonly db: DB;
  readonly ownerUsername: string;
  readonly blueprint: Pick<BlueprintRow, "id" | "name">;
  /** Durable provenance is a snapshot; its current role is resolved below. */
  readonly actor: ExecutionActor;
  /**
   * Exact configured server version, if the caller has one. Supplying this
   * prevents a source compiled for a neighboring Minecraft patch from running.
   */
  readonly configuredVersion?: string;
  /**
   * Exact version reported by the connected bot, if available. This is kept
   * separate from configuration so a stale/misconnected client fails closed.
   */
  readonly liveVersion?: string;
}

/**
 * Reauthorize a source-backed blueprint immediately before world execution.
 *
 * Raw/private blueprints deliberately return `undefined`: they retain the
 * pre-BuildOps path and must not be mistaken for a source-derived access
 * grant. Source rows instead require a valid compiler report, a current role
 * that meets it, and (when supplied) an exact runtime-version match.
 */
export function assertCurrentConstructionSourceAccess(
  input: AssertCurrentConstructionSourceAccessInput,
): ConstructionSourceAccessGrant | undefined {
  const source = getBlueprintSource(input.db, input.blueprint.id);
  if (!source) return undefined;

  const requiredAccess = parseRequiredSourceAccess(source.compileReportJson, input.blueprint.name);
  const currentRole = resolveCurrentExecutionRole(input.db, input.actor, input.ownerUsername);
  if (!roleMeetsSourceRequirement(currentRole, requiredAccess)) {
    const actual = currentRole ?? "none";
    throw new Error(
      `blueprint '${input.blueprint.name}' requires ${requiredAccess} access; ` +
      `actor '${input.actor.username}' currently has ${actual}`,
    );
  }

  assertExactRuntimeVersion(
    input.blueprint.name,
    source.targetVersion,
    input.configuredVersion,
    "configured runtime",
  );
  assertExactRuntimeVersion(
    input.blueprint.name,
    source.targetVersion,
    input.liveVersion,
    "live bot",
  );

  return {
    requiredAccess,
    targetVersion: source.targetVersion,
    sourceHash: source.sourceHash,
    creator: { ...source.creator },
  };
}

/** Source envelopes are untrusted on read: report corruption must fail closed. */
function parseRequiredSourceAccess(
  compileReportJson: string,
  blueprintName: string,
): ConstructionSourceRequiredAccess {
  let report: unknown;
  try {
    report = JSON.parse(compileReportJson) as unknown;
  } catch {
    throw new Error(
      `blueprint '${blueprintName}' has an invalid source access report and cannot execute`,
    );
  }
  if (!isRecord(report) ||
      (report.requiredAccess !== "operator" && report.requiredAccess !== "owner")) {
    throw new Error(
      `blueprint '${blueprintName}' has an invalid source access report and cannot execute`,
    );
  }
  return report.requiredAccess;
}

function roleMeetsSourceRequirement(
  currentRole: "owner" | "operator" | "viewer" | undefined,
  requiredAccess: ConstructionSourceRequiredAccess,
): boolean {
  return requiredAccess === "owner"
    ? currentRole === "owner"
    : currentRole === "owner" || currentRole === "operator";
}

function assertExactRuntimeVersion(
  blueprintName: string,
  targetVersion: string,
  runtimeVersion: string | undefined,
  runtimeLabel: string,
): void {
  if (runtimeVersion === undefined) return;
  const normalizedRuntimeVersion = runtimeVersion.trim();
  if (!normalizedRuntimeVersion || targetVersion !== normalizedRuntimeVersion) {
    throw new Error(
      `blueprint '${blueprintName}' targets Minecraft ${targetVersion}, ` +
      `but ${runtimeLabel} is ${normalizedRuntimeVersion || "unknown"}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
