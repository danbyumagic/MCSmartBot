import type {
  AppLogBuffer,
} from "./logBuffer.js";
import type {
  RuntimeSession,
  RuntimeReadSession,
  RuntimeSessionSnapshot,
  SmartBotApp,
  SmartBotAppPhase,
  SmartBotAppSnapshot,
  SmartBotControls,
  SmartBotErrorCode,
  SmartBotPublicError,
  MissionDTO,
  MissionRunDTO,
  MissionRunSummaryDTO,
  MissionSaveInput,
  MissionSummaryDTO,
  MissionValidationDTO,
  TransactionListInput,
  UndoPreviewDTO,
  WorldTransactionDTO,
  WorldTransactionSummaryDTO,
} from "./contracts.js";
import { disconnectedRuntimeState } from "../runtime/state.js";

const DEFAULT_POLL_INTERVAL_MS = 750;
const MAX_AGENT_INPUT_LENGTH = 4_000;
const MAX_CHAT_INPUT_LENGTH = 256;
const MAX_COMMAND_INPUT_LENGTH = 256;

export interface SmartBotAppDependencies {
  openSession(): Promise<RuntimeSession>;
  /** Optional read-only profile adapter used for stopped desktop reads. */
  openReadOnlySession?: () => Promise<RuntimeReadSession>;
  logBuffer: AppLogBuffer;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  pollIntervalMs?: number;
}

/** A renderer-safe error returned by the app boundary. */
export class SmartBotControlError extends Error {
  readonly code: SmartBotErrorCode;
  readonly recoverable: boolean;

  constructor(
    code: SmartBotErrorCode,
    message: string,
    recoverable = true,
  ) {
    super(message);
    this.name = "SmartBotControlError";
    this.code = code;
    this.recoverable = recoverable;
  }

  toPublic(): SmartBotPublicError {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
    };
  }
}

interface PendingStop {
  reason: string;
  mode: "graceful" | "emergency";
}

interface MutableState {
  phase: SmartBotAppPhase;
  connectionStatus: string;
  reconnectAttempts: number;
  runtime: SmartBotAppSnapshot["runtime"];
  dashboardUrl: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  lastError: SmartBotPublicError | null;
}

