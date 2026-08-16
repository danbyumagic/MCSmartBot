import type { DB } from "../memory/db.js";
import { sameMinecraftUsername } from "../bot/playerIdentity.js";
import { resolvePlayerRole, type PlayerRole } from "./roles.js";

/** Where a durable or immediate action originally came from. */
export type ExecutionSource =
  | "minecraft-chat"
  | "cli"
  | "desktop"
  | "scheduler"
  | "recovery";

/**
 * Immutable provenance for work that may outlive the chat request that created
 * it. The recorded role is audit provenance; callers must re-resolve it before
 * executing a durable step.
 */
export interface ExecutionActor {
  readonly username: string;
  readonly role: PlayerRole;
  readonly source: ExecutionSource;
}

/** Context carried into every skill invocation. */
export interface SkillExecutionContext {
  readonly actor: ExecutionActor;
  readonly planId?: number;
  readonly missionRunId?: number;
  readonly transactionId?: number;
  /**
   * Durable budget namespace supplied by a linked mission run.  Ordinary
   * direct/task-plan work intentionally leaves this absent so the journal can
   * retain its existing plan-scoped behavior.
   */
  readonly transactionScope?: string;
  /**
   * Immutable JSON correlation copied from the mission run into every
   * execution boundary.  It is metadata only; `missionRunId` remains the
   * canonical identity used for authorization and budget scoping.
   */
  readonly transactionCorrelation?: Readonly<Record<string, ExecutionJsonValue>>;
  readonly deadlineAt?: number;
  readonly maxWorldChanges?: number;
}

/** Small, dependency-free JSON vocabulary for execution provenance. */
export type ExecutionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ExecutionJsonValue[]
  | { readonly [key: string]: ExecutionJsonValue };

const ROLE_VALUES = new Set<PlayerRole>(["owner", "operator", "viewer"]);
const SOURCE_VALUES = new Set<ExecutionSource>([
  "minecraft-chat",
  "cli",
  "desktop",
  "scheduler",
  "recovery",
]);

function invalid(message: string): never {
  throw new Error(`invalid execution actor: ${message}`);
}

function normalizedUsername(username: unknown): string {
  if (typeof username !== "string") invalid("username must be a string");
  const value = username.trim();
  if (value.length === 0 || value.length > 64) invalid("username must be 1-64 characters");
  return value;
}

function validRole(role: unknown): PlayerRole {
  if (!ROLE_VALUES.has(role as PlayerRole)) invalid("role is not recognized");
  return role as PlayerRole;
}

function validSource(source: unknown): ExecutionSource {
  if (!SOURCE_VALUES.has(source as ExecutionSource)) invalid("source is not recognized");
  return source as ExecutionSource;
}

/** Clone immediately so later mutations to a request's ActorContext cannot leak in. */
export function snapshotExecutionActor(actor: {
  username: unknown;
  role: unknown;
  source: unknown;
}): ExecutionActor {
  return Object.freeze({
    username: normalizedUsername(actor.username),
    role: validRole(actor.role),
    source: validSource(actor.source),
  });
}

/** Strictly rebuild actor provenance read from SQLite. */
export function parsePersistedExecutionActor(value: unknown): ExecutionActor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("persisted actor must be an object");
  }
  const actor = value as Record<string, unknown>;
  return snapshotExecutionActor({
    username: actor.username,
    role: actor.role,
    source: actor.source,
  });
}

function positiveId(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid execution context: ${name} must be a positive integer`);
  }
  return value;
}

function positiveTimestamp(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid execution context: ${name} must be a positive timestamp`);
  }
  return value;
}

