import { z } from "zod";
import type { Bot } from "mineflayer";
import type { ExecutionActor } from "../permissions/executionActor.js";
import type { WorldTransactionService } from "../world/transactions/service.js";
import type { WorldTransactionDetail, WorldTransactionRow, WorldTransactionStatus } from "../world/transactions/types.js";
import {
  previewUndoTransaction,
  undoWorldTransaction,
} from "../skills/world/undoTransaction.js";
import type { ToolDef, ToolResult } from "./tools.js";

const statuses = [
  "open",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "undoing",
  "undone",
  "undo_partial",
] as const satisfies readonly WorldTransactionStatus[];

export const listWorldTransactionsSchema = z.object({
  dimension: z.string().trim().min(1).max(128).optional(),
  status: z.enum(statuses).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const getWorldTransactionSchema = z.object({
  transactionId: z.number().int().positive(),
});

export const previewUndoTransactionSchema = z.object({
  transactionId: z.number().int().positive(),
});

export const undoWorldTransactionSchema = z.object({
  transactionId: z.number().int().positive(),
  storageName: z.string().trim().min(1).max(128).optional().describe(
    "Optional indexed storage label to help an operator locate missing restoration material; no item is synthesized.",
  ),
});

export interface TransactionToolDependencies {
  readonly transactions: WorldTransactionService;
  readonly serverKey: string;
  readonly getBot: () => Bot | undefined;
  readonly actorProvider: () => ExecutionActor;
}

export function createListWorldTransactionsTool(
  deps: TransactionToolDependencies,
): ToolDef<z.infer<typeof listWorldTransactionsSchema>> {
  return {
    name: "listWorldTransactions",
    policy: { minimumRole: "owner", effect: "read", reversible: false, mission: "forbidden" },
    description: "List bounded durable world transactions for the current server, optionally filtered by dimension or status.",
    inputSchema: listWorldTransactionsSchema,
    handler: async ({ dimension, status, limit }) => {
      const denied = requireOwner(deps.actorProvider());
      if (denied) return denied;
      try {
        const rows = deps.transactions.list({
          serverKey: deps.serverKey,
          ...(dimension === undefined ? {} : { dimension }),
          ...(status === undefined ? {} : { status }),
          ...(limit === undefined ? {} : { limit }),
        });
        return {
          ok: true,
          summary: JSON.stringify({
            transactions: rows.map((row) => compactTransaction(row)),
            totalCount: rows.length,
          }),
        };
      } catch (error) {
        return toolFailure(`could not list world transactions: ${message(error)}`, "INVALID_PARAMS");
      }
    },
  };
}

export function createGetWorldTransactionTool(
  deps: TransactionToolDependencies,
): ToolDef<z.infer<typeof getWorldTransactionSchema>> {
  return {
    name: "getWorldTransaction",
    policy: { minimumRole: "owner", effect: "read", reversible: false, mission: "forbidden" },
    description: "Read one bounded durable world transaction and its change history.",
    inputSchema: getWorldTransactionSchema,
    handler: async ({ transactionId }) => {
      const denied = requireOwner(deps.actorProvider());
      if (denied) return denied;
      const transaction = deps.transactions.get(transactionId);
      if (!transaction || transaction.serverKey !== deps.serverKey) {
        return toolFailure(`no world transaction ${transactionId} exists for this server`, "NOT_CONFIGURED", false);
      }
      return { ok: true, summary: JSON.stringify(compactTransaction(transaction, true)) };
    },
  };
}

export function createPreviewUndoTransactionTool(
  deps: TransactionToolDependencies,
): ToolDef<z.infer<typeof previewUndoTransactionSchema>> {
  return {
    name: "previewUndoTransaction",
    policy: { minimumRole: "owner", effect: "read", reversible: false, mission: "forbidden" },
    description: "Inspect which recorded world changes can be safely undone without mutating the world or journal.",
    inputSchema: previewUndoTransactionSchema,
    handler: async ({ transactionId }) => {
      const denied = requireOwner(deps.actorProvider());
      if (denied) return denied;
      const bot = deps.getBot();
      if (!bot) return toolFailure("the Minecraft world is not connected", "WORLD_UNAVAILABLE", true);
      const result = previewUndoTransaction({ ...deps, bot }, transactionId);
      if (!isSkillResult(result)) {
        return { ok: true, summary: JSON.stringify(result), details: result as unknown as Record<string, unknown> };
      }
      return result;
    },
  };
}

export function createUndoWorldTransactionTool(
  deps: TransactionToolDependencies,
): ToolDef<z.infer<typeof undoWorldTransactionSchema>> {
  return {
    name: "undoWorldTransaction",
    policy: { minimumRole: "owner", effect: "world-change", reversible: false, mission: "forbidden" },
    description:
      "Undo one completed or partial world transaction with live-state conflict checks. External edits are preserved and missing items are reported honestly.",
    inputSchema: undoWorldTransactionSchema,
    handler: async ({ transactionId, storageName }) => {
      const denied = requireOwner(deps.actorProvider());
      if (denied) return denied;
      const bot = deps.getBot();
      if (!bot) return toolFailure("the Minecraft world is not connected", "WORLD_UNAVAILABLE", true);
      return undoWorldTransaction({ ...deps, bot }, {
        transactionId,
        ...(storageName === undefined ? {} : { storageName }),
      });
    },
  };
}

function compactTransaction(
  transaction: WorldTransactionRow | WorldTransactionDetail,
  includeChanges = false,
): Record<string, unknown> {
  const changes = "changes" in transaction ? transaction.changes : [];
  return {
    id: transaction.id,
    tsCreated: transaction.tsCreated,
    tsUpdated: transaction.tsUpdated,
    serverKey: transaction.serverKey,
    dimension: transaction.dimension,
    label: transaction.label,
    kind: transaction.kind,
    status: transaction.status,
    actor: transaction.actor,
    taskPlanId: transaction.taskPlanId,
    constructionJobId: transaction.constructionJobId,
    budgetScope: transaction.budgetScope,
    requestedChangeCount: transaction.requestedChangeCount,
    appliedChangeCount: transaction.appliedChangeCount,
    lastError: transaction.lastError,
    ...(includeChanges
      ? {
        changes: changes.slice(0, 128),
        changesTruncated: changes.length > 128,
      }
      : {}),
  };
}

function requireOwner(actor: ExecutionActor): ToolResult | undefined {
  return actor.role === "owner"
    ? undefined
    : toolFailure("world transaction tools are owner-only", "PERMISSION_DENIED", false);
}

function isSkillResult(value: unknown): value is ToolResult {
  return typeof value === "object" && value !== null && "ok" in value && "summary" in value;
}

function toolFailure(
  summary: string,
  code: ToolResult["code"] = "UNKNOWN",
  recoverable = false,
): ToolResult {
  return { ok: false, summary, code, recoverable };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
