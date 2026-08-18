import type { Bot } from "mineflayer";
import type { Logger } from "../util/logger.js";
import type { SkillContext, SkillDefinition, SkillResult } from "./types.js";
import type { DB } from "../memory/db.js";
import type { Bus } from "../bus/index.js";
import { startSkillRun, finishSkillRun } from "../memory/skillRuns.js";
import {
  snapshotSkillExecutionContext,
  type SkillExecutionContext,
} from "../permissions/executionActor.js";
import { summarizeForLog } from "../agent/observability.js";

export interface SkillRunnerDeps {
  bot: Bot;
  log: Logger;
  /** Explicit provenance for internal invocations that do not supply one. */
  defaultExecution: SkillExecutionContext;
  db?: DB;
  bus?: Bus;
}

export interface SkillRunOptions {
  waitForCompletion?: boolean;
  emitTrigger?: boolean;
  /** Snapshot is taken synchronously before the skill can await. */
  execution?: SkillExecutionContext;
}

export interface SkillRunner {
  /**
   * Run a skill. If another skill is already active, cancel it first.
   * Returns the result of the new run (validated params -> handler call).
   */
  run<P>(
    skill: SkillDefinition<P>,
    rawParams: unknown,
    options?: SkillRunOptions,
  ): Promise<SkillResult>;
  /** Cancel the in-flight skill, if any. No-op if none. */
  cancel(): void;
  /** Re-invoke the most recent skill with the same params. No-op if no run has happened yet. */
  restart(): void;
  /** Name of the currently-running skill, or null when idle. */
  activeName(): string | null;
  /** Whether the reflex layer should restart the active run after preemption. */
  shouldRestartActive(): boolean;
}

interface ActiveRun {
  name: string;
  paramsKey: string;
  controller: AbortController;
  restartAfterPreempt: boolean;
  /** Clears this run's private deadline alarm when it is manually preempted. */
  clearDeadlineTimer: () => void;
  /** Keeps a user/system preemption distinct from a deadline timeout. */
  markManuallyCancelled: () => void;
}

