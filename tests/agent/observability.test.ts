import { describe, expect, it } from "vitest";
import { summarizeForLog, summarizeGoal } from "../../src/agent/observability.js";

describe("agent observability summaries", () => {
  it("redacts credential-like fields at every retained level", () => {
    expect(summarizeForLog({
      item: "oak_log",
      apiKey: "sk-secret",
      nested: { authorization: "Bearer secret", count: 8 },
    })).toEqual({
      item: "oak_log",
      apiKey: "[redacted]",
      nested: { authorization: "[redacted]", count: 8 },
    });
  });

  it("bounds arrays, object fields, and deeply nested input", () => {
    const summary = summarizeForLog({
      values: Array.from({ length: 12 }, (_, index) => index),
      nested: { a: { b: { c: "hidden" } } },
    }) as Record<string, unknown>;
    expect(summary.values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, "[+4 more]"]);
    expect(summary.nested).toEqual({ a: { b: "[depth limit]" } });
  });

  it("compacts whitespace and truncates goals", () => {
    expect(summarizeGoal("  build   a chest\nnear the marker  ")).toBe(
      "build a chest near the marker",
    );
    expect(summarizeGoal("x".repeat(300))).toHaveLength(240);
    expect(summarizeGoal("x".repeat(300))).toMatch(/…$/);
  });
});
