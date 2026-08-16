import type { DB } from "../memory/db.js";
import type { Logger } from "../util/logger.js";
import type { Bus } from "../bus/index.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillRunner } from "../skills/runner.js";
import type { SkillResult } from "../skills/types.js";
import { getMissionRunByTaskPlan } from "../missions/store.js";
import { roleSatisfies } from "../permissions/capabilities.js";
import {
  resolveCurrentExecutionRole,
  snapshotExecutionActor,
  systemActor,
  type ExecutionActor,
} from "../permissions/executionActor.js";
import type { PlayerRole } from "../permissions/roles.js";
import {
  cancelTaskPlan,
  claimNextTaskStep,
  completeTaskStep,
  createTaskPlan,
  ensureTaskPlanActor,
  findMatchingActiveTaskPlan,
  failTaskStep,
  getTaskPlan,
  nextRetryAt,
  pauseTaskPlan,
  reconcileInterruptedTasks,
  resumeTaskPlan,
  type TaskPlanDetail,
  type TaskStepInput,
} from "./store.js";

export interface TaskEngine {
  start(): void;
  stop(): void;
  suspend(): void;
  resumeExecution(): void;
  create(input: {
    title: string;
    steps: TaskStepInput[];
    actor: ExecutionActor;
  }): TaskPlanDetail;
  get(planId: number): TaskPlanDetail | undefined;
  pause(planId: number): boolean;
  resume(planId: number): boolean;
  cancel(planId: number): boolean;
  wake(): void;
  activePlanId(): number | null;
}

export interface TaskEngineDeps {
  db: DB;
  log: Logger;
  bus: Bus;
  registry: SkillRegistry;
  runner: SkillRunner;
  /** The only identity permitted for scheduler/recovery system actors. */
  ownerUsername: string;
  now?: () => number;
}

export interface TaskPlanAuthorizationDetails extends Record<string, unknown> {
  username: string;
  actorRole: PlayerRole;
  currentRole: PlayerRole | null;
  source: ExecutionActor["source"];
  stepIndex: number;
  skill: string;
  minimumRole: string;
  effect: string;
}

/** A structured distinction so tools can return PERMISSION_DENIED, not bad input. */
export class TaskPlanAuthorizationError extends Error {
  readonly details: TaskPlanAuthorizationDetails;

  constructor(details: TaskPlanAuthorizationDetails) {
    super(
      `actor '${details.username}' no longer has permission for step ${details.stepIndex + 1} ` +
      `(${details.skill}; requires ${details.minimumRole})`,
    );
    this.name = "TaskPlanAuthorizationError";
    this.details = details;
  }
}

