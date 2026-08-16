import type {
  BotRuntimeState,
  EmergencyStopResult,
} from "../runtime/state.js";

export type SmartBotAppPhase =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export type SmartBotErrorCode =
  | "PROFILE_MISSING"
  | "CONFIG_INVALID"
  | "CODEX_AUTH_REQUIRED"
  | "CLAUDE_AUTH_REQUIRED"
  | "OPENROUTER_AUTH_REQUIRED"
  | "INSTANCE_LOCKED"
  | "START_FAILED"
  | "STOP_FAILED"
  | "NOT_RUNNING"
  | "MAP_UNAVAILABLE"
  | "INVALID_INPUT";

export interface SmartBotPublicError {
  code: SmartBotErrorCode;
  message: string;
  recoverable: boolean;
}

export interface SmartBotControls {
  canStart: boolean;
  canStop: boolean;
  canEmergencyStop: boolean;
  canRequestAgent: boolean;
}

export interface SmartBotAppSnapshot {
  revision: number;
  observedAt: number;
  phase: SmartBotAppPhase;
  connectionStatus: string;
  reconnectAttempts: number;
  runtime: BotRuntimeState;
  dashboardUrl: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  lastError: SmartBotPublicError | null;
  controls: SmartBotControls;
}

export type AppLogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface AppLogEntry {
  id: number;
  ts: number;
  level: AppLogLevel;
  component: string;
  message: string;
  context: Record<string, unknown>;
}

/** Device-code details surfaced to the desktop during Microsoft sign-in. */
export interface MicrosoftAuthPrompt {
  verificationUri: string;
  userCode: string;
  expiresAt: number;
}

export interface RuntimeSessionSnapshot {
  connectionStatus: string;
  reconnectAttempts: number;
  runtime: BotRuntimeState;
  dashboardUrl: string | null;
}

export type AppJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AppJsonValue[]
  | { readonly [key: string]: AppJsonValue };

export interface MissionErrorDTO {
  stepId: string | null;
  code: string;
  message: string;
  details?: { readonly [key: string]: AppJsonValue };
}

export interface MissionSummaryDTO {
  id: number;
  name: string;
  schema: string;
  sourceHash: string;
  creatorUsername: string;
  enabled: boolean;
  tsCreated: number;
  tsUpdated: number;
}

export interface MissionDTO extends MissionSummaryDTO {
  sourceJson: string;
  definition: { readonly [key: string]: AppJsonValue };
}

export interface MissionRunSummaryDTO {
  id: number;
  definitionId: number | null;
  taskPlanId: number | null;
  sourceHash: string;
  actorUsername: string;
  status: string;
  deadlineAt: number;
  tsCreated: number;
  tsUpdated: number;
  tsStarted: number | null;
  tsFinished: number | null;
  lastError: string | null;
}

export interface MissionStepLinkDTO {
  logicalStepId: string;
  logicalPosition: number;
  expandedStartPosition: number;
  expandedStepCount: number;
  constructionJobId: number | null;
}

export interface MissionRunDTO extends MissionRunSummaryDTO {
  sourceJson: string;
  compileReport: { readonly [key: string]: AppJsonValue };
  transactionScope: string;
  stepLinks: readonly MissionStepLinkDTO[];
}

export interface MissionPreviewDTO {
  name: string;
  logicalStepCount: number;
  expandedStepCount: number;
  requiredRole: string;
  estimatedWorldChanges: number;
  runtimeMinutes: number;
  warnings: readonly string[];
  report: { readonly [key: string]: AppJsonValue };
  buildSites: readonly {
    stepId: string;
    available: boolean;
    safe?: boolean;
    reason?: string;
    correctWorldCells?: number;
    pendingWorldCells?: number;
    issueCounts?: { readonly [key: string]: number };
    issues?: readonly { readonly [key: string]: AppJsonValue }[];
  }[];
}

export interface MissionValidationDTO {
  valid: boolean;
  errors: readonly MissionErrorDTO[];
  preview?: MissionPreviewDTO;
}

export interface WorldTransactionSummaryDTO {
  id: number;
  tsCreated: number;
  tsUpdated: number;
  serverKey: string;
  dimension: string;
  label: string | null;
  kind: string;
  status: string;
  actorUsername: string;
  taskPlanId: number | null;
  constructionJobId: number | null;
  requestedChangeCount: number;
  appliedChangeCount: number;
  lastError: string | null;
}

export interface WorldTransactionDTO extends WorldTransactionSummaryDTO {
  changes: readonly {
    id: number;
    ordinal: number;
    action: string;
    position: { x: number; y: number; z: number };
    before: { readonly [key: string]: AppJsonValue };
    intended: { readonly [key: string]: AppJsonValue };
    confirmedAfter: { readonly [key: string]: AppJsonValue } | null;
    status: string;
    lastError: string | null;
  }[];
  changesTruncated: boolean;
}

