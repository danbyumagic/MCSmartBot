import { describe, it, expect, vi } from "vitest";
import { createReflexRegistry } from "../../src/reactive/registry.js";
import { createPreemptController } from "../../src/reactive/preempt.js";
import type { Reflex } from "../../src/reactive/types.js";
import type { SkillRunner } from "../../src/skills/runner.js";
import { createBus } from "../../src/bus/index.js";
import { createLogger } from "../../src/util/logger.js";

const log = createLogger({ level: "error" });
const fakeBot = {} as Parameters<Reflex["check"]>[0];

function makeRunner(active: string | null = null): SkillRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    run: vi.fn().mockResolvedValue({ ok: true, summary: "" }),
    cancel: vi.fn(() => { calls.push("cancel"); }),
    restart: vi.fn(() => { calls.push("restart"); }),
    activeName: () => active,
    calls,
  } as unknown as SkillRunner & { calls: string[] };
}

describe("PreemptController", () => {
  it("tick() with no firing reflex is a no-op", () => {
    const reg = createReflexRegistry([{ name: "x", priority: 10, check: () => false, run: vi.fn() }]);
    const runner = makeRunner();
    const bus = createBus();
    const ctrl = createPreemptController({ bot: fakeBot, log, registry: reg, runner, bus });
    ctrl.tick();
    expect(runner.calls).toEqual([]);
    expect(ctrl.isFiring()).toBe(false);
  });

  it("tick() with a firing reflex cancels active skill, runs reflex, restarts skill", async () => {
    const runImpl = vi.fn().mockResolvedValue(undefined);
    const reg = createReflexRegistry([{ name: "danger", priority: 100, check: () => true, run: runImpl }]);
    const runner = makeRunner("gotoCoords");
    const bus = createBus();
    const ctrl = createPreemptController({ bot: fakeBot, log, registry: reg, runner, bus, cooldownMs: 0 });
    ctrl.tick();
    // Wait for the async fire() to finish.
    await new Promise((r) => setTimeout(r, 20));
    expect(runImpl).toHaveBeenCalled();
    expect((runner as any).calls).toEqual(["cancel", "restart"]);
  });

  it("tick() does not call cancel/restart when no skill was active", async () => {
    const runImpl = vi.fn().mockResolvedValue(undefined);
    const reg = createReflexRegistry([{ name: "danger", priority: 100, check: () => true, run: runImpl }]);
    const runner = makeRunner(null);
    const bus = createBus();
    const ctrl = createPreemptController({ bot: fakeBot, log, registry: reg, runner, bus, cooldownMs: 0 });
    ctrl.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(runImpl).toHaveBeenCalled();
    expect((runner as any).calls).toEqual([]);
  });

  it("tick() while already firing is a no-op (no double-fire)", async () => {
    let resolveRun!: () => void;
    const runImpl = vi.fn().mockReturnValue(new Promise<void>((r) => { resolveRun = r; }));
    const reg = createReflexRegistry([{ name: "danger", priority: 100, check: () => true, run: runImpl }]);
    const runner = makeRunner(null);
    const bus = createBus();
    const ctrl = createPreemptController({ bot: fakeBot, log, registry: reg, runner, bus, cooldownMs: 0 });
    ctrl.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(ctrl.isFiring()).toBe(true);
    ctrl.tick();
    ctrl.tick();
    expect(runImpl).toHaveBeenCalledTimes(1);
    resolveRun();
    await new Promise((r) => setTimeout(r, 20));
    expect(ctrl.isFiring()).toBe(false);
  });

  it("alerting reflex emits reflexAlert on the bus; non-alerting reflexes do not", async () => {
    const reg = createReflexRegistry([
      { name: "alerting", priority: 100, check: () => true, run: vi.fn().mockResolvedValue(undefined) },
    ]);
    const runner = makeRunner();
    const bus = createBus();
    const events: Array<{ kind: string; summary?: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string; summary?: string }));
    const ctrl = createPreemptController({ bot: fakeBot, log, registry: reg, runner, bus, cooldownMs: 0 });
    ctrl.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("reflexAlert");
    expect(events[0]?.summary).toMatch(/alerting/);

    // Same reflex with empty alertingReflexes set should NOT emit.
    const ctrl2 = createPreemptController({
      bot: fakeBot, log, registry: reg, runner, bus, cooldownMs: 0,
      alertingReflexes: new Set(),
    });
    events.length = 0;
    ctrl2.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
  });

  it("a reflex that exceeds the timeoutMs is aborted", async () => {
    let aborted = false;
    const runImpl = vi.fn().mockImplementation(async (_b, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
      });
    });
    const reg = createReflexRegistry([{ name: "slow", priority: 100, check: () => true, run: runImpl }]);
    const runner = makeRunner();
    const bus = createBus();
    const ctrl = createPreemptController({
      bot: fakeBot, log, registry: reg, runner, bus, cooldownMs: 0, timeoutMs: 30,
    });
    ctrl.tick();
    await new Promise((r) => setTimeout(r, 80));
    expect(aborted).toBe(true);
    expect(ctrl.isFiring()).toBe(false);
  });

  it("cancel() aborts an active reflex for emergency stop", async () => {
    let aborted = false;
    const runImpl = vi.fn().mockImplementation(async (_b, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    });
    const reg = createReflexRegistry([{ name: "slow", priority: 100, check: () => true, run: runImpl }]);
    const ctrl = createPreemptController({
      bot: fakeBot,
      log,
      registry: reg,
      runner: makeRunner(),
      bus: createBus(),
      cooldownMs: 0,
      timeoutMs: 10_000,
    });
    ctrl.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    ctrl.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(aborted).toBe(true);
    expect(ctrl.isFiring()).toBe(false);
  });
});
