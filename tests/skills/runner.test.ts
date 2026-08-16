import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineSkill as defineProductionSkill,
  type SkillContext,
  type SkillDefinition,
} from "../../src/skills/types.js";
import { createSkillRunner } from "../../src/skills/runner.js";
import { createLogger } from "../../src/util/logger.js";
import { openDatabase } from "../../src/memory/db.js";
import { getRecentSkillRuns } from "../../src/memory/skillRuns.js";
import { createBus } from "../../src/bus/index.js";
import { snapshotSkillExecutionContext, systemActor } from "../../src/permissions/executionActor.js";

const log = createLogger({ level: "error" });
const fakeBot = {} as unknown as SkillContext["bot"]; // never accessed in these tests
const testPolicy = {
  minimumRole: "operator" as const,
  effect: "world-change" as const,
  reversible: false,
  mission: "public" as const,
};
const defaultExecution = snapshotSkillExecutionContext({
  actor: systemActor("TestOwner", "recovery"),
});

function makeRunner(options: {
  db?: ReturnType<typeof openDatabase>;
  bus?: ReturnType<typeof createBus>;
} = {}) {
  return createSkillRunner({ bot: fakeBot, log, defaultExecution, ...options });
}

function defineSkill<P>(definition: Omit<SkillDefinition<P>, "policy">): SkillDefinition<P> {
  return defineProductionSkill({ ...definition, policy: testPolicy });
}

const okSkill = defineSkill({
  name: "ok",
  description: "x",
  params: z.object({ value: z.number() }),
  run: async ({ value }) => ({ ok: true, summary: `value=${value}` }),
});

function blockingSkill(seenAbort: { aborted: boolean }) {
  return defineSkill({
    name: "blocking",
    description: "x",
    params: z.object({}),
    async run(_params, ctx) {
      try {
        await new Promise<void>((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            seenAbort.aborted = true;
            reject(new Error("aborted"));
          });
        });
        return { ok: true, summary: "completed" };
      } catch {
        return { ok: false, summary: "cancelled" };
      }
    },
  });
}

