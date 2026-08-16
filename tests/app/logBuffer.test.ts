import { describe, expect, it, vi } from "vitest";
import { createAppLogBuffer } from "../../src/app/logBuffer.js";

function input(message: string) {
  return {
    ts: 1,
    level: "info" as const,
    component: "test",
    message,
    context: { nested: { message } },
  };
}

describe("createAppLogBuffer", () => {
  it("assigns monotonic IDs and retains the newest records", () => {
    const buffer = createAppLogBuffer({ capacity: 3 });
    buffer.append(input("one"));
    buffer.append(input("two"));
    buffer.append(input("three"));
    buffer.append(input("four"));

    expect(buffer.entries()).toHaveLength(3);
    expect(buffer.entries().map((entry) => [entry.id, entry.message])).toEqual([
      [2, "two"],
      [3, "three"],
      [4, "four"],
    ]);
    expect(buffer.entries(2).map((entry) => entry.id)).toEqual([3, 4]);
  });

  it("keeps IDs monotonic across clear and protects stored context", () => {
    const buffer = createAppLogBuffer();
    const record = buffer.append(input("original"));
    record.context.nested = { message: "changed" };
    expect(buffer.entries()[0]?.context).toEqual({ nested: { message: "original" } });

    buffer.clear();
    expect(buffer.entries()).toEqual([]);
    expect(buffer.append(input("after clear")).id).toBe(2);
  });

  it("isolates subscriber errors and makes unsubscribe idempotent", () => {
    const buffer = createAppLogBuffer();
    const throwing = vi.fn(() => { throw new Error("subscriber failed"); });
    const healthy = vi.fn();
    const removeThrowing = buffer.subscribe(throwing);
    buffer.subscribe(healthy);

    expect(() => buffer.append(input("event"))).not.toThrow();
    expect(throwing).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
    removeThrowing();
    removeThrowing();
    buffer.append(input("second"));
    expect(throwing).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledTimes(2);
  });
});
