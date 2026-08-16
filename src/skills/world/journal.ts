import type {
  BlockMutationEvent,
  BlockMutationHookFailure,
  BlockMutationHooks,
} from "../../world/blockExecutor.js";
import type {
  WorldTransactionDetail,
} from "../../world/transactions/types.js";
import type {
  WorldTransactionService,
} from "../../world/transactions/service.js";
import type { SkillContext, SkillResult } from "../types.js";

/** Narrow runtime dependency boundary for journaled direct world skills. */
export interface WorldSkillDependencies {
  readonly transactions: WorldTransactionService;
  readonly serverKey: string;
}

export interface StartedWorldJournal {
  readonly transaction: WorldTransactionDetail;
  readonly dimension: string;
}

export interface JournalMutation {
  readonly hooks: BlockMutationHooks;
  /** True only after a durable planned row was accepted. */
  readonly hasPlanned: () => boolean;
}

/**
 * Start a transaction from the invocation's immutable execution snapshot.
 * A bot can only journal a live, named dimension; guessing "overworld" on a
 * disconnected client would make reconnect reconciliation unsafe.
 */
export function beginWorldJournal(
  deps: WorldSkillDependencies,
  ctx: SkillContext,
  input: { kind: string; label?: string },
): StartedWorldJournal | SkillResult {
  const dimension = ctx.bot.game?.dimension?.trim();
  if (!dimension) {
    return {
      ok: false,
      summary: "the current Minecraft dimension is unavailable; no world mutation was started",
      code: "WORLD_UNAVAILABLE",
      recoverable: true,
    };
  }
  const execution = ctx.execution;
  const budgetScope = execution.transactionScope ?? (execution.missionRunId !== undefined
    ? `mission:${execution.missionRunId}`
    : execution.planId !== undefined
      ? `plan:${execution.planId}`
      : undefined);
  const transaction = deps.transactions.begin({
    serverKey: deps.serverKey,
    dimension,
    label: input.label,
    kind: input.kind,
    actor: execution.actor,
    ...(execution.planId === undefined ? {} : { taskPlanId: execution.planId }),
    ...(budgetScope === undefined ? {} : { budgetScope }),
    correlation: execution.missionRunId === undefined
      ? (execution.transactionCorrelation ?? {})
      : { ...(execution.transactionCorrelation ?? {}), missionRunId: execution.missionRunId },
  });
  return Object.freeze({ transaction, dimension });
}

export function isStartedWorldJournal(value: StartedWorldJournal | SkillResult): value is StartedWorldJournal {
  return "transaction" in value;
}

/**
 * Test the whole operation's requested size before it can plan the first
 * Mineflayer mutation. The executor hook still atomically guards a race or a
 * future concurrent caller.
 */
export function preflightWorldJournal(
  deps: WorldSkillDependencies,
  journal: StartedWorldJournal,
  ctx: SkillContext,
  requestedChanges: number,
): SkillResult | undefined {
  const result = deps.transactions.preflightWorldChanges({
    transactionId: journal.transaction.id,
    maxWorldChanges: ctx.execution.maxWorldChanges,
    requestedChanges,
  });
  if (result.ok) return undefined;
  const transaction = deps.transactions.cancel(journal.transaction.id, result.summary);
  return {
    ok: false,
    summary: result.summary,
    code: result.code,
    recoverable: result.recoverable,
    details: {
      ...result.details,
      transaction: transactionDetails(transaction),
    },
  };
}

/** One fresh journal closure must be used for exactly one world mutation. */
export function createJournalMutation(
  deps: WorldSkillDependencies,
  journal: StartedWorldJournal,
  ctx: SkillContext,
  ordinal: number,
): JournalMutation {
  const source = deps.transactions.createMutationHooks({
    transactionId: journal.transaction.id,
    ordinal,
    maxWorldChanges: ctx.execution.maxWorldChanges,
  });
  let planned = false;
  const hooks: BlockMutationHooks = {
    planned: async (event: BlockMutationEvent): Promise<void | BlockMutationHookFailure> => {
      const outcome = await source.planned?.(event);
      if (!isHookFailure(outcome)) planned = true;
      return outcome;
    },
    applied: (event) => source.applied?.(event),
    conflicted: (event) => source.conflicted?.(event),
    failed: (event) => source.failed?.(event),
  };
  return Object.freeze({ hooks: Object.freeze(hooks), hasPlanned: () => planned });
}

/**
 * For an individual action, terminally classify a resolved planned row. If it
 * remains uncertain, cancellation deliberately leaves the transaction open
 * for scoped reconnect reconciliation.
 */
export function finalizeSingleWorldJournal(
  deps: WorldSkillDependencies,
  journal: StartedWorldJournal,
  mutation: JournalMutation,
  fallbackError: string,
): WorldTransactionDetail | undefined {
  if (!mutation.hasPlanned()) {
    return deps.transactions.cancel(journal.transaction.id, fallbackError);
  }
  try {
    return deps.transactions.complete(journal.transaction.id);
  } catch {
    return deps.transactions.cancel(journal.transaction.id, fallbackError);
  }
}

/** Use this when a multi-cell operation exits before finishing its full scan. */
export function cancelWorldJournal(
  deps: WorldSkillDependencies,
  journal: StartedWorldJournal,
  error: string,
): WorldTransactionDetail | undefined {
  return deps.transactions.cancel(journal.transaction.id, error);
}

export function completeWorldJournal(
  deps: WorldSkillDependencies,
  journal: StartedWorldJournal,
): WorldTransactionDetail | undefined {
  return deps.transactions.complete(journal.transaction.id);
}

export function transactionDetails(
  transaction: WorldTransactionDetail | undefined,
): Record<string, unknown> | undefined {
  if (!transaction) return undefined;
  return {
    id: transaction.id,
    status: transaction.status,
    requestedChangeCount: transaction.requestedChangeCount,
    appliedChangeCount: transaction.appliedChangeCount,
    ...(transaction.lastError === null ? {} : { lastError: transaction.lastError }),
  };
}

function isHookFailure(value: void | BlockMutationHookFailure | undefined): value is BlockMutationHookFailure {
  return value !== undefined && value.ok === false;
}
