import type { Bot } from "mineflayer";
import { z } from "zod";
import type { Logger } from "../util/logger.js";
import {
  cloneCapabilityPolicy,
  type CapabilityPolicy,
} from "../permissions/capabilities.js";
import type { SkillExecutionContext } from "../permissions/executionActor.js";

export interface SkillContext {
  bot: Bot;
  signal: AbortSignal;
  log: Logger;
  reportProgress: (msg: string) => void;
  /** Immutable actor/provenance snapshot for this particular invocation. */
  execution: SkillExecutionContext;
}

export type SkillErrorCode =
  | "INVALID_PARAMS"
  | "PERMISSION_DENIED"
  | "NO_PATH"
  | "NO_TOOL"
  | "NO_MATERIAL"
  | "NO_FUEL"
  | "NO_BLOCK_FOUND"
  | "INVENTORY_FULL"
  | "TARGET_UNAVAILABLE"
  | "AREA_UNSAFE"
  | "BUDGET_EXCEEDED"
  | "STALE_STATE"
  /** The selected client/version cannot safely place or verify a requested block state. */
  | "UNSUPPORTED_STATE"
  | "INTERRUPTED"
  | "TIMED_OUT"
  | "SERVER_REJECTED"
  | "NOT_CONFIGURED"
  | "PLUGIN_UNAVAILABLE"
  | "WORLD_UNAVAILABLE"
  | "UNKNOWN";

export interface SkillResult {
  ok: boolean;
  summary: string;
  /** Stable machine-readable reason for a failed run. */
  code?: SkillErrorCode;
  /** Whether a coordinator may reasonably retry or insert prerequisite work. */
  recoverable?: boolean;
  /** Structured failure context; never require callers to parse `summary`. */
  details?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface SkillDefinition<P> {
  name: string;
  description: string;
  /** Explicit access/effect metadata shared with the agent-tool adapter. */
  policy: CapabilityPolicy;
  params: z.ZodObject<z.ZodRawShape, "strip", z.ZodTypeAny, P>;
  run(params: P, ctx: SkillContext): Promise<SkillResult>;
  /**
   * If true, the runner returns acknowledgement immediately ("X started")
   * instead of awaiting completion. Use for skills that run indefinitely
   * (e.g., followPlayer) so the MCP tool handler doesn't block the Claude
   * session. Completion is signaled via skillDone/skillFailed bus triggers.
   */
  longRunning?: boolean;
}

/** Identity helper that preserves the inferred params type from the Zod schema. */
export function defineSkill<P>(def: SkillDefinition<P>): SkillDefinition<P> {
  return { ...def, policy: cloneCapabilityPolicy(def.policy) };
}
