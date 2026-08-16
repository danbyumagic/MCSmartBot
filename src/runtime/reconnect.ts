import type { Logger } from "../util/logger.js";
import type {
  ConnectionRuntime,
  ConnectionRuntimeHooks,
} from "./connection.js";

export interface ReconnectSupervisor {
  start(): void;
  stop(reason?: string): void;
  current(): ConnectionRuntime | null;
  attempts(): number;
}

export function createReconnectSupervisor(deps: {
  log: Logger;
  connect(hooks: ConnectionRuntimeHooks): ConnectionRuntime;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): ReconnectSupervisor {
  const baseDelayMs = deps.baseDelayMs ?? 1_000;
  const maxDelayMs = deps.maxDelayMs ?? 60_000;
  const jitterRatio = deps.jitterRatio ?? 0.2;
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let runtime: ConnectionRuntime | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryCount = 0;
  let stopped = false;
  let generation = 0;

  function open(): void {
    if (stopped) return;
    const myGeneration = ++generation;
    try {
      runtime = deps.connect({
        onReady: () => {
          if (myGeneration !== generation || stopped) return;
          retryCount = 0;
          deps.log.info("minecraft connection ready");
        },
        onEnd: (reason) => {
          if (myGeneration !== generation || stopped) return;
          runtime = null;
          schedule(reason);
        },
      });
    } catch (err) {
      runtime = null;
      deps.log.error({ err }, "minecraft connection creation failed");
      schedule((err as Error).message);
    }
  }

  function schedule(reason: string): void {
    if (stopped || timer) return;
    const exponential = Math.min(
      maxDelayMs,
      baseDelayMs * (2 ** Math.min(retryCount, 16)),
    );
    retryCount++;
    const jitter = exponential * jitterRatio * ((random() * 2) - 1);
    const delay = Math.max(0, Math.round(exponential + jitter));
    deps.log.warn(
      { reason, reconnectAttempt: retryCount, delayMs: delay },
      "minecraft connection ended; scheduling reconnect",
    );
    timer = setTimer(() => {
      timer = null;
      open();
    }, delay);
  }

  function start(): void {
    if (runtime || timer || stopped) return;
    open();
  }

  function stop(reason = "shutdown"): void {
    if (stopped) return;
    stopped = true;
    generation++;
    if (timer) clearTimer(timer);
    timer = null;
    runtime?.stop(reason);
    runtime = null;
  }

  return {
    start,
    stop,
    current: () => runtime,
    attempts: () => retryCount,
  };
}
