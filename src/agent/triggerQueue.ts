import type { Logger } from "../util/logger.js";

export interface TriggerQueueDeps {
  log: Logger;
  /** Maximum number of in-flight + queued items. Defaults to 16. */
  maxDepth?: number;
}

export interface TriggerQueue {
  /** Schedule async work. Returns false if the depth cap rejected it. */
  enqueue(work: () => Promise<void>): boolean;
  /** Resolves when all currently-queued items have finished. */
  drain(): Promise<void>;
  /** Current in-flight + queued count. */
  depth(): number;
  /** Discard work that has not started. Returns the number discarded. */
  clear(): number;
}

export function createTriggerQueue(deps: TriggerQueueDeps): TriggerQueue {
  const maxDepth = deps.maxDepth ?? 16;
  const pending: Array<() => Promise<void>> = [];
  let running = false;
  let drainWaiters: Array<() => void> = [];

  function currentDepth(): number {
    return pending.length + (running ? 1 : 0);
  }

  function resolveDrainsIfIdle(): void {
    if (running || pending.length > 0) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function pump(): Promise<void> {
    if (running) return;
    const work = pending.shift();
    if (!work) {
      resolveDrainsIfIdle();
      return;
    }
    running = true;
    try {
      await work();
    } catch (err) {
      deps.log.error({ err }, "trigger queue: handler threw");
    } finally {
      running = false;
      void pump();
    }
  }

  function enqueue(work: () => Promise<void>): boolean {
    const depth = currentDepth();
    if (depth >= maxDepth) {
      deps.log.warn({ depth, maxDepth }, "trigger queue: depth cap reached, dropping work");
      return false;
    }
    pending.push(work);
    void pump();
    return true;
  }

  function drain(): Promise<void> {
    if (!running && pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.push(resolve));
  }

  function clear(): number {
    const discarded = pending.length;
    pending.length = 0;
    resolveDrainsIfIdle();
    return discarded;
  }

  return { enqueue, drain, depth: currentDepth, clear };
}
