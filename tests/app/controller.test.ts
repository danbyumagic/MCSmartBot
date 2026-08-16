import { describe, expect, it, vi } from "vitest";
import {
  createSmartBotApp,
  SmartBotControlError,
} from "../../src/app/controller.js";
import { createAppLogBuffer } from "../../src/app/logBuffer.js";
import type { RuntimeReadSession, RuntimeSession, RuntimeSessionSnapshot, SmartBotAppSnapshot } from "../../src/app/contracts.js";
import type { SmartBotAppSnapshot } from "../../src/app/contracts.js";

function stoppedSnapshot(): SmartBotAppSnapshot {
  return {
    revision: 0,
    observedAt: 0,
    phase: "stopped",
    connectionStatus: "disconnected",
    reconnectAttempts: 0,
    runtime: {
      connection: "disconnected",
      activeSkill: null,
      health: null,
      food: null,
      dimension: null,
      position: null,
      inventory: null,
    },
    dashboardUrl: null,
    startedAt: null,
    stoppedAt: null,
    lastError: null,
    controls: {
      canStart: true,
      canStop: false,
      canEmergencyStop: false,
      canRequestAgent: false,
    },
  };
}

describe("SmartBotApp contract fixture", () => {
  it("defines the exact stopped control flags", () => {
    expect(stoppedSnapshot().controls).toEqual({
      canStart: true,
      canStop: false,
      canEmergencyStop: false,
      canRequestAgent: false,
    });
  });
});

function runtimeSnapshot(overrides: Partial<RuntimeSessionSnapshot> = {}): RuntimeSessionSnapshot {
  return {
    connectionStatus: "connected",
    reconnectAttempts: 0,
    runtime: {
      connection: "connected",
      activeSkill: null,
      health: 20,
      food: 20,
      dimension: "overworld",
      position: { x: 1, y: 2, z: 3 },
      inventory: {
        available: true,
        carried: [{
          name: "diamond_pickaxe",
          count: 1,
          slot: 0,
          customName: null,
          durability: { remaining: 10, maximum: 100, percent: 10 },
          enchantments: [{ name: "efficiency", level: 3 }],
        }],
        totals: [{ name: "diamond_pickaxe", count: 1 }],
        hotbar: [],
        held: null,
        equipment: {
          head: null,
          torso: null,
          legs: null,
          feet: null,
          offHand: null,
        },
        capacity: 36,
        usedSlots: 1,
        freeSlots: 35,
        nearBreaking: [],
      },
    },
    dashboardUrl: "http://127.0.0.1:8787",
    ...overrides,
  };
}