function nonNegativeInteger(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid execution context: ${name} must be a non-negative integer`);
  }
  return value;
}

function optionalTransactionScope(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("invalid execution context: transactionScope must be a string");
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new Error("invalid execution context: transactionScope must be 1-128 characters");
  }
  return normalized;
}

/**
 * Treat execution correlation like persistence input, not an arbitrary live
 * object. This prevents mutable/prototype-bearing data from leaking into a
 * long-running skill context while keeping the permissions layer independent
 * of MissionScript's schema modules.
 */
function snapshotCorrelation(value: unknown): Readonly<Record<string, ExecutionJsonValue>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error("invalid execution context: transactionCorrelation must be a plain JSON object");
  }
  let nodes = 0;
  const seen = new WeakSet<object>();
  const clone = (candidate: unknown, depth: number): ExecutionJsonValue => {
    nodes++;
    if (nodes > 4_096 || depth > 32) {
      throw new Error("invalid execution context: transactionCorrelation exceeds JSON bounds");
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error("invalid execution context: transactionCorrelation contains a non-finite number");
      }
      return candidate;
    }
    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) {
        throw new Error("invalid execution context: transactionCorrelation must not be cyclic");
      }
      seen.add(candidate);
      return Object.freeze(candidate.map((entry) => clone(entry, depth + 1)));
    }
    if (!isPlainRecord(candidate)) {
      throw new Error("invalid execution context: transactionCorrelation must contain JSON values only");
    }
    if (seen.has(candidate)) {
      throw new Error("invalid execution context: transactionCorrelation must not be cyclic");
    }
    seen.add(candidate);
    const result: Record<string, ExecutionJsonValue> = {};
    for (const [key, entry] of Object.entries(candidate)) {
      if (key.length > 256) {
        throw new Error("invalid execution context: transactionCorrelation key is too long");
      }
      result[key] = clone(entry, depth + 1);
    }
    return Object.freeze(result);
  };
  const cloned = clone(value, 0);
  if (!isPlainRecord(cloned)) {
    throw new Error("invalid execution context: transactionCorrelation must be an object");
  }
  return cloned;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Clone nested provenance and validate bounded scalar execution metadata. */
export function snapshotSkillExecutionContext(
  context: {
    actor: ExecutionActor | { username: unknown; role: unknown; source: unknown };
    planId?: unknown;
    missionRunId?: unknown;
    transactionId?: unknown;
    transactionScope?: unknown;
    transactionCorrelation?: unknown;
    deadlineAt?: unknown;
    maxWorldChanges?: unknown;
  },
): SkillExecutionContext {
  const planId = positiveId("planId", context.planId);
  const missionRunId = positiveId("missionRunId", context.missionRunId);
  const transactionId = positiveId("transactionId", context.transactionId);
  const transactionScope = optionalTransactionScope(context.transactionScope);
  const transactionCorrelation = snapshotCorrelation(context.transactionCorrelation);
  const deadlineAt = positiveTimestamp("deadlineAt", context.deadlineAt);
  const maxWorldChanges = nonNegativeInteger("maxWorldChanges", context.maxWorldChanges);
  return Object.freeze({
    actor: snapshotExecutionActor(context.actor),
    ...(planId === undefined ? {} : { planId }),
    ...(missionRunId === undefined ? {} : { missionRunId }),
    ...(transactionId === undefined ? {} : { transactionId }),
    ...(transactionScope === undefined ? {} : { transactionScope }),
    ...(transactionCorrelation === undefined ? {} : { transactionCorrelation }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(maxWorldChanges === undefined ? {} : { maxWorldChanges }),
  });
}

/** Named system work is always explicitly bound to the configured owner. */
export function systemActor(
  ownerUsername: string,
  source: "scheduler" | "recovery",
): ExecutionActor {
  return snapshotExecutionActor({ username: ownerUsername, role: "owner", source });
}

/**
 * Resolve authorization immediately before durable execution. A scheduler or
 * recovery actor only has owner authority when it still names the configured
 * owner; user-originated work is always checked against the current role table.
 */
export function resolveCurrentExecutionRole(
  db: DB,
  actor: ExecutionActor,
  ownerUsername: string,
): PlayerRole | undefined {
  if (actor.source === "scheduler" || actor.source === "recovery") {
    return sameMinecraftUsername(actor.username, ownerUsername) ? "owner" : undefined;
  }
  return resolvePlayerRole(db, actor.username, ownerUsername);
}
