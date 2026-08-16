import { describe, it, expect, vi } from "vitest";
import { createSendQueue } from "../../src/bot/sendQueue.js";

function makeBot() {
  const sent: string[] = [];
  const bot = { chat: (text: string) => sent.push(text) } as unknown as Parameters<typeof createSendQueue>[0];
  return { bot, sent };
}

describe("createSendQueue", () => {
  it("sends immediately when nothing was sent recently", async () => {
    const { bot, sent } = makeBot();
    const queue = createSendQueue(bot, { minIntervalMs: 1000, now: () => 1000, delay: async () => {} });
    await queue.send("hello");
    expect(sent).toEqual(["hello"]);
  });

  it("rate-limits successive sends to the minimum interval", async () => {
    const { bot, sent } = makeBot();
    let t = 1000;
    const delays: number[] = [];
    const queue = createSendQueue(bot, {
      minIntervalMs: 1000,
      now: () => t,
      delay: async (ms) => {
        delays.push(ms);
        t += ms;
      },
    });

    await queue.send("a"); // sends at t=1000
    await queue.send("b"); // should wait 1000ms → sends at t=2000
    await queue.send("c"); // wait 1000ms → t=3000

    expect(sent).toEqual(["a", "b", "c"]);
    expect(delays).toEqual([1000, 1000]); // first send had no wait, two subsequent ones did
  });

  it("preserves send order even with interleaved calls", async () => {
    const { bot, sent } = makeBot();
    let t = 0;
    const queue = createSendQueue(bot, {
      minIntervalMs: 500,
      now: () => t,
      delay: async (ms) => {
        t += ms;
      },
    });

    // Fire three sends in parallel (no awaits between them).
    const p1 = queue.send("first");
    const p2 = queue.send("second");
    const p3 = queue.send("third");
    await Promise.all([p1, p2, p3]);

    expect(sent).toEqual(["first", "second", "third"]);
  });

  it("does not wait when enough time has elapsed naturally between sends", async () => {
    const { bot, sent } = makeBot();
    let t = 0;
    const delays: number[] = [];
    const queue = createSendQueue(bot, {
      minIntervalMs: 1000,
      now: () => t,
      delay: async (ms) => {
        delays.push(ms);
        t += ms;
      },
    });

    await queue.send("a"); // t=0
    t = 5000;              // 5s pass naturally
    await queue.send("b"); // should send immediately, no delay
    expect(sent).toEqual(["a", "b"]);
    expect(delays).toEqual([]); // neither send waited
  });

  it("pending() reflects in-flight queued sends", async () => {
    const { bot } = makeBot();
    let t = 0;
    let resolveFirst!: () => void;
    const queue = createSendQueue(bot, {
      minIntervalMs: 1000,
      now: () => t,
      delay: () => new Promise<void>((r) => { resolveFirst = r; }),
    });

    queue.send("a"); // sends immediately, lastSent=0
    queue.send("b"); // queues; needs 1000ms wait
    queue.send("c"); // queues
    await new Promise((r) => setTimeout(r, 5));
    expect(queue.pending()).toBeGreaterThan(0);
    resolveFirst();
    await new Promise((r) => setTimeout(r, 5));
  });

  it("close prevents queued and future messages from reaching the bot", async () => {
    const { bot, sent } = makeBot();
    let release!: () => void;
    const queue = createSendQueue(bot, {
      minIntervalMs: 1000,
      now: () => 0,
      delay: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    await queue.send("first");
    const second = queue.send("second");
    await Promise.resolve();
    queue.close();
    release();
    await second;
    await queue.send("third");
    expect(sent).toEqual(["first"]);
  });

  it("drops messages when an early kick removes the protocol chat method", async () => {
    const sent: string[] = [];
    const bot = {
      _client: {},
      chat: (text: string) => sent.push(text),
    } as unknown as Parameters<typeof createSendQueue>[0];
    const queue = createSendQueue(bot);

    await expect(queue.send("cannot be delivered")).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });
});
