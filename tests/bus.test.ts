import { describe, it, expect, vi } from "vitest";
import { createBus, type AppEvents } from "../src/bus/index.js";

describe("Bus", () => {
  it("delivers typed events to listeners", () => {
    const bus = createBus();
    const fn = vi.fn();
    bus.on("chat", fn);
    bus.emit("chat", { from: "alice", text: "hi", whisper: false });
    expect(fn).toHaveBeenCalledWith({ from: "alice", text: "hi", whisper: false });
  });

  it("supports off()", () => {
    const bus = createBus();
    const fn = vi.fn();
    bus.on("bot.ready", fn);
    bus.off("bot.ready", fn);
    bus.emit("bot.ready", undefined);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not crash with no listeners", () => {
    const bus = createBus();
    expect(() => bus.emit("bot.ready", undefined)).not.toThrow();
  });
});