export function createSmartBotApp(
  deps: SmartBotAppDependencies,
): SmartBotApp {
  const now = deps.now ?? Date.now;
  const startInterval = deps.setInterval ?? globalThis.setInterval;
  const clearInterval = deps.clearInterval ?? globalThis.clearInterval;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const subscribers = new Set<(snapshot: SmartBotAppSnapshot) => void>();

  let state: MutableState = {
    phase: "stopped",
    connectionStatus: "disconnected",
    reconnectAttempts: 0,
    runtime: disconnectedRuntimeState("disconnected"),
    dashboardUrl: null,
    startedAt: null,
    stoppedAt: null,
    lastError: null,
  };
  let revision = 0;
  let observedAt = now();
  let session: RuntimeSession | null = null;
  let startPromise: Promise<SmartBotAppSnapshot> | null = null;
  let teardownPromise: Promise<SmartBotAppSnapshot> | null = null;
  let pendingStartStop: PendingStop | null = null;
  let emergencyInvoked = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let pollFailureLogged = false;
  let emittedPayload = comparableState(state, controlsFor(state.phase, false));
  let currentSnapshot = makeSnapshot();

  function makeSnapshot(): SmartBotAppSnapshot {
    const controls = controlsFor(
      state.phase,
      pendingStartStop !== null,
      state.runtime.connection,
    );
    return clone({
      revision,
      observedAt,
      phase: state.phase,
      connectionStatus: state.connectionStatus,
      reconnectAttempts: state.reconnectAttempts,
      runtime: state.runtime,
      dashboardUrl: state.dashboardUrl,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      lastError: state.lastError,
      controls,
    });
  }

  function emit(): SmartBotAppSnapshot {
    const controls = controlsFor(
      state.phase,
      pendingStartStop !== null,
      state.runtime.connection,
    );
    const payload = comparableState(state, controls);
    if (deepEqual(payload, emittedPayload)) return clone(currentSnapshot);

    emittedPayload = clone(payload);
    revision += 1;
    observedAt = now();
    currentSnapshot = makeSnapshot();
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(clone(currentSnapshot));
      } catch {
        // A renderer subscriber must not interrupt lifecycle transitions.
      }
    }
    return clone(currentSnapshot);
  }

  function updateState(patch: Partial<MutableState>): SmartBotAppSnapshot {
    state = {
      ...state,
      ...patch,
      runtime: patch.runtime === undefined ? state.runtime : clone(patch.runtime),
      lastError: patch.lastError === undefined
        ? state.lastError
        : clone(patch.lastError),
    };
    return emit();
  }

  function clearPolling(resetFailure = true): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    polling = false;
    if (resetFailure) pollFailureLogged = false;
  }

  function logPollFailure(error: unknown): void {
    if (pollFailureLogged) return;
    pollFailureLogged = true;
    try {
      deps.logBuffer.append({
        ts: now(),
        level: "warn",
        component: "controller",
        message: "runtime snapshot failed",
        context: { error: safeErrorSummary(error) },
      });
    } catch {
      // Logging must not become a lifecycle failure.
    }
  }

  function applyRuntimeSnapshot(snapshot: RuntimeSessionSnapshot): void {
    pollFailureLogged = false;
    updateState(runtimeStatePatch(snapshot));
  }

  function runtimeStatePatch(snapshot: RuntimeSessionSnapshot): Partial<MutableState> {
    return {
      connectionStatus: sanitizeConnectionStatus(snapshot.connectionStatus),
      reconnectAttempts: safeAttemptCount(snapshot.reconnectAttempts),
      runtime: snapshot.runtime,
      dashboardUrl: snapshot.dashboardUrl === null
        ? null
        : sanitizeDashboardUrl(snapshot.dashboardUrl),
    };
  }

  function captureRuntimeSnapshot(): RuntimeSessionSnapshot | null {
    if (!session) return null;
    try {
      const snapshot = session.snapshot();
      pollFailureLogged = false;
      return snapshot;
    } catch (error) {
      logPollFailure(error);
      return null;
    }
  }

  function pollOnce(): void {
    if (polling || !session || state.phase !== "running") return;
    polling = true;
    try {
      const snapshot = captureRuntimeSnapshot();
      if (snapshot) applyRuntimeSnapshot(snapshot);
    } finally {
      polling = false;
    }
  }

  function beginPolling(): void {
    clearPolling(false);
    pollTimer = startInterval(() => {
      try {
        pollOnce();
      } catch (error) {
        // The poll wrapper is intentionally defensive even though pollOnce
        // already catches session snapshot failures.
        logPollFailure(error);
      }
    }, pollIntervalMs);
  }

  function invokeEmergency(reason: string): void {
    if (emergencyInvoked || !session) return;
    emergencyInvoked = true;
    try {
      session.emergencyStop(reason);
    } catch (error) {
      try {
        deps.logBuffer.append({
          ts: now(),
          level: "error",
          component: "controller",
          message: "emergency stop primitive failed",
          context: { error: safeErrorSummary(error) },
        });
      } catch {
        // Preserve the teardown path if observability itself fails.
      }
    }
  }

  async function performTeardown(
    reason: string,
    mode: "graceful" | "emergency",
  ): Promise<SmartBotAppSnapshot> {
    clearPolling();
    if (mode === "emergency") invokeEmergency(reason);
    const activeSession = session;

    if (!activeSession) {
      pendingStartStop = null;
      return updateState({
        phase: "stopped",
        connectionStatus: "disconnected",
        reconnectAttempts: 0,
        runtime: disconnectedRuntimeState("disconnected"),
        dashboardUrl: null,
        stoppedAt: now(),
      });
    }

    updateState({ phase: "stopping" });
    let cleanupError: unknown = null;
    try {
      await activeSession.stop(reason);
    } catch (error) {
      cleanupError = error;
    } finally {
      if (session === activeSession) session = null;
      emergencyInvoked = false;
      pendingStartStop = null;
    }

    if (cleanupError) {
      const publicError = mapError(cleanupError, "stop");
      return updateState({
        phase: "failed",
        connectionStatus: "disconnected",
        reconnectAttempts: 0,
        runtime: disconnectedRuntimeState("disconnected"),
        dashboardUrl: null,
        stoppedAt: now(),
        lastError: publicError,
      });
    }

    return updateState({
      phase: "stopped",
      connectionStatus: "disconnected",
      reconnectAttempts: 0,
      runtime: disconnectedRuntimeState("disconnected"),
      dashboardUrl: null,
      stoppedAt: now(),
      lastError: null,
    });
  }

  function ensureStartStopPromise(
    reason: string,
    mode: "graceful" | "emergency",
  ): Promise<SmartBotAppSnapshot> {
    if (pendingStartStop) {
      pendingStartStop.reason = reason;
      if (mode === "emergency") pendingStartStop.mode = "emergency";
    } else {
      pendingStartStop = { reason, mode };
    }
    // The pending request makes the starting controls unavailable immediately.
    emit();
    if (teardownPromise) return teardownPromise;
    const attempt = startPromise;
    if (!attempt) return Promise.resolve(currentSnapshotClone());
    const request = attempt.then(
      () => currentSnapshotClone(),
      () => currentSnapshotClone(),
    );
    teardownPromise = request;
    return request;
  }

  async function runStart(): Promise<SmartBotAppSnapshot> {
    let created: RuntimeSession | null = null;
    try {
      created = await deps.openSession();
      session = created;
      emergencyInvoked = false;
      try {
        created.start();
      } catch (error) {
        try {
          await created.stop("startup failed");
        } catch {
          // Preserve the original startup failure classification.
        }
        if (session === created) session = null;
        throw error;
      }

      const pending = pendingStartStop;
      if (pending) {
        pendingStartStop = null;
        if (pending.mode === "emergency") invokeEmergency(pending.reason);
        return await performTeardown(pending.reason, pending.mode);
      }

      const initialRuntime = captureRuntimeSnapshot();
      updateState({
        phase: "running",
        ...(initialRuntime
          ? runtimeStatePatch(initialRuntime)
          : {
              connectionStatus: "disconnected",
              reconnectAttempts: 0,
              runtime: disconnectedRuntimeState("disconnected"),
              dashboardUrl: null,
            }),
        startedAt: now(),
        stoppedAt: null,
        lastError: null,
      });
      beginPolling();
      return currentSnapshotClone();
    } catch (error) {
      clearPolling();
      if (created && session === created) {
        try {
          await created.stop("startup failed");
        } catch {
          // Preserve the original startup failure classification.
        }
      }
      if (created && session === created) session = null;
      pendingStartStop = null;
      const publicError = mapError(error, "start");
      updateState({
        phase: "failed",
        connectionStatus: "disconnected",
        reconnectAttempts: 0,
        runtime: disconnectedRuntimeState("disconnected"),
        dashboardUrl: null,
        stoppedAt: now(),
        lastError: publicError,
      });
      throw new SmartBotControlError(
        publicError.code,
        publicError.message,
        publicError.recoverable,
      );
    }
  }

  function start(): Promise<SmartBotAppSnapshot> {
    if (startPromise) return startPromise;
    if (state.phase === "running") return Promise.resolve(currentSnapshotClone());
    if (state.phase === "stopping") return Promise.resolve(currentSnapshotClone());

    deps.logBuffer.clear();
    teardownPromise = null;
    pendingStartStop = null;
    updateState({
      phase: "starting",
      connectionStatus: "starting",
      reconnectAttempts: 0,
      runtime: disconnectedRuntimeState("starting"),
      dashboardUrl: null,
      startedAt: null,
      stoppedAt: null,
      lastError: null,
    });

    const attempt = runStart();
    startPromise = attempt;
    // Attach a rejection handler so cleanup of the bookkeeping promise can
    // never create an unhandled rejection alongside the caller's promise.
    void attempt.then(
      () => {
        if (startPromise === attempt) startPromise = null;
      },
      () => {
        if (startPromise === attempt) startPromise = null;
      },
    );
    return attempt;
  }

  function stop(reason = "shutdown"): Promise<SmartBotAppSnapshot> {
    if (state.phase === "starting" && startPromise) {
      return ensureStartStopPromise(reason, "graceful");
    }
    if (teardownPromise) return teardownPromise;
    if (!session) {
      clearPolling();
      return Promise.resolve(currentSnapshotClone());
    }
    updateState({ phase: "stopping" });
    const teardown = performTeardown(reason, "graceful");
    teardownPromise = teardown;
    return teardown;
  }

  function emergencyStop(reason = "emergency stop"): Promise<SmartBotAppSnapshot> {
    if (state.phase === "starting" && startPromise) {
      return ensureStartStopPromise(reason, "emergency");
    }
    if (teardownPromise) {
      // Escalation is allowed while graceful cleanup is already in flight.
      if (session) invokeEmergency(reason);
      return teardownPromise;
    }
    if (!session) return Promise.resolve(currentSnapshotClone());

    // This call intentionally happens before constructing/awaiting the
    // teardown promise so cancellation is synchronous from the caller's view.
    invokeEmergency(reason);
    updateState({ phase: "stopping" });
    const teardown = performTeardown(reason, "emergency");
    teardownPromise = teardown;
    return teardown;
  }

  function requireSession(): RuntimeSession {
    if (!session || state.phase !== "running") {
      throw new SmartBotControlError(
        "NOT_RUNNING",
        "SmartBot is not running.",
        true,
      );
    }
    return session;
  }

  function delegate(
    operation: (active: RuntimeSession) => void,
  ): void {
    const active = requireSession();
    try {
      operation(active);
    } catch (error) {
      if (error instanceof SmartBotControlError) throw error;
      throw mapControlError(error);
    }
  }

  async function delegateAsync<T>(
    operation: (active: RuntimeSession) => Promise<T> | T,
  ): Promise<T> {
    const active = requireSession();
    try {
      return await operation(active);
    } catch (error) {
      if (error instanceof SmartBotControlError) throw error;
      throw mapControlError(error);
    }
  }

  async function delegateRead<T>(
    operation: (active: RuntimeReadSession) => Promise<T> | T,
  ): Promise<T> {
    if (session && state.phase === "running") {
      try {
        return await operation(session);
      } catch (error) {
        if (error instanceof SmartBotControlError) throw error;
        throw mapControlError(error);
      }
    }
    if (!deps.openReadOnlySession || (state.phase !== "stopped" && state.phase !== "failed")) {
      throw new SmartBotControlError("NOT_RUNNING", "SmartBot is not running.", true);
    }
    let readonly: RuntimeReadSession | null = null;
    try {
      readonly = await deps.openReadOnlySession();
      return await operation(readonly);
    } catch (error) {
      if (error instanceof SmartBotControlError) throw error;
      throw mapControlError(error);
    } finally {
      try {
        await readonly?.close?.();
      } catch {
        // Read-only cleanup must not hide the requested result.
      }
    }
  }

  function requestAgent(text: string, source?: "cli" | "desktop"): void {
    const normalized = validateAgentInput(text);
    delegate((active) => active.requestAgent(normalized, source));
  }

  function sendPublicChat(text: string): void {
    const normalized = validateChatInput(text);
    delegate((active) => active.sendPublicChat(normalized));
  }

  function runCommand(command: string): void {
    const normalized = validateCommandInput(command);
    delegate((active) => active.runCommand(normalized));
  }

  function currentSnapshotClone(): SmartBotAppSnapshot {
    return clone(currentSnapshot);
  }

  const app: SmartBotApp = {
    start,
    stop,
    emergencyStop,
    requestAgent,
    sendPublicChat,
    runCommand,
    snapshot: currentSnapshotClone,
    logs: (afterId) => deps.logBuffer.entries(afterId),
    subscribe: (listener) => {
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    subscribeLogs: (listener) => deps.logBuffer.subscribe(listener),
    listMissions: (input) => delegateRead((active) => active.listMissions(input)),
    getMission: (id) => delegateRead((active) => active.getMission(id)),
    listMissionRuns: (input) => delegateRead((active) => active.listMissionRuns(input)),
    getMissionRun: (id) => delegateRead((active) => active.getMissionRun(id)),
    listWorldTransactions: (input: TransactionListInput | undefined) =>
      delegateRead((active) => active.listWorldTransactions(input)),
    getWorldTransaction: (id) => delegateRead((active) => active.getWorldTransaction(id)),
    validateMission: (definition) => delegateAsync((active) => active.validateMission(definition)),
    previewMission: (definition) => delegateAsync((active) => active.previewMission(definition)),
    saveMission: (input: MissionSaveInput) => delegateAsync((active) => active.saveMission(input)),
    runMission: (input) => delegateAsync((active) => active.runMission(input)),
    manageMissionRun: (input) => delegateAsync((active) => active.manageMissionRun(input)),
    previewUndoTransaction: (id) => delegateAsync((active) => active.previewUndoTransaction(id)),
    undoWorldTransaction: (input) => delegateAsync((active) => active.undoWorldTransaction(input)),
  };

  return app;
}