describe("SkillRunner", () => {
  it("runs a skill to completion when not interrupted", async () => {
    const runner = makeRunner();
    const result = await runner.run(okSkill, { value: 42 });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("value=42");
  });

  it("rejects an already-expired execution deadline before calling the handler", async () => {
    let invoked = false;
    const deadlineBound = defineSkill({
      name: "deadlineBound",
      description: "x",
      params: z.object({}),
      async run() {
        invoked = true;
        return { ok: true, summary: "should not run" };
      },
    });
    const runner = makeRunner();

    const result = await runner.run(deadlineBound, {}, {
      execution: {
        actor: defaultExecution.actor,
        deadlineAt: Date.now() - 1,
      },
    });

    expect(invoked).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      code: "TIMED_OUT",
      recoverable: false,
    });
  });

  it("aborts an awaited run at its deadline and preserves TIMED_OUT", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    vi.useFakeTimers();
    try {
      let observedAbort = false;
      const deadlineBound = defineSkill({
        name: "deadlineBoundActive",
        description: "x",
        params: z.object({}),
        longRunning: true,
        async run(_params, ctx) {
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              observedAbort = true;
              resolve();
            });
          });
          return {
            ok: false,
            summary: "handler observed an interrupt",
            code: "INTERRUPTED" as const,
            recoverable: true,
          };
        },
      });
      const runner = makeRunner({ db });
      const deadlineAt = Date.now() + 100;
      const pending = runner.run(deadlineBound, {}, {
        waitForCompletion: true,
        execution: {
          actor: defaultExecution.actor,
          planId: 9,
          missionRunId: 4,
          deadlineAt,
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(observedAbort).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        code: "TIMED_OUT",
        recoverable: false,
        details: { planId: 9, missionRunId: 4, deadlineAt },
      });
      expect(runner.activeName()).toBeNull();
      expect(getRecentSkillRuns(db, 10)).toMatchObject([{
        status: "failed",
        errorCode: "TIMED_OUT",
        recoverable: false,
      }]);
    } finally {
      vi.useRealTimers();
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("validates params via the skill's Zod schema and returns a failed result on validation error", async () => {
    const runner = makeRunner();
    const result = await runner.run(okSkill, { value: "wrong" });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/invalid|param/i);
    expect(result.code).toBe("INVALID_PARAMS");
    expect(result.recoverable).toBe(false);
  });

  it("cancels the in-flight skill when a new run starts", async () => {
    const runner = makeRunner();
    const abortSeen = { aborted: false };
    const blocker = blockingSkill(abortSeen);

    const firstPromise = runner.run(blocker, {});
    // Give the blocker a tick to register its abort handler.
    await new Promise((r) => setTimeout(r, 10));

    const secondResult = await runner.run(okSkill, { value: 1 });
    const firstResult = await firstPromise;

    expect(abortSeen.aborted).toBe(true);
    expect(firstResult.ok).toBe(false);
    expect(secondResult.ok).toBe(true);
  });

  it("deduplicates the same active skill and parameters without restarting it", async () => {
    let starts = 0;
    let aborts = 0;
    const skill = defineSkill({
      name: "follow",
      description: "x",
      params: z.object({ username: z.string() }),
      longRunning: true,
      async run(_params, ctx) {
        starts++;
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            aborts++;
            reject(new Error("aborted"));
          });
        });
        return { ok: true, summary: "done" };
      },
    });
    const runner = makeRunner();
    await runner.run(skill, { username: "xxdj" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const duplicate = await runner.run(skill, { username: "xxdj" });

    expect(duplicate).toMatchObject({
      ok: true,
      data: { activeSkill: "follow", deduplicated: true },
    });
    expect(starts).toBe(1);
    expect(aborts).toBe(0);
    runner.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("does not deduplicate a durable invocation against a direct run with the same params", async () => {
    const seenPlanIds: Array<number | undefined> = [];
    let invocations = 0;
    const shared = defineSkill({
      name: "shared",
      description: "x",
      params: z.object({ value: z.number() }),
      longRunning: true,
      async run(_params, ctx) {
        invocations++;
        seenPlanIds.push(ctx.execution.planId);
        if (invocations === 1) {
          await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
          return { ok: false, summary: "direct run preempted", code: "INTERRUPTED" as const };
        }
        return { ok: true, summary: "durable run completed" };
      },
    });
    const runner = makeRunner();
    await runner.run(shared, { value: 4 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await runner.run(shared, { value: 4 }, {
      waitForCompletion: true,
      execution: {
        actor: defaultExecution.actor,
        planId: 9,
        missionRunId: 4,
        deadlineAt: Date.now() + 10_000,
      },
    });

    expect(result).toEqual({ ok: true, summary: "durable run completed" });
    expect(invocations).toBe(2);
    expect(seenPlanIds).toEqual([undefined, 9]);
  });

  it("cancel() aborts the in-flight skill without starting a new one", async () => {
    const runner = makeRunner();
    const abortSeen = { aborted: false };
    const blocker = blockingSkill(abortSeen);
    const firstPromise = runner.run(blocker, {});
    await new Promise((r) => setTimeout(r, 10));
    runner.cancel();
    const firstResult = await firstPromise;
    expect(abortSeen.aborted).toBe(true);
    expect(firstResult.ok).toBe(false);
    expect(runner.activeName()).toBeNull();
  });

  it("logs successful runs to skill_runs when db is provided", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    try {
      const runner = makeRunner({ db });
      await runner.run(okSkill, { value: 7 });
      const runs = getRecentSkillRuns(db, 10);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("ok");
      expect(runs[0]?.summary).toBe("value=7");
      expect(runs[0]?.params).toEqual({ value: 7 });
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("logs cancelled runs with status 'cancelled' when db is provided", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    const db = openDatabase(join(tmp, "memory.sqlite"));
    try {
      const runner = makeRunner({ db });
      const abortSeen = { aborted: false };
      const blocker = blockingSkill(abortSeen);
      const firstPromise = runner.run(blocker, {});
      await new Promise((r) => setTimeout(r, 10));
      runner.cancel();
      await firstPromise;
      const runs = getRecentSkillRuns(db, 10);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("cancelled");
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("restart() re-fires the last run with the same params", async () => {
    const runner = makeRunner();
    const calls: number[] = [];
    const watcher = defineSkill({
      name: "watcher",
      description: "x",
      params: z.object({ n: z.number() }),
      run: async ({ n }) => {
        calls.push(n);
        return { ok: true, summary: `n=${n}` };
      },
    });
    await runner.run(watcher, { n: 7 });
    runner.restart();
    await new Promise((r) => setTimeout(r, 5)); // let the restart settle
    expect(calls).toEqual([7, 7]);
  });

  it("restart() is a no-op before any run", () => {
    const runner = makeRunner();
    expect(() => runner.restart()).not.toThrow();
  });

  it("snapshots execution actor provenance before an in-flight skill can await", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let observedUsername = "";
    const slow = defineSkill({
      name: "actorSnapshot",
      description: "x",
      params: z.object({}),
      async run(_params, ctx) {
        await gate;
        observedUsername = ctx.execution.actor.username;
        return { ok: true, summary: "done" };
      },
    });
    const mutableActor = {
      username: "Builder",
      role: "operator" as const,
      source: "minecraft-chat" as const,
    };
    const runner = makeRunner();
    const running = runner.run(slow, {}, { execution: { actor: mutableActor } });
    mutableActor.username = "LaterRequester";
    release();
    await running;

    expect(observedUsername).toBe("Builder");
  });

  it("emits skillDone on the bus for a successful run when bus is provided", async () => {
    const bus = createBus();
    const events: Array<{ kind: string; skill?: string; ok?: boolean; summary?: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const runner = makeRunner({ bus });
    await runner.run(okSkill, { value: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("skillDone");
    expect(events[0]?.skill).toBe("ok");
    expect(events[0]?.ok).toBe(true);
    expect(events[0]?.summary).toBe("value=5");
  });

  it("emits skillFailed on the bus when a skill returns ok:false", async () => {
    const bus = createBus();
    const events: Array<{
      kind: string;
      skill?: string;
      error?: string;
      code?: string;
      recoverable?: boolean;
    }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const runner = makeRunner({ bus });
    const failing = defineSkill({
      name: "failing",
      description: "x",
      params: z.object({}),
      run: async () => ({
        ok: false,
        summary: "no path",
        code: "NO_PATH",
        recoverable: true,
        details: { target: "base" },
      }),
    });
    await runner.run(failing, {});
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("skillFailed");
    expect(events[0]?.error).toBe("no path");
    expect(events[0]?.code).toBe("NO_PATH");
    expect(events[0]?.recoverable).toBe(true);
  });

  it("emits skillFailed when a skill throws", async () => {
    const bus = createBus();
    const events: Array<{ kind: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const runner = makeRunner({ bus });
    const thrower = defineSkill({
      name: "thrower",
      description: "x",
      params: z.object({}),
      run: async () => { throw new Error("boom"); },
    });
    await runner.run(thrower, {});
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("skillFailed");
  });

  it("does NOT emit any skill trigger on the bus when a run is cancelled", async () => {
    const bus = createBus();
    const events: Array<{ kind: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const runner = makeRunner({ bus });
    const abortSeen = { aborted: false };
    const blocker = blockingSkill(abortSeen);
    const p = runner.run(blocker, {});
    await new Promise((r) => setTimeout(r, 10));
    runner.cancel();
    await p;
    expect(events).toEqual([]);
  });

  it("does NOT emit skillFailed on the bus when a thrown skill was cancelled", async () => {
    const bus = createBus();
    const events: Array<{ kind: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const runner = makeRunner({ bus });
    const throwingBlocker = defineSkill({
      name: "throwingBlocker",
      description: "x",
      params: z.object({}),
      async run(_p, ctx) {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return { ok: true, summary: "" };
      },
    });
    const p = runner.run(throwingBlocker, {});
    await new Promise((r) => setTimeout(r, 10));
    runner.cancel();
    await p;
    expect(events).toEqual([]);
  });

  it("longRunning skills return started-ack immediately without awaiting completion", async () => {
    let started = false;
    let finished = false;
    const longSkill = defineSkill({
      name: "longSkill",
      description: "x",
      params: z.object({}),
      longRunning: true,
      async run(_p, ctx) {
        started = true;
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        finished = true;
        return { ok: true, summary: "" };
      },
    });
    const runner = makeRunner();
    const t0 = Date.now();
    const result = await runner.run(longSkill, {});
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/started/);
    // Give the skill a tick to start in the background.
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(true);
    expect(finished).toBe(false);
    runner.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(finished).toBe(false); // it rejected, didn't finish naturally
  });

  it("can await a longRunning skill for durable task execution", async () => {
    const longSkill = defineSkill({
      name: "awaitedLongSkill",
      description: "x",
      params: z.object({}),
      longRunning: true,
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { ok: true, summary: "actually done" };
      },
    });
    const runner = makeRunner();
    const result = await runner.run(longSkill, {}, { waitForCompletion: true });
    expect(result).toEqual({ ok: true, summary: "actually done" });
    expect(runner.activeName()).toBeNull();
  });

  it("can suppress per-skill triggers when a durable coordinator owns notifications", async () => {
    const bus = createBus();
    const events: Array<{ kind: string }> = [];
    bus.on("agent.trigger", (event) => events.push(event as { kind: string }));
    const skill = defineSkill({
      name: "coordinated",
      description: "x",
      params: z.object({}),
      async run() {
        return { ok: false, summary: "not enough stone", code: "NO_MATERIAL" as const };
      },
    });
    const runner = makeRunner({ bus });
    await runner.run(skill, {}, { waitForCompletion: true, emitTrigger: false });
    expect(events).toEqual([]);
  });

  it("longRunning skills emit skillDone on natural completion", async () => {
    const bus = createBus();
    const events: Array<{ kind: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const longSkill = defineSkill({
      name: "quick",
      description: "x",
      params: z.object({}),
      longRunning: true,
      async run() {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, summary: "done" };
      },
    });
    const runner = makeRunner({ bus });
    await runner.run(longSkill, {});
    // Wait for the background skill to finish.
    await new Promise((r) => setTimeout(r, 60));
    expect(events.some((e) => e.kind === "skillDone")).toBe(true);
  });

  it("longRunning skill cancellation does NOT emit skillFailed via the bus", async () => {
    const bus = createBus();
    const events: Array<{ kind: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const runner = makeRunner({ bus });
    const abortSeen = { aborted: false };
    const blocker = defineSkill({
      name: "longBlocker",
      description: "x",
      params: z.object({}),
      longRunning: true,
      async run(_p, ctx) {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => { abortSeen.aborted = true; reject(new Error("aborted")); });
        });
        return { ok: true, summary: "" };
      },
    });
    await runner.run(blocker, {});
    await new Promise((r) => setTimeout(r, 10));
    runner.cancel();
    await new Promise((r) => setTimeout(r, 30));
    expect(abortSeen.aborted).toBe(true);
    expect(events).toEqual([]);
  });
});