export function createTaskEngine(deps: TaskEngineDeps): TaskEngine {
  const now = deps.now ?? Date.now;
  let started = false;
  let stopped = false;
  let draining = false;
  let available = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let activePlan: number | null = null;
  const recoveredLegacyPlans = new Set<number>();

  function authorizationError(
    actor: ExecutionActor,
    currentRole: PlayerRole | undefined,
    step: { position: number; skill: string },
  ): TaskPlanAuthorizationError {
    const skill = deps.registry.get(step.skill);
    return new TaskPlanAuthorizationError({
      username: actor.username,
      actorRole: actor.role,
      currentRole: currentRole ?? null,
      source: actor.source,
      stepIndex: step.position,
      skill: step.skill,
      minimumRole: skill?.policy.minimumRole ?? "unknown",
      effect: skill?.policy.effect ?? "unknown",
    });
  }

  function authorizeStep(
    actor: ExecutionActor,
    step: { position: number; skill: string },
  ): { role: PlayerRole; skill: NonNullable<ReturnType<SkillRegistry["get"]>> } | TaskPlanAuthorizationError {
    const currentRole = resolveCurrentExecutionRole(deps.db, actor, deps.ownerUsername);
    const skill = deps.registry.get(step.skill);
    if (!currentRole || !skill || !roleSatisfies(currentRole, skill.policy)) {
      return authorizationError(actor, currentRole, step);
    }
    return { role: currentRole, skill };
  }

  function deadlineExceededResult(
    missionRunId: number,
    deadlineAt: number,
    step: { position: number; skill: string },
  ): SkillResult {
    return {
      ok: false,
      summary: `mission run ${missionRunId} exceeded its deadline before step ${step.position + 1} (${step.skill})`,
      code: "TIMED_OUT",
      // Retrying cannot make a fixed, persisted deadline valid again.
      recoverable: false,
      details: {
        missionRunId,
        deadlineAt,
        stepIndex: step.position,
        skill: step.skill,
      },
    };
  }

  function schedule(delayMs = 0): void {
    if (!started || stopped || !available) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void drain();
    }, Math.max(0, delayMs));
  }

  async function drain(): Promise<void> {
    if (draining || stopped || !available) return;
    draining = true;
    try {
      while (!stopped) {
        const step = claimNextTaskStep(deps.db, now());
        if (!step) break;
        activePlan = step.planId;
        let planBefore = getTaskPlan(deps.db, step.planId);
        if (planBefore && !planBefore.actor) {
          const recoveryActor = systemActor(deps.ownerUsername, "recovery");
          ensureTaskPlanActor(deps.db, planBefore.id, recoveryActor, now());
          if (!recoveredLegacyPlans.has(planBefore.id)) {
            recoveredLegacyPlans.add(planBefore.id);
            deps.log.warn({ planId: planBefore.id }, "attached recovery actor to legacy task plan");
          }
          planBefore = getTaskPlan(deps.db, step.planId);
        }
        deps.log.info(
          { planId: step.planId, stepId: step.id, skill: step.skill, attempt: step.attempts },
          "task step started",
        );

        const actor = planBefore?.actor;
        // A task plan is ordinarily independent. Only linked mission plans
        // inherit a durable mission execution context.
        const missionRun = getMissionRunByTaskPlan(deps.db, step.planId);
        const missionDeadlineExceeded = missionRun !== undefined && now() >= missionRun.deadlineAt;
        const authorization = actor
          ? authorizeStep(actor, step)
          : undefined;
        const result: SkillResult = !actor
          ? {
              ok: false,
              summary: `task plan ${step.planId} has no actor provenance`,
              code: "PERMISSION_DENIED",
              recoverable: false,
              details: { planId: step.planId },
            }
          : missionDeadlineExceeded
            ? deadlineExceededResult(missionRun.id, missionRun.deadlineAt, step)
          : authorization instanceof TaskPlanAuthorizationError
            ? {
                ok: false,
                summary: authorization.message,
                code: "PERMISSION_DENIED",
                recoverable: false,
                details: authorization.details,
              }
            : authorization
              ? await deps.runner.run(authorization.skill, step.params, {
                  waitForCompletion: true,
                  emitTrigger: false,
                  execution: {
                    actor,
                    planId: step.planId,
                    ...(missionRun === undefined ? {} : {
                      missionRunId: missionRun.id,
                      deadlineAt: missionRun.deadlineAt,
                      maxWorldChanges: missionRun.limits.maxWorldChanges,
                      transactionScope: missionRun.transactionScope,
                      transactionCorrelation: missionRun.transactionCorrelation,
                    }),
                  },
                })
              : {
              ok: false,
              summary: `unknown task skill: ${step.skill}`,
              code: "NOT_CONFIGURED",
              recoverable: false,
              details: { skill: step.skill },
              };

        const currentPlan = getTaskPlan(deps.db, step.planId);
        const currentStep = currentPlan?.steps.find((candidate) => candidate.id === step.id);
        if (
          !currentPlan ||
          currentPlan.status === "paused" ||
          currentPlan.status === "cancelled" ||
          currentStep?.status !== "running"
        ) {
          activePlan = null;
          continue;
        }

        if (result.ok) {
          completeTaskStep(deps.db, step.id, result);
          const completedPlan = getTaskPlan(deps.db, step.planId);
          if (completedPlan?.status === "completed") {
            deps.bus.emit("agent.trigger", {
              kind: "taskPlanDone",
              planId: completedPlan.id,
              title: completedPlan.title,
            });
          }
        } else {
          const canRetry = result.recoverable === true && step.attempts < step.maxAttempts;
          const retryAt = canRetry
            ? now() + Math.min(60_000, 1_000 * (2 ** Math.max(0, step.attempts - 1)))
            : null;
          failTaskStep(deps.db, step.id, result, retryAt);
          const failedPlan = getTaskPlan(deps.db, step.planId);
          if (failedPlan?.status === "failed") {
            deps.bus.emit("agent.trigger", {
              kind: "taskPlanFailed",
              planId: failedPlan.id,
              title: failedPlan.title,
              error: result.summary,
            });
          }
        }
        deps.log.info(
          {
            planId: step.planId,
            stepId: step.id,
            ok: result.ok,
            priorStatus: planBefore?.status,
          },
          "task step finished",
        );
        activePlan = null;
      }
    } catch (err) {
      deps.log.error({ err }, "task engine drain failed");
    } finally {
      activePlan = null;
      draining = false;
      const retryAt = nextRetryAt(deps.db);
      if (retryAt !== undefined) schedule(Math.max(0, retryAt - now()));
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    stopped = false;
    available = true;
    const reconciled = reconcileInterruptedTasks(deps.db);
    if (reconciled > 0) {
      deps.log.warn({ reconciled }, "reconciled interrupted task steps");
    }
    schedule();
  }

  function stop(): void {
    stopped = true;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
  }

  function suspend(): void {
    available = false;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
  }

  function resumeExecution(): void {
    if (!started || stopped) return;
    available = true;
    schedule();
  }

  function create(input: {
    title: string;
    steps: TaskStepInput[];
    actor: ExecutionActor;
  }): TaskPlanDetail {
    if (input.steps.length === 0) throw new Error("task plan requires at least one step");
    const actor = snapshotExecutionActor(input.actor);
    const currentRole = resolveCurrentExecutionRole(deps.db, actor, deps.ownerUsername);
    for (const [position, step] of input.steps.entries()) {
      const skill = deps.registry.get(step.skill);
      if (!skill) {
        throw new Error(`unknown task skill: ${step.skill}`);
      }
      if (!currentRole || !roleSatisfies(currentRole, skill.policy)) {
        throw authorizationError(actor, currentRole, { position, skill: step.skill });
      }
    }
    // Persist the role that was freshly verified at enqueue time, never a stale
    // mutable request value supplied by the caller.
    const authorizedActor = snapshotExecutionActor({ ...actor, role: currentRole! });
    const createInput = { ...input, actor: authorizedActor };
    const existing = findMatchingActiveTaskPlan(deps.db, createInput);
    if (existing) {
      deps.log.info({ planId: existing.id }, "reused matching active task plan");
      return existing;
    }
    const plan = createTaskPlan(deps.db, createInput);
    schedule();
    return plan;
  }

  function pause(planId: number): boolean {
    const changed = pauseTaskPlan(deps.db, planId);
    if (changed && activePlan === planId) deps.runner.cancel();
    return changed;
  }

  function resume(planId: number): boolean {
    const changed = resumeTaskPlan(deps.db, planId);
    if (changed) schedule();
    return changed;
  }

  function cancel(planId: number): boolean {
    const changed = cancelTaskPlan(deps.db, planId);
    if (changed && activePlan === planId) deps.runner.cancel();
    return changed;
  }

  return {
    start,
    stop,
    suspend,
    resumeExecution,
    create,
    get: (planId) => getTaskPlan(deps.db, planId),
    pause,
    resume,
    cancel,
    wake: () => schedule(),
    activePlanId: () => activePlan,
  };
}