function controlsFor(
  phase: SmartBotAppPhase,
  pendingStartStop: boolean,
  connection: string = "disconnected",
): SmartBotControls {
  if (phase === "stopped") {
    return {
      canStart: true,
      canStop: false,
      canEmergencyStop: false,
      canRequestAgent: false,
    };
  }
  if (phase === "failed") {
    return {
      canStart: true,
      canStop: false,
      canEmergencyStop: false,
      canRequestAgent: false,
    };
  }
  if (phase === "starting") {
    return {
      canStart: false,
      canStop: !pendingStartStop,
      canEmergencyStop: !pendingStartStop,
      canRequestAgent: false,
    };
  }
  if (phase === "stopping") {
    return {
      canStart: false,
      canStop: false,
      canEmergencyStop: false,
      canRequestAgent: false,
    };
  }
  return {
    canStart: false,
    canStop: true,
    canEmergencyStop: true,
    canRequestAgent: connection === "connected",
  };
}

function comparableState(
  current: MutableState,
  controls: SmartBotControls,
): Record<string, unknown> {
  return {
    phase: current.phase,
    connectionStatus: current.connectionStatus,
    reconnectAttempts: current.reconnectAttempts,
    runtime: current.runtime,
    dashboardUrl: current.dashboardUrl,
    startedAt: current.startedAt,
    stoppedAt: current.stoppedAt,
    lastError: current.lastError,
    controls,
  };
}