function fakeSession(initial: RuntimeSessionSnapshot = runtimeSnapshot()): {
  session: RuntimeSession;
  current: RuntimeSessionSnapshot;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emergency: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
} {
  const state = { current: structuredClone(initial) };
  const start = vi.fn();
  const stop = vi.fn(async () => {});
  const emergency = vi.fn(() => null);
  const snapshot = vi.fn(() => structuredClone(state.current));
  const session: RuntimeSession = {
    start,
    stop,
    emergencyStop: emergency,
    requestAgent: vi.fn(),
    sendPublicChat: vi.fn(),
    runCommand: vi.fn(),
    snapshot,
    listMissions: vi.fn(() => []),
    getMission: vi.fn(() => undefined),
    listMissionRuns: vi.fn(() => []),
    getMissionRun: vi.fn(() => undefined),
    listWorldTransactions: vi.fn(() => []),
    getWorldTransaction: vi.fn(() => undefined),
    validateMission: vi.fn(() => ({ valid: true, errors: [] })),
    previewMission: vi.fn(() => ({ valid: true, errors: [] })),
    saveMission: vi.fn(() => { throw new Error("not configured"); }),
    runMission: vi.fn(() => { throw new Error("not configured"); }),
    manageMissionRun: vi.fn(() => { throw new Error("not configured"); }),
    previewUndoTransaction: vi.fn(() => { throw new Error("not configured"); }),
    undoWorldTransaction: vi.fn(async () => { throw new Error("not configured"); }),
  };
  return {
    session,
    get current() { return state.current; },
    set current(value) { state.current = value; },
    start,
    stop,
    emergency,
    snapshot,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controllerHarness(
  openSession: () => Promise<RuntimeSession>,
  openReadOnlySession?: () => Promise<RuntimeReadSession>,
) {
  let tick: (() => void) | undefined;
  const clearInterval = vi.fn();
  const setInterval = vi.fn((callback: () => void) => {
    tick = callback;
    return 1 as unknown as ReturnType<typeof globalThis.setInterval>;
  });
  const logBuffer = createAppLogBuffer();
  const app = createSmartBotApp({
    openSession,
    openReadOnlySession,
    logBuffer,
    now: (() => {
      let value = 100;
      return () => ++value;
    })(),
    setInterval,
    clearInterval,
  });
  return { app, logBuffer, setInterval, clearInterval, tick: () => tick?.() };
}

describe("SmartBotApp controller", () => {
  it("transitions through start and stop exactly once", async () => {
    const fake = fakeSession();
    const harness = controllerHarness(async () => fake.session);
    const updates: SmartBotAppSnapshot[] = [];
    harness.app.subscribe((snapshot) => updates.push(snapshot));

    const started = await harness.app.start();
    expect(started.phase).toBe("running");
    expect(started.controls.canRequestAgent).toBe(true);
    expect(fake.start).toHaveBeenCalledOnce();
    expect(updates.map((snapshot) => snapshot.phase)).toEqual([
      "starting", "running",
    ]);

    const first = harness.app.stop("test");
    const second = harness.app.stop("duplicate");
    expect(first).toBe(second);
    const stopped = await first;
    expect(stopped.phase).toBe("stopped");
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(harness.clearInterval).toHaveBeenCalledOnce();
  });

  it("shares a delayed start, supports retry, and sanitizes failures", async () => {
    const pending = deferred<RuntimeSession>();
    const fake = fakeSession();
    const openSession = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(fake.session);
    const harness = controllerHarness(openSession);

    const first = harness.app.start();
    expect(harness.app.start()).toBe(first);
    pending.resolve(fake.session);
    await first;
    expect(openSession).toHaveBeenCalledOnce();

    const failing = controllerHarness(async () => {
      throw new Error("Invalid configuration: TOKEN=do-not-leak");
    });
    await expect(failing.app.start()).rejects.toBeInstanceOf(SmartBotControlError);
    expect(failing.app.snapshot()).toMatchObject({
      phase: "failed",
      lastError: { code: "CONFIG_INVALID" },
    });
    expect(JSON.stringify(failing.app.snapshot())).not.toContain("do-not-leak");
  });

  it("waits for delayed start before tearing down and escalates emergency", async () => {
    const pending = deferred<RuntimeSession>();
    const fake = fakeSession();
    const harness = controllerHarness(() => pending.promise);
    const start = harness.app.start();
    const stop = harness.app.stop("operator stop");
    expect(harness.app.snapshot().controls.canStop).toBe(false);
    const emergency = harness.app.emergencyStop("panic");
    expect(emergency).toBe(stop);
    pending.resolve(fake.session);
    const stopped = await stop;
    await start;
    expect(stopped.phase).toBe("stopped");
    expect(fake.emergency).toHaveBeenCalledWith("panic");
    expect(fake.stop).toHaveBeenCalledWith("panic");
  });

  it("polls only meaningful changes and isolates subscribers", async () => {
    const fake = fakeSession();
    const harness = controllerHarness(async () => fake.session);
    const received: SmartBotAppSnapshot[] = [];
    harness.app.subscribe(() => { throw new Error("subscriber failure"); });
    harness.app.subscribe((snapshot) => received.push(snapshot));
    await harness.app.start();
    const revision = harness.app.snapshot().revision;
    harness.tick();
    expect(harness.app.snapshot().revision).toBe(revision);

    fake.current = runtimeSnapshot({
      reconnectAttempts: 1,
      runtime: { ...runtimeSnapshot().runtime, activeSkill: "mineUntil" },
    });
    harness.tick();
    expect(harness.app.snapshot().revision).toBeGreaterThan(revision);
    expect(received.at(-1)?.runtime.activeSkill).toBe("mineUntil");
  });

  it("keeps snapshots immutable, validates input, and logs one poll failure streak", async () => {
    const fake = fakeSession();
    fake.snapshot.mockImplementation(() => {
      throw new Error("secret=hidden");
    });
    const harness = controllerHarness(async () => fake.session);
    await harness.app.start();
    harness.tick();
    harness.tick();
    expect(harness.logBuffer.entries()).toHaveLength(1);
    expect(harness.logBuffer.entries()[0]?.context.error).not.toContain("hidden");

    fake.snapshot.mockImplementation(() => structuredClone(fake.current));
    harness.tick();
    const received = harness.app.snapshot();
    received.runtime.inventory!.carried[0]!.name = "mutated";
    expect(harness.app.snapshot().runtime.inventory!.carried[0]!.name)
      .toBe("diamond_pickaxe");

    expect(() => harness.app.sendPublicChat("line\nnext")).toThrow(/Input is invalid/);
    expect(() => harness.app.runCommand("/stop")).toThrow(/Input is invalid/);
    expect(() => harness.app.requestAgent("\0bad")).toThrow(/Input is invalid/);
    expect(() => harness.app.requestAgent("x".repeat(4_001))).toThrow(/Input is invalid/);
  });

  it("rejects controls without a live session", () => {
    const harness = controllerHarness(async () => fakeSession().session);
    expect(() => harness.app.sendPublicChat("hello")).toThrow(/not running/i);
    expect(() => harness.app.requestAgent("hello")).toThrow(/not running/i);
    expect(() => harness.app.runCommand("list")).toThrow(/not running/i);
  });

  it("allows bounded stopped reads through a disposable read-only adapter", async () => {
    const fake = fakeSession();
    const close = vi.fn();
    const readonly: RuntimeReadSession = {
      listMissions: vi.fn(() => [{
        id: 7,
        name: "night-watch",
        schema: "smartbot.mission/v1",
        sourceHash: "hash",
        creatorUsername: "alice",
        enabled: true,
        tsCreated: 1,
        tsUpdated: 2,
      }]),
      getMission: vi.fn(() => undefined),
      listMissionRuns: vi.fn(() => []),
      getMissionRun: vi.fn(() => undefined),
      listWorldTransactions: vi.fn(() => []),
      getWorldTransaction: vi.fn(() => undefined),
      close,
    };
    const openReadOnlySession = vi.fn(async () => readonly);
    const harness = controllerHarness(async () => fake.session, openReadOnlySession);
    await expect(harness.app.listMissions({ limit: 100 })).resolves.toHaveLength(1);
    expect(openReadOnlySession).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(fake.start).not.toHaveBeenCalled();
  });
});
