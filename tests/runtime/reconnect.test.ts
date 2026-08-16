import { describe, expect, it, vi } from "vitest";
import { createReconnectSupervisor } from "../../src/runtime/reconnect.js";
import { createLogger } from "../../src/util/logger.js";
import type { ConnectionRuntimeHooks } from "../../src/runtime/connection.js";

describe("reconnect supervisor", () => {
  it("reconnects with exponential backoff and resets after ready", () => {
    const hooks: ConnectionRuntimeHooks[] = [];
    const timers: Array<{ fn: () => void; delay: number }> = [];
    const connect = vi.fn((connectionHooks: ConnectionRuntimeHooks) => {
      hooks.push(connectionHooks);
      return {
        sendPublicChat: vi.fn(),
        requestAgent: vi.fn(),
        runCommand: vi.fn(),
        getStatus: () => "connecting",
        getLiveState: vi.fn(),
        emergencyStop: vi.fn(),
        stop: vi.fn(),
      };
    });
    const supervisor = createReconnectSupervisor({
      log: createLogger({ level: "error" }),
      connect,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      setTimer: ((fn: () => void, delay: number) => {
        timers.push({ fn, delay });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: vi.fn() as unknown as typeof clearTimeout,
    });

    supervisor.start();
    hooks[0]!.onEnd("lost");
    expect(timers[0]?.delay).toBe(1_000);
    expect(supervisor.attempts()).toBe(1);
    timers[0]!.fn();
    expect(connect).toHaveBeenCalledTimes(2);

    hooks[1]!.onEnd("still down");
    expect(timers[1]?.delay).toBe(2_000);
    timers[1]!.fn();
    hooks[2]!.onReady();
    expect(supervisor.attempts()).toBe(0);
    hooks[2]!.onEnd("later outage");
    expect(timers[2]?.delay).toBe(1_000);
  });

  it("ignores late connection events after shutdown", () => {
    let hooks!: ConnectionRuntimeHooks;
    const stop = vi.fn();
    const supervisor = createReconnectSupervisor({
      log: createLogger({ level: "error" }),
      connect: (value) => {
        hooks = value;
        return {
          sendPublicChat: vi.fn(),
          requestAgent: vi.fn(),
          runCommand: vi.fn(),
          getStatus: () => "x",
          getLiveState: vi.fn(),
          emergencyStop: vi.fn(),
          stop,
        };
      },
      jitterRatio: 0,
    });
    supervisor.start();
    supervisor.stop("test");
    expect(stop).toHaveBeenCalledWith("test");
    hooks.onEnd("late event");
    expect(supervisor.current()).toBeNull();
  });
});
