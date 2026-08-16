import { describe, it, expect } from "vitest";
import { createLogger } from "../src/util/logger.js";

describe("createLogger", () => {
  it("creates a logger with the configured level", () => {
    const log = createLogger({ level: "warn" });
    expect(log.level).toBe("warn");
  });

  it("child loggers inherit and can add bindings", () => {
    const log = createLogger({ level: "info" });
    const child = log.child({ component: "bot" });
    expect(child.bindings()).toMatchObject({ component: "bot" });
  });

  it("captures sanitized structured records from child loggers", () => {
    const records: Array<Record<string, unknown>> = [];
    const log = createLogger({
      level: "info",
      pretty: false,
      onRecord: (record) => records.push(record as unknown as Record<string, unknown>),
    });
    const error = new Error("boom");
    log.child({ component: "bot" }).info({ error, token: "secret-value", bigint: 2n }, "hello");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "info",
      component: "bot",
      message: "hello",
      context: {
        error: { name: "Error", message: "boom" },
        token: "[redacted]",
        bigint: "2n",
      },
    });
    expect(JSON.stringify(records[0])).not.toContain("stack");
  });

  it("does not let a throwing capture callback break logging", () => {
    const log = createLogger({
      level: "info",
      pretty: false,
      onRecord: () => { throw new Error("capture failed"); },
    });
    expect(() => log.info("still works")).not.toThrow();
  });
});
