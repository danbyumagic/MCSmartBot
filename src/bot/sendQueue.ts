import type { Bot } from "mineflayer";

export interface SendQueue {
  /**
   * Queue a chat-stream line for the server. Resolves once it's actually
   * sent to mineflayer's bot.chat. Calls are spaced at least `minIntervalMs`
   * apart to avoid the server's anti-spam kick.
   */
  send(text: string): Promise<void>;
  /** Current backlog size (sent items waiting to be flushed). */
  pending(): number;
  /** Prevent queued or future messages from reaching a disposed connection. */
  close(): void;
}

export interface CreateSendQueueOpts {
  minIntervalMs?: number;
  /** Test hook: replaces Date.now. */
  now?: () => number;
  /** Test hook: replaces setTimeout. */
  delay?: (ms: number) => Promise<void>;
}

/**
 * Rate-limited wrapper around `bot.chat`. ALL chat, whispers, and slash
 * commands should route through this so the bot never spams the server.
 *
 * Default 1000ms between sends — Vanilla / Paper / Spigot anti-spam plugins
 * generally kick after 3+ messages/sec; 1s/msg sits comfortably under that.
 */
export function createSendQueue(bot: Bot, opts: CreateSendQueueOpts = {}): SendQueue {
  const minIntervalMs = opts.minIntervalMs ?? 1000;
  const now = opts.now ?? Date.now;
  const delay = opts.delay ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  // Initialize so the first send fires immediately regardless of `now()`.
  let lastSent = Number.NEGATIVE_INFINITY;
  let queueLen = 0;
  let tail: Promise<void> = Promise.resolve();
  let closed = false;

  function send(text: string): Promise<void> {
    queueLen++;
    const previousTail = tail;
    let releaseNext!: () => void;
    tail = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });

    return previousTail.then(async () => {
      try {
        if (closed) return;
        const wait = Math.max(0, lastSent + minIntervalMs - now());
        if (wait > 0) await delay(wait);
        if (closed) return;
        // Mineflayer keeps bot.chat available while transitioning out of the
        // login state, but its underlying protocol chat method is absent after
        // an early kick (for example, a whitelist rejection). Drop the message
        // instead of crashing the process while the connection shuts down.
        const client = (bot as Bot & { _client?: { chat?: unknown } })._client;
        if (client && typeof client.chat !== "function") return;
        bot.chat(text);
        lastSent = now();
      } finally {
        queueLen--;
        releaseNext();
      }
    });
  }

  return {
    send,
    pending: () => queueLen,
    close: () => { closed = true; },
  };
}
