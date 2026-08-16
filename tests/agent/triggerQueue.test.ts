import { describe, it, expect } from "vitest";
import { createTriggerQueue } from "../../src/agent/triggerQueue.js";
import { createLogger } from "../../src/util/logger.js";

const log = createLogger({ level: "error" });

describe("createTriggerQueue", () => {
  it("processes triggers in order, one at a time", async () => {
    const order: string[] = [];
    const slow = (label: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(label);
    };
    const queue = createTriggerQueue({ log });
    queue.enqueue(slow("first", 30));
    queue.enqueue(slow("second", 10));
    queue.enqueue(slow("third", 5));
    await queue.drain();
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("logs and continues when a handler throws", async () => {
    const order: string[] = [];
    const queue = createTriggerQueue({ log });
    queue.enqueue(async () => {
      throw new Error("boom");
    });
    queue.enqueue(async () => {
      order.push("ran");
    });
    await queue.drain();
    expect(order).toEqual(["ran"]);
  });

  it("drain() resolves immediately when nothing is queued", async () => {
    const queue = createTriggerQueue({ log });
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it("drops work over maxDepth and returns false from enqueue", async () => {
    const queue = createTriggerQueue({ log, maxDepth: 2 });
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    queue.enqueue(async () => {
      await firstPromise;
    });
    queue.enqueue(async () => {});
    expect(queue.depth()).toBe(2);
    const accepted = queue.enqueue(async () => {});
    expect(accepted).toBe(false);
    resolveFirst();
    await queue.drain();
  });

  it("depth() reflects in-flight + queued work", async () => {
    const queue = createTriggerQueue({ log });
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    queue.enqueue(async () => {
      await firstPromise;
    });
    queue.enqueue(async () => {});
    expect(queue.depth()).toBe(2);
    resolveFirst();
    await queue.drain();
    expect(queue.depth()).toBe(0);
  });

  it("clear() discards queued work while allowing the active item to finish", async () => {
    const queue = createTriggerQueue({ log });
    const ran: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    queue.enqueue(async () => {
      await blocker;
      ran.push("active");
    });
    queue.enqueue(async () => { ran.push("discarded-1"); });
    queue.enqueue(async () => { ran.push("discarded-2"); });
    expect(queue.clear()).toBe(2);
    expect(queue.depth()).toBe(1);
    release();
    await queue.drain();
    expect(ran).toEqual(["active"]);
  });
});