export function createSkillRunner(deps: SkillRunnerDeps): SkillRunner {
  let active: ActiveRun | null = null;
  let lastFired: {
    skill: SkillDefinition<unknown>;
    rawParams: unknown;
    execution: SkillExecutionContext;
  } | null = null;

  function cancel(): void {
    if (!active) return;
    const current = active;
    current.clearDeadlineTimer();
    current.markManuallyCancelled();
    deps.log.info({ skill: current.name }, "skill cancelled");
    current.controller.abort();
    active = null;
  }

  function deadlineExceededResult(
    skillName: string,
    execution: SkillExecutionContext,
    priorDetails?: Record<string, unknown>,
  ): SkillResult {
    const deadlineAt = execution.deadlineAt;
    // This helper is only called when a deadline exists and has elapsed.
    if (deadlineAt === undefined) {
      throw new Error("deadline result requested without a deadline");
    }
    return {
      ok: false,
      summary: `${skillName} exceeded its execution deadline`,
      code: "TIMED_OUT",
      // A persisted deadline is immutable; retrying this invocation cannot
      // make it valid again.
      recoverable: false,
      details: {
        ...(priorDetails ?? {}),
        ...(execution.planId === undefined ? {} : { planId: execution.planId }),
        ...(execution.missionRunId === undefined ? {} : { missionRunId: execution.missionRunId }),
        deadlineAt,
      },
    };
  }

  function hasExpiredDeadline(execution: SkillExecutionContext): boolean {
    return execution.deadlineAt !== undefined && Date.now() >= execution.deadlineAt;
  }

  async function run<P>(
    skill: SkillDefinition<P>,
    rawParams: unknown,
    options: SkillRunOptions = {},
  ): Promise<SkillResult> {
    // Do this before any await/cancellation side effect. In particular, callers
    // may be sharing a mutable chat ActorContext that a later trigger changes.
    const execution = snapshotSkillExecutionContext(options.execution ?? deps.defaultExecution);
    // Record the last fired skill+params before any validation or cancellation work.
    lastFired = {
      skill: skill as unknown as SkillDefinition<unknown>,
      rawParams,
      execution,
    };

    // Do not validate, cancel, or invoke a handler for work which has already
    // exceeded its immutable deadline. This also protects direct runner users
    // that do not go through TaskEngine.
    if (hasExpiredDeadline(execution)) {
      return deadlineExceededResult(skill.name, execution);
    }

    // Validate params before doing anything else (no cancel side effect on bad params).
    const parsed = skill.params.safeParse(rawParams);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return {
        ok: false,
        summary: `invalid params for ${skill.name}: ${issues}`,
        code: "INVALID_PARAMS",
        recoverable: false,
        details: { issues },
      };
    }

    // Zod parsing is synchronous, but potentially non-trivial for a large
    // input. Recheck before it can preempt another run or call the handler.
    if (hasExpiredDeadline(execution)) {
      return deadlineExceededResult(skill.name, execution);
    }

    const paramsKey = JSON.stringify(parsed.data);
    // Durable callers own a concrete task-step lifecycle. They must not be
    // handed a success acknowledgement for a matching direct/background run,
    // because that would complete the durable step under the wrong execution
    // context (and potentially the wrong mission budget/deadline).
    if (!options.waitForCompletion && active?.name === skill.name && active.paramsKey === paramsKey) {
      deps.log.info({ skill: skill.name }, "duplicate active skill request ignored");
      return {
        ok: true,
        summary: `${skill.name} is already running with the same parameters`,
        data: { activeSkill: skill.name, deduplicated: true },
      };
    }

    // Cancel any prior in-flight skill before starting the new one.
    cancel();

    const controller = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let manuallyCancelled = false;
    const clearDeadlineTimer = (): void => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };
    const markManuallyCancelled = (): void => {
      manuallyCancelled = true;
    };
    const expireAtDeadline = (): void => {
      const deadlineAt = execution.deadlineAt;
      if (deadlineAt === undefined) return;
      const remaining = deadlineAt - Date.now();
      if (remaining > 0) {
        // A mission deadline is capped to hours, but retain a bounded timer so
        // callers with a farther future generic deadline cannot overflow Node's
        // timer range.
        deadlineTimer = setTimeout(expireAtDeadline, Math.min(remaining, 2_147_483_647));
        return;
      }
      deadlineTimer = null;
      timedOut = true;
      // Match regular cancellation semantics: a timed-out background skill is
      // no longer considered active even if a misbehaving handler takes time
      // to observe AbortSignal.
      if (active?.controller === controller) active = null;
      controller.abort();
    };
    active = {
      name: skill.name,
      paramsKey,
      controller,
      // Engine-awaited runs own their retry lifecycle. Restarting those from the
      // reflex layer would duplicate execution outside the durable plan.
      restartAfterPreempt: !options.waitForCompletion,
      clearDeadlineTimer,
      markManuallyCancelled,
    };
    if (execution.deadlineAt !== undefined) {
      deadlineTimer = setTimeout(
        expireAtDeadline,
        Math.min(Math.max(0, execution.deadlineAt - Date.now()), 2_147_483_647),
      );
    }
    const log = deps.log.child({ skill: skill.name });
    log.info({ input: summarizeForLog(parsed.data) }, "RUN skill started");

    const runId = deps.db ? startSkillRun(deps.db, { skill: skill.name, params: parsed.data as Record<string, unknown> }) : null;

    const ctx: SkillContext = {
      bot: deps.bot,
      signal: controller.signal,
      log,
      reportProgress: (msg) => log.debug({ progress: msg }, "skill progress"),
      execution,
    };

    // Helper: execute the full skill lifecycle (run + finishSkillRun + bus emit + active cleanup).
    // Used by both the short-running path (awaited) and the longRunning path (background IIFE).
    const completeRun = async (): Promise<SkillResult> => {
      try {
        if (!manuallyCancelled && hasExpiredDeadline(execution)) timedOut = true;
        const rawResult = timedOut ? undefined : await skill.run(parsed.data, ctx);
        if (!manuallyCancelled && hasExpiredDeadline(execution)) timedOut = true;
        let result: SkillResult;
        if (timedOut) {
          result = deadlineExceededResult(skill.name, execution, rawResult?.details);
        } else if (rawResult === undefined) {
          // SkillDefinition promises a result. This protects the result type
          // if a malformed third-party handler violates that contract.
          throw new Error(`${skill.name} returned no result`);
        } else {
          result = controller.signal.aborted && rawResult.ok
            ? {
                ok: false,
                summary: `${skill.name} interrupted`,
                code: "INTERRUPTED",
                recoverable: true,
                details: rawResult.data,
              }
            : rawResult;
        }
        if (deps.db && runId !== null) {
          const status = timedOut ? "failed" : controller.signal.aborted ? "cancelled" : result.ok ? "ok" : "failed";
          finishSkillRun(deps.db, runId, {
            status,
            summary: result.summary,
            data: result.data,
            errorCode: result.code,
            recoverable: result.recoverable,
            details: result.details,
          });
        }
        log.info(
          { ok: result.ok, summary: result.summary },
          result.ok ? "RESULT skill completed" : "RESULT skill failed",
        );

        // Emit bus trigger on completion (not on cancellation)
        if (deps.bus && options.emitTrigger !== false && (!controller.signal.aborted || timedOut)) {
          if (result.ok) {
            deps.bus.emit("agent.trigger", { kind: "skillDone", skill: skill.name, ok: true, summary: result.summary });
          } else {
            deps.bus.emit("agent.trigger", {
              kind: "skillFailed",
              skill: skill.name,
              error: result.summary,
              code: result.code ?? "UNKNOWN",
              recoverable: result.recoverable ?? false,
              details: result.details,
            });
          }
        }

        return result;
      } catch (err) {
        const errMsg = (err as Error).message ?? String(err);
        if (!manuallyCancelled && hasExpiredDeadline(execution)) timedOut = true;
        const result = timedOut
          ? deadlineExceededResult(skill.name, execution, { message: errMsg })
          : {
              ok: false,
              summary: `${skill.name} threw: ${errMsg}`,
              code: controller.signal.aborted ? "INTERRUPTED" : "UNKNOWN",
              recoverable: !controller.signal.aborted,
              details: { message: errMsg },
            } as SkillResult;
        if (deps.db && runId !== null) {
          finishSkillRun(deps.db, runId, {
            status: timedOut ? "failed" : controller.signal.aborted ? "cancelled" : "failed",
            summary: result.summary,
            errorCode: result.code,
            recoverable: result.recoverable,
            details: result.details,
          });
        }
        log.error({ err }, "skill threw");

        // Emit skillFailed trigger on exception (not on cancellation)
        if (deps.bus && options.emitTrigger !== false && (!controller.signal.aborted || timedOut)) {
          deps.bus.emit("agent.trigger", {
            kind: "skillFailed",
            skill: skill.name,
            error: result.summary,
            code: result.code ?? "UNKNOWN",
            recoverable: result.recoverable ?? false,
            details: result.details,
          });
        }
        return result;
      } finally {
        clearDeadlineTimer();
        // Only clear `active` if this run is still the active one. A concurrent cancel()
        // would have already set it to null and started something new.
        if (active?.controller === controller) active = null;
      }
    };

    if (skill.longRunning && !options.waitForCompletion) {
      // Fire-and-forget: return an acknowledgement immediately so the MCP tool handler
      // doesn't block the Claude session while the skill runs indefinitely.
      void completeRun();
      return { ok: true, summary: `${skill.name} started` };
    }

    return completeRun();
  }

  function restart(): void {
    if (!lastFired) return;
    // Fire-and-forget — `run()` itself handles the cancel-prior-run logic if anything is active.
    void run(lastFired.skill, lastFired.rawParams, { execution: lastFired.execution });
  }

  return {
    run,
    cancel,
    restart,
    activeName: () => active?.name ?? null,
    shouldRestartActive: () => active?.restartAfterPreempt ?? false,
  };
}