function mapControlError(error: unknown): SmartBotControlError {
  if (error instanceof SmartBotControlError) return error;
  const mapped = mapError(error, "control");
  return new SmartBotControlError(mapped.code, mapped.message, mapped.recoverable);
}

function mapError(
  error: unknown,
  operation: "start" | "stop" | "control",
): SmartBotPublicError {
  if (error instanceof SmartBotControlError) return error.toPublic();
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  let code: SmartBotErrorCode;
  if (operation === "stop" || /cleanup|shutdown/.test(normalized)) {
    code = "STOP_FAILED";
  } else if (/runtime profile|profile file|profile.*missing/.test(normalized)) {
    code = "PROFILE_MISSING";
  } else if (/invalid configuration/.test(normalized)) {
    code = "CONFIG_INVALID";
  } else if (/codex.*(not found|could not|not authenticated|not signed|not using|chatgpt|login)/.test(normalized)) {
    code = "CODEX_AUTH_REQUIRED";
  } else if (/claude|not authenticated|sign in|authenticated/.test(normalized)) {
    code = "CLAUDE_AUTH_REQUIRED";
  } else if (/openrouter|api key|api-key/.test(normalized)) {
    code = "OPENROUTER_AUTH_REQUIRED";
  } else if (/another smartbot|already running|instance lock|smartbot\.lock/.test(normalized)) {
    code = "INSTANCE_LOCKED";
  } else if (/not connected|not running|disconnected/.test(normalized)) {
    code = "NOT_RUNNING";
  } else {
    code = operation === "control" ? "START_FAILED" : "START_FAILED";
  }
  return {
    code,
    message: publicMessage(code),
    recoverable: true,
  };
}

