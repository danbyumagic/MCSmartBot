import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { setGoal } from "../../src/memory/goals.js";
import { createBus } from "../../src/bus/index.js";
import { createLogger } from "../../src/util/logger.js";
import { startIdleTicker, bumpActivity } from "../../src/agent/idleTick.js";
import type { SkillRunner } from "../../src/skills/runner.js";

const log = createLogger({ level: "error" });

function makeRunner(active: string | null): SkillRunner {
  return {
    run: vi.fn(),
    cancel: vi.fn(),
    restart: vi.fn(),
    activeName: () => active,
  } as unknown as SkillRunner;
}

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("idleTick", () => {
  it("fires when idle threshold elapses AND a goal is open AND no skill active", () => {
    setGoal(db, { text: "keep me supplied with iron", createdBy: "owner" });
    let nowMs = 1_000_000;
    const fakeNow = () => nowMs;
    const lastActivityAt = { value: nowMs };
    const bus = createBus();
    const events: Array<{ kind: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const ticker = startIdleTicker({
      db,
      bus,
      log,
      runner: makeRunner(null),
      intervalMinutes: 1,
      lastActivityAt,
      now: fakeNow,
    });

    // Advance fake time well past the threshold.
    nowMs += 120_000;
    vi.advanceTimersByTime(60_000);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("idleTick");
    ticker.stop();
  });

  it("does not fire when a skill is active", () => {
    setGoal(db, { text: "x", createdBy: "owner" });
    let nowMs = 1_000_000;
    const lastActivityAt = { value: nowMs };
    const bus = createBus();
    const events: Array<{ kind: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const ticker = startIdleTicker({
      db,
      bus,
      log,
      runner: makeRunner("gotoCoords"),
      intervalMinutes: 1,
      lastActivityAt,
      now: () => nowMs,
    });
    nowMs += 120_000;
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual([]);
    ticker.stop();
  });

  it("does not fire when no goal is open", () => {
    let nowMs = 1_000_000;
    const lastActivityAt = { value: nowMs };
    const bus = createBus();
    const events: Array<{ kind: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const ticker = startIdleTicker({
      db,
      bus,
      log,
      runner: makeRunner(null),
      intervalMinutes: 1,
      lastActivityAt,
      now: () => nowMs,
    });
    nowMs += 120_000;
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual([]);
    ticker.stop();
  });

  it("does not fire before the idle threshold elapses", () => {
    setGoal(db, { text: "x", createdBy: "owner" });
    let nowMs = 1_000_000;
    const lastActivityAt = { value: nowMs };
    const bus = createBus();
    const events: Array<{ kind: string }> = [];
    bus.on("agent.trigger", (t) => events.push(t as { kind: string }));
    const ticker = startIdleTicker({
      db,
      bus,
      log,
      runner: makeRunner(null),
      intervalMinutes: 5,
      lastActivityAt,
      now: () => nowMs,
    });
    nowMs += 60_000; // only 1 minute, threshold is 5
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual([]);
    ticker.stop();
  });

  it("bumpActivity updates the shared state", () => {
    const state = { value: 0 };
    bumpActivity(state, () => 123456);
    expect(state.value).toBe(123456);
  });
});
