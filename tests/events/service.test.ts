import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus } from "../../src/bus/index.js";
import { createEventService } from "../../src/events/service.js";
import { getRecentEvents } from "../../src/events/store.js";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { createLogger } from "../../src/util/logger.js";

let tmp: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("event service", () => {
  it("persists triggers and routes warning notifications to the owner", () => {
    const bus = createBus();
    const notifyOwner = vi.fn();
    const service = createEventService({
      db, bus, notifyOwner, log: createLogger({ level: "error" }),
    });
    service.start();
    bus.emit("agent.trigger", {
      kind: "taskPlanFailed",
      planId: 4,
      title: "build wall",
      error: "needs stone",
    });
    bus.emit("agent.trigger", {
      kind: "taskPlanDone",
      planId: 5,
      title: "survey north",
    });
    expect(notifyOwner).toHaveBeenCalledOnce();
    expect(notifyOwner).toHaveBeenCalledWith(expect.stringMatching(
      /\[warning\].*build wall.*needs stone/,
    ));
    expect(getRecentEvents(db, {})).toMatchObject([
      { type: "task_completed", notified: false },
      { type: "task_failed", notified: true },
    ]);
    service.stop();
  });

  it("records direct world events without waking the agent", () => {
    const bus = createBus();
    const service = createEventService({
      db, bus, notifyOwner: vi.fn(), log: createLogger({ level: "error" }),
    });
    service.start();
    bus.emit("world.event", {
      type: "player_join",
      severity: "info",
      summary: "bob joined",
      details: { username: "bob" },
    });
    expect(getRecentEvents(db, { eventType: "player_join" })).toMatchObject([{
      summary: "bob joined",
      notified: false,
    }]);
    service.stop();
  });
});
