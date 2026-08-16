import { join } from "node:path";
import type { RuntimeProfile } from "./profile.js";
import type {
  AppLogEntry,
  MissionDTO,
  MissionRunDTO,
  MissionRunSummaryDTO,
  MissionSaveInput,
  MissionSummaryDTO,
  MissionValidationDTO,
  MicrosoftAuthPrompt,
  RuntimeSession,
  RuntimeSessionSnapshot,
  TransactionListInput,
  UndoPreviewDTO,
  WorldTransactionDTO,
  WorldTransactionSummaryDTO,
} from "./contracts.js";
import {
  missionDetail,
  missionRunDetail,
  missionRunSummary,
  missionSummary,
  transactionDetail,
  transactionSummary,
} from "./data.js";
import {
  acquireInstanceLock,
  type InstanceLock,
} from "../runtime/instanceLock.js";
import {
  createLogger,
  type CreateLoggerOptions,
  type Logger,
} from "../util/logger.js";
import {
  verifyAgentSubscriptionAuth,
  type AgentSubscriptionAuthOptions,
  type ResolvedAgentProvider,
} from "../agent/auth.js";
import { openDatabase, type DB } from "../memory/db.js";
import { reconcileInterruptedSkillRuns } from "../memory/skillRuns.js";
import {
  getTransaction,
  listTransactions,
  reconcileOpenTransactions,
} from "../world/transactions/store.js";
import {
  getMissionDefinition,
  getMissionRun,
  listMissionDefinitions,
  listMissionRuns,
} from "../missions/store.js";
import type { MissionRunStatus } from "../missions/types.js";
import { pruneOldRecords } from "../memory/retention.js";
import { removePlayerRole } from "../permissions/roles.js";
import {
  adoptLegacyWorldMap,
  makeServerKey,
} from "../exploration/mapStore.js";
import {
  createReconnectSupervisor,
  type ReconnectSupervisor,
} from "../runtime/reconnect.js";
import {
  createConnectionRuntime,
  type ConnectionRuntime,
} from "../runtime/connection.js";
import {
  createDashboardServer,
  type DashboardServer,
} from "../dashboard/server.js";
import { disconnectedRuntimeState } from "../runtime/state.js";

export interface RuntimeAssetPaths {
  schemaPath?: string;
  dashboardHtmlPath?: string;
}

export interface RuntimeSessionDependencies {
  acquireInstanceLock: typeof acquireInstanceLock;
  createLogger: (options: CreateLoggerOptions) => Logger;
  verifyAgentSubscriptionAuth: (
    options: AgentSubscriptionAuthOptions,
  ) => Promise<ResolvedAgentProvider>;
  openDatabase: typeof openDatabase;
  reconcileInterruptedSkillRuns: typeof reconcileInterruptedSkillRuns;
  reconcileOpenTransactions: typeof reconcileOpenTransactions;
  pruneOldRecords: typeof pruneOldRecords;
  adoptLegacyWorldMap: typeof adoptLegacyWorldMap;
  removePlayerRole: typeof removePlayerRole;
  makeServerKey: typeof makeServerKey;
  createReconnectSupervisor: typeof createReconnectSupervisor;
  createConnectionRuntime: typeof createConnectionRuntime;
  createDashboardServer: typeof createDashboardServer;
  now: () => number;
}

export interface OpenRuntimeSessionOptions {
  profile: RuntimeProfile;
  onLog?: (entry: Omit<AppLogEntry, "id">) => void;
  onMicrosoftAuth?: (prompt: MicrosoftAuthPrompt) => void;
  prettyLogs?: boolean;
  assets?: RuntimeAssetPaths;
  dependencies?: Partial<RuntimeSessionDependencies>;
}

export const defaultRuntimeSessionDependencies: RuntimeSessionDependencies = {
  acquireInstanceLock,
  createLogger,
  verifyAgentSubscriptionAuth,
  openDatabase,
  reconcileInterruptedSkillRuns,
  reconcileOpenTransactions,
  pruneOldRecords,
  adoptLegacyWorldMap,
  removePlayerRole,
  makeServerKey,
  createReconnectSupervisor,
  createConnectionRuntime,
  createDashboardServer,
  now: Date.now,
};