export interface UndoPreviewDTO {
  transactionId: number;
  transactionStatus: string;
  readyCount: number;
  alreadyRevertedCount: number;
  conflictCount: number;
  unavailableCount: number;
  unsupportedCount: number;
  ignoredCount: number;
  truncated: boolean;
  changes: readonly {
    changeId: number;
    ordinal: number;
    action: string;
    position: { x: number; y: number; z: number };
    disposition: string;
    requiredItem?: string;
    summary: string;
  }[];
}

export interface MissionRunInput {
  definitionId?: number;
  definition?: { readonly [key: string]: AppJsonValue };
}

export interface MissionSaveInput {
  definition: { readonly [key: string]: AppJsonValue };
  replace?: boolean;
  enabled?: boolean;
}

export interface MissionRunManageInput {
  runId: number;
  action: "pause" | "resume" | "cancel";
}

export interface TransactionListInput {
  dimension?: string;
  status?: string;
  limit?: number;
}

export interface RuntimeReadSession {
  listMissions(input?: { enabled?: boolean; limit?: number }): MissionSummaryDTO[];
  getMission(id: number): MissionDTO | undefined;
  listMissionRuns(input?: { definitionId?: number; taskPlanId?: number; status?: string; limit?: number }): MissionRunSummaryDTO[];
  getMissionRun(id: number): MissionRunDTO | undefined;
  listWorldTransactions(input?: TransactionListInput): WorldTransactionSummaryDTO[];
  getWorldTransaction(id: number): WorldTransactionDTO | undefined;
  close?(): Promise<void> | void;
}

export interface RuntimeSession extends RuntimeReadSession {
  start(): void;
  stop(reason?: string): Promise<void>;
  emergencyStop(source?: string): EmergencyStopResult | null;
  requestAgent(text: string, source?: "cli" | "desktop"): void;
  sendPublicChat(text: string): void;
  runCommand(command: string): void;
  snapshot(): RuntimeSessionSnapshot;
  validateMission(definition: { readonly [key: string]: AppJsonValue }): MissionValidationDTO;
  previewMission(definition: { readonly [key: string]: AppJsonValue }): MissionValidationDTO;
  saveMission(input: MissionSaveInput): MissionDTO;
  runMission(input: MissionRunInput): MissionRunDTO;
  manageMissionRun(input: MissionRunManageInput): MissionRunDTO;
  previewUndoTransaction(transactionId: number): UndoPreviewDTO;
  undoWorldTransaction(input: { transactionId: number; storageName?: string }): Promise<Record<string, AppJsonValue>>;
}

export interface SmartBotApp {
  start(): Promise<SmartBotAppSnapshot>;
  stop(reason?: string): Promise<SmartBotAppSnapshot>;
  emergencyStop(reason?: string): Promise<SmartBotAppSnapshot>;
  /** Trimmed 1–4000 character instructions; newlines are allowed, NUL is not. */
  requestAgent(text: string, source?: "cli" | "desktop"): void;
  /** Trimmed 1–256 character single-line chat; CR/LF and NUL are rejected. */
  sendPublicChat(text: string): void;
  /** Trimmed 1–256 character command without a leading slash or newlines. */
  runCommand(command: string): void;
  snapshot(): SmartBotAppSnapshot;
  logs(afterId?: number): AppLogEntry[];
  subscribe(listener: (snapshot: SmartBotAppSnapshot) => void): () => void;
  subscribeLogs(listener: (entry: AppLogEntry) => void): () => void;
  listMissions(input?: { enabled?: boolean; limit?: number }): Promise<MissionSummaryDTO[]>;
  getMission(id: number): Promise<MissionDTO | undefined>;
  listMissionRuns(input?: { definitionId?: number; taskPlanId?: number; status?: string; limit?: number }): Promise<MissionRunSummaryDTO[]>;
  getMissionRun(id: number): Promise<MissionRunDTO | undefined>;
  listWorldTransactions(input?: TransactionListInput): Promise<WorldTransactionSummaryDTO[]>;
  getWorldTransaction(id: number): Promise<WorldTransactionDTO | undefined>;
  validateMission(definition: { readonly [key: string]: AppJsonValue }): Promise<MissionValidationDTO>;
  previewMission(definition: { readonly [key: string]: AppJsonValue }): Promise<MissionValidationDTO>;
  saveMission(input: MissionSaveInput): Promise<MissionDTO>;
  runMission(input: MissionRunInput): Promise<MissionRunDTO>;
  manageMissionRun(input: MissionRunManageInput): Promise<MissionRunDTO>;
  previewUndoTransaction(transactionId: number): Promise<UndoPreviewDTO>;
  undoWorldTransaction(input: { transactionId: number; storageName?: string }): Promise<Record<string, AppJsonValue>>;
}
