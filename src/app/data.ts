import type {
  AppJsonValue,
  MissionDTO,
  MissionErrorDTO,
  MissionPreviewDTO,
  MissionRunDTO,
  MissionRunSummaryDTO,
  MissionStepLinkDTO,
  MissionSummaryDTO,
  MissionValidationDTO,
  UndoPreviewDTO,
  WorldTransactionDTO,
  WorldTransactionSummaryDTO,
} from "./contracts.js";
import type { MissionPreview, MissionPreviewResult } from "../missions/service.js";
import type {
  MissionCompileError,
  MissionCompileResult,
} from "../missions/compiler.js";
import type {
  MissionDefinitionDetail,
  MissionDefinitionSummary,
  MissionRunDetail,
  MissionRunSummary,
} from "../missions/types.js";
import type {
  WorldTransactionDetail,
  WorldTransactionRow,
} from "../world/transactions/types.js";
import type { UndoPreview } from "../skills/world/undoTransaction.js";

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_ERRORS = 32;
const MAX_ISSUES = 32;
const MAX_CHANGES = 128;

export function missionSummary(row: MissionDefinitionSummary): MissionSummaryDTO {
  return {
    id: row.id,
    name: row.name,
    schema: row.schema,
    sourceHash: row.sourceHash,
    creatorUsername: row.creator.username,
    enabled: row.enabled,
    tsCreated: row.tsCreated,
    tsUpdated: row.tsUpdated,
  };
}

export function missionDetail(row: MissionDefinitionDetail): MissionDTO {
  return {
    ...missionSummary(row),
    sourceJson: boundedSource(row.sourceJson),
    definition: toJsonRecord(row.definition),
  };
}

export function missionRunSummary(row: MissionRunSummary): MissionRunSummaryDTO {
  return {
    id: row.id,
    definitionId: row.definitionId,
    taskPlanId: row.taskPlanId,
    sourceHash: row.sourceHash,
    actorUsername: row.actor.username,
    status: row.status,
    deadlineAt: row.deadlineAt,
    tsCreated: row.tsCreated,
    tsUpdated: row.tsUpdated,
    tsStarted: row.tsStarted,
    tsFinished: row.tsFinished,
    lastError: boundedText(row.lastError),
  };
}

export function missionRunDetail(row: MissionRunDetail): MissionRunDTO {
  const links: MissionStepLinkDTO[] = row.stepLinks.slice(0, 32).map((link) => ({
    logicalStepId: link.logicalStepId,
    logicalPosition: link.logicalPosition,
    expandedStartPosition: link.expandedStartPosition,
    expandedStepCount: link.expandedStepCount,
    constructionJobId: link.constructionJobId,
  }));
  return {
    ...missionRunSummary(row),
    sourceJson: boundedSource(row.sourceJson),
    compileReport: toJsonRecord(row.compileReport),
    transactionScope: boundedText(row.transactionScope) ?? "",
    stepLinks: links,
  };
}

export function missionValidation(
  result: MissionPreviewResult | MissionCompileResult,
  mode: "validate" | "preview",
): MissionValidationDTO {
  if (!result.ok) {
    return {
      valid: false,
      errors: result.errors.slice(0, MAX_ERRORS).map(compileError),
    };
  }
  return {
    valid: true,
    errors: [],
    ...(mode === "preview" ? { preview: missionPreview(result.value as MissionPreview) } : {}),
  };
}

export function missionPreview(value: MissionPreview): MissionPreviewDTO {
  const report = value.compilation.report;
  return {
    name: report.name,
    logicalStepCount: report.logicalStepCount,
    expandedStepCount: report.expandedStepCount,
    requiredRole: report.requiredRole,
    estimatedWorldChanges: report.estimatedWorldChanges,
    runtimeMinutes: report.maxRuntimeMinutes,
    warnings: report.warnings.slice(0, MAX_ERRORS).map((warning) => `${warning.stepId}: ${warning.message}`),
    report: toJsonRecord(report),
    buildSites: value.buildSites.slice(0, 32).map((site) => ({
      stepId: site.stepId,
      available: site.available,
      ...(site.safe === undefined ? {} : { safe: site.safe }),
      ...(site.reason === undefined ? {} : { reason: boundedText(site.reason) ?? "" }),
      ...(site.correctWorldCells === undefined ? {} : { correctWorldCells: site.correctWorldCells }),
      ...(site.pendingWorldCells === undefined ? {} : { pendingWorldCells: site.pendingWorldCells }),
      ...(site.issueCounts === undefined ? {} : { issueCounts: { ...site.issueCounts } }),
      ...(site.issues === undefined ? {} : {
        issues: site.issues.slice(0, MAX_ISSUES).map((issue) => toJsonRecord(issue)),
      }),
    })),
  };
}

export function transactionSummary(row: WorldTransactionRow): WorldTransactionSummaryDTO {
  return {
    id: row.id,
    tsCreated: row.tsCreated,
    tsUpdated: row.tsUpdated,
    serverKey: row.serverKey,
    dimension: row.dimension,
    label: boundedText(row.label),
    kind: row.kind,
    status: row.status,
    actorUsername: row.actor.username,
    taskPlanId: row.taskPlanId,
    constructionJobId: row.constructionJobId,
    requestedChangeCount: row.requestedChangeCount,
    appliedChangeCount: row.appliedChangeCount,
    lastError: boundedText(row.lastError),
  };
}

export function transactionDetail(row: WorldTransactionDetail): WorldTransactionDTO {
  return {
    ...transactionSummary(row),
    changes: row.changes.slice(0, MAX_CHANGES).map((change) => ({
      id: change.id,
      ordinal: change.ordinal,
      action: change.action,
      position: { ...change.position },
      before: toJsonRecord(change.before),
      intended: toJsonRecord(change.intended),
      confirmedAfter: change.confirmedAfter === null ? null : toJsonRecord(change.confirmedAfter),
      status: change.status,
      lastError: boundedText(change.lastError),
    })),
    changesTruncated: row.changes.length > MAX_CHANGES,
  };
}

export function undoPreview(value: UndoPreview): UndoPreviewDTO {
  return {
    transactionId: value.transactionId,
    transactionStatus: value.transactionStatus,
    readyCount: value.readyCount,
    alreadyRevertedCount: value.alreadyRevertedCount,
    conflictCount: value.conflictCount,
    unavailableCount: value.unavailableCount,
    unsupportedCount: value.unsupportedCount,
    ignoredCount: value.ignoredCount,
    truncated: value.truncated,
    changes: value.changes.slice(0, MAX_CHANGES).map((change) => ({
      changeId: change.changeId,
      ordinal: change.ordinal,
      action: change.action,
      position: { ...change.position },
      disposition: change.disposition,
      ...(change.requiredItem === undefined ? {} : { requiredItem: change.requiredItem }),
      summary: boundedText(change.summary) ?? "",
    })),
  };
}

export function toJsonRecord(value: unknown): { readonly [key: string]: AppJsonValue } {
  const parsed = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isRecord(parsed)) return {};
  return parsed as { readonly [key: string]: AppJsonValue };
}

function compileError(error: MissionCompileError): MissionErrorDTO {
  return {
    stepId: error.stepId,
    code: error.code,
    message: boundedText(error.message) ?? "mission validation failed",
    ...(error.details === undefined ? {} : { details: toJsonRecord(error.details) }),
  };
}

function boundedSource(source: string): string {
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength <= MAX_SOURCE_BYTES) return source;
  return `${new TextDecoder().decode(bytes.slice(0, MAX_SOURCE_BYTES - 1))}…`;
}

function boundedText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.length <= 512 ? value : `${value.slice(0, 511)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