export async function openRuntimeSession(
  options: OpenRuntimeSessionOptions,
): Promise<RuntimeSession> {
  const deps = {
    ...defaultRuntimeSessionDependencies,
    ...options.dependencies,
  };
  const { profile } = options;
  const cfg = profile.config;
  let lock: InstanceLock | null = null;
  let log: Logger | null = null;
  let db: DB | null = null;
  let supervisor: ReconnectSupervisor | null = null;
  let dashboard: DashboardServer | null = null;
  let resolvedAgent: ResolvedAgentProvider | null = null;
  let configuredServerKey: string | null = null;

  try {
    lock = deps.acquireInstanceLock(cfg.dataDir);
    log = deps.createLogger({
      level: cfg.logLevel,
      pretty: options.prettyLogs ?? false,
      onRecord: options.onLog,
    });
    log.info(
      {
        owner: cfg.ownerUsername,
        server: `${cfg.serverHost}:${cfg.serverPort}`,
        agentProvider: cfg.agentProvider,
      },
      "starting SmartBotMC",
    );
    resolvedAgent = await deps.verifyAgentSubscriptionAuth({
      provider: cfg.agentProvider,
      claude: { configuredPath: cfg.claudeCodeExecutable },
      codex: { configuredPath: cfg.codexExecutable },
      ...(cfg.agentProvider === "openrouter"
        ? {
            openrouter: {
              apiKey: cfg.agentApiKey,
              model: cfg.agentModel,
              baseUrl: cfg.agentBaseUrl,
              httpReferer: cfg.openrouterHttpReferer,
            },
          }
        : {}),
    });
    db = deps.openDatabase(
      join(cfg.dataDir, "memory.sqlite"),
      { schemaPath: options.assets?.schemaPath },
    );
    const interruptedRuns = deps.reconcileInterruptedSkillRuns(db);
    if (interruptedRuns > 0) {
      log.warn(
        { reconciled: interruptedRuns },
        "finalized skill runs interrupted by the prior process",
      );
    }
    const reconciledTransactions = deps.reconcileOpenTransactions(db);
    if (reconciledTransactions > 0) {
      log.warn(
        { reconciled: reconciledTransactions },
        "finalized stale world transactions from the prior process",
      );
    }
    const serverKey = deps.makeServerKey(cfg.serverHost, cfg.serverPort);
    configuredServerKey = serverKey;
    const adoptedMapRecords = deps.adoptLegacyWorldMap(db, serverKey);
    if (adoptedMapRecords > 0) {
      log.info(
        { serverKey, observations: adoptedMapRecords },
        "attached pre-server map history to configured server",
      );
    }
    if (deps.removePlayerRole(db, cfg.ownerUsername)) {
      log.info(
        { owner: cfg.ownerUsername },
        "removed stale assigned role for configured owner",
      );
    }
    deps.pruneOldRecords(db);

    supervisor = deps.createReconnectSupervisor({
      log: log.child({ component: "reconnect" }),
      connect: (hooks) => deps.createConnectionRuntime({
        cfg,
        serverConfig: profile.serverConfig,
        db: db!,
        log: log!,
        hooks,
        claudeCodeExecutable: resolvedAgent?.provider === "anthropic"
          ? resolvedAgent.executable
          : undefined,
        codexExecutable: resolvedAgent?.provider === "codex"
          ? resolvedAgent.executable
          : undefined,
        agentApiKey: resolvedAgent?.provider === "openrouter"
          ? resolvedAgent.apiKey
          : undefined,
        agentModel: resolvedAgent?.provider === "openrouter"
          ? resolvedAgent.model
          : undefined,
        agentBaseUrl: resolvedAgent?.provider === "openrouter"
          ? resolvedAgent.baseUrl
          : undefined,
        agentHttpReferer: resolvedAgent?.provider === "openrouter"
          ? resolvedAgent.httpReferer
          : undefined,
        workingDirectory: profile.rootDir,
        onMicrosoftAuth: options.onMicrosoftAuth,
      }),
      baseDelayMs: cfg.reconnectBaseDelayMs,
      maxDelayMs: cfg.reconnectMaxDelayMs,
      jitterRatio: cfg.reconnectJitterRatio,
    });
    dashboard = deps.createDashboardServer({
      db,
      log: log.child({ component: "dashboard" }),
      host: cfg.dashboardHost,
      port: cfg.dashboardPort,
      enabled: cfg.dashboardEnabled,
      htmlPath: options.assets?.dashboardHtmlPath,
      currentServerKey: serverKey,
      currentServerLabel: profile.serverConfig.name || serverKey,
      ownerUsername: cfg.ownerUsername,
      getConnectionStatus: () => supervisor!.current()?.getStatus()
        ?? `disconnected reconnect_attempt=${supervisor!.attempts()}`,
      getRuntimeState: () => supervisor!.current()?.getLiveState()
        ?? disconnectedRuntimeState(
          `disconnected reconnect_attempt=${supervisor!.attempts()}`,
        ),
    });
    await dashboard.start();
  } catch (error) {
    await rollbackStartup({ log, supervisor, dashboard, db, lock });
    throw error;
  }

  const activeLog = log!;
  const activeDb = db!;
  const activeSupervisor = supervisor!;
  const activeDashboard = dashboard!;
  let started = false;
  let stopPromise: Promise<void> | null = null;

  const currentRuntime = (): ConnectionRuntime => {
    const runtime = activeSupervisor.current();
    if (!runtime) throw new Error("runtime is not connected");
    return runtime;
  };

  const session: RuntimeSession = {
    start: () => {
      if (started) return;
      started = true;
      activeSupervisor.start();
    },
    stop: (reason = "shutdown") => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const failures: unknown[] = [];
        try {
          activeSupervisor.stop(reason);
        } catch (error) {
          failures.push(error);
        }
        try {
          await activeDashboard.stop();
        } catch (error) {
          failures.push(error);
        }
        try {
          activeDb.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          lock?.release();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "runtime session cleanup failed");
        }
      })();
      return stopPromise;
    },
    emergencyStop: (source = "unknown") =>
      activeSupervisor.current()?.emergencyStop(source) ?? null,
    requestAgent: (text, source) => currentRuntime().requestAgent(text, source),
    sendPublicChat: (text) => currentRuntime().sendPublicChat(text),
    runCommand: (command) => currentRuntime().runCommand(command),
    snapshot: (): RuntimeSessionSnapshot => {
      const runtime = activeSupervisor.current();
      return {
        connectionStatus: runtime?.getStatus()
          ?? `disconnected reconnect_attempt=${activeSupervisor.attempts()}`,
        reconnectAttempts: activeSupervisor.attempts(),
        runtime: runtime?.getLiveState()
          ?? disconnectedRuntimeState(
            `disconnected reconnect_attempt=${activeSupervisor.attempts()}`,
          ),
        dashboardUrl: activeDashboard.url() ?? null,
      };
    },
    listMissions: (input) => listMissionDefinitions(activeDb, input).map(missionSummary),
    getMission: (id) => {
      const result = getMissionDefinition(activeDb, id);
      return result ? missionDetail(result) : undefined;
    },
    listMissionRuns: (input) => listMissionRuns(activeDb, input === undefined ? undefined : {
      ...(input.definitionId === undefined ? {} : { definitionId: input.definitionId }),
      ...(input.taskPlanId === undefined ? {} : { taskPlanId: input.taskPlanId }),
      ...(input.status === undefined ? {} : { status: input.status as MissionRunStatus }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }).map(missionRunSummary),
    getMissionRun: (id) => {
      const result = getMissionRun(activeDb, id);
      return result ? missionRunDetail(result) : undefined;
    },
    listWorldTransactions: (input?: TransactionListInput) => listTransactions(activeDb, {
      serverKey: configuredServerKey!,
      ...(input?.dimension === undefined ? {} : { dimension: input.dimension }),
      ...(input?.status === undefined ? {} : { status: input.status as never }),
      ...(input?.limit === undefined ? {} : { limit: input.limit }),
    }).map(transactionSummary),
    getWorldTransaction: (id) => {
      const result = getTransaction(activeDb, id);
      return result ? transactionDetail(result) : undefined;
    },
    validateMission: (definition) => currentRuntime().validateMission(definition),
    previewMission: (definition) => currentRuntime().previewMission(definition),
    saveMission: (input) => currentRuntime().saveMission(input),
    runMission: (input) => currentRuntime().runMission(input),
    manageMissionRun: (input) => currentRuntime().manageMissionRun(input),
    previewUndoTransaction: (id) => currentRuntime().previewUndoTransaction(id),
    undoWorldTransaction: (input) => currentRuntime().undoWorldTransaction(input),
  };

  activeLog.debug({ dataDir: cfg.dataDir }, "runtime session ready");
  return session;
}

async function rollbackStartup(resources: {
  log: Logger | null;
  supervisor: ReconnectSupervisor | null;
  dashboard: DashboardServer | null;
  db: DB | null;
  lock: InstanceLock | null;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    resources.supervisor?.stop("startup failed");
  } catch (error) {
    failures.push(error);
  }
  try {
    await resources.dashboard?.stop();
  } catch (error) {
    failures.push(error);
  }
  try {
    resources.db?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    resources.lock?.release();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    try {
      resources.log?.error({ failures: failures.length }, "runtime startup rollback encountered cleanup errors");
    } catch {
      // The original startup error remains the useful failure signal.
    }
  }
}