function publicMessage(code: SmartBotErrorCode): string {
  switch (code) {
    case "PROFILE_MISSING": return "Runtime profile is missing or unreadable.";
    case "CONFIG_INVALID": return "Runtime configuration is invalid.";
    case "CODEX_AUTH_REQUIRED": return "Codex CLI is unavailable or not signed in with ChatGPT.";
    case "CLAUDE_AUTH_REQUIRED": return "Claude Code is unavailable or not authenticated.";
    case "OPENROUTER_AUTH_REQUIRED": return "OpenRouter API key is missing or invalid.";
    case "INSTANCE_LOCKED": return "Another SmartBot instance is already running.";
    case "STOP_FAILED": return "SmartBot could not stop cleanly.";
    case "NOT_RUNNING": return "SmartBot is not running.";
    case "MAP_UNAVAILABLE": return "World map data is unavailable.";
    case "INVALID_INPUT": return "Input is invalid.";
    case "START_FAILED": return "SmartBot could not start.";
  }
}

function validateAgentInput(value: string): string {
  if (typeof value !== "string") throw invalidInput();
  const text = value.trim();
  if (!text || text.length > MAX_AGENT_INPUT_LENGTH || text.includes("\0")) {
    throw invalidInput();
  }
  return text;
}

function validateChatInput(value: string): string {
  if (typeof value !== "string") throw invalidInput();
  const text = value.trim();
  if (!text || text.length > MAX_CHAT_INPUT_LENGTH || /[\r\n\0]/.test(text)) {
    throw invalidInput();
  }
  return text;
}

function validateCommandInput(value: string): string {
  if (typeof value !== "string") throw invalidInput();
  const text = value.trim();
  if (
    !text ||
    text.length > MAX_COMMAND_INPUT_LENGTH ||
    text.startsWith("/") ||
    /[\r\n\0]/.test(text)
  ) {
    throw invalidInput();
  }
  return text;
}

function invalidInput(): SmartBotControlError {
  return new SmartBotControlError("INVALID_INPUT", publicMessage("INVALID_INPUT"), true);
}

function sanitizeConnectionStatus(value: unknown): string {
  if (typeof value !== "string") return "disconnected";
  return value.length > 256 ? `${value.slice(0, 255)}…` : value;
}

function safeAttemptCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function sanitizeDashboardUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return value;
  } catch {
    return null;
  }
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return message
    .replace(/[\r\n]+/g, " ")
    .replace(/(password|passwd|secret|token|authorization|cookie)\s*[:=]\s*[^\s]+/gi, "$1=[redacted]")
    .slice(0, 512);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
