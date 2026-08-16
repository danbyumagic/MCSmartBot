import { describe, it, expect } from "vitest";
import { createTriggerSourceState, sourceFromTrigger } from "../../src/agent/triggerSource.js";

describe("triggerSource", () => {
  it("createTriggerSourceState defaults to observation", () => {
    expect(createTriggerSourceState().current).toBe("observation");
  });

  it("sourceFromTrigger maps chat → chat", () => {
    expect(sourceFromTrigger({ kind: "chat", from: "alice", text: "x" })).toBe("chat");
  });

  it("sourceFromTrigger maps cli → cli", () => {
    expect(sourceFromTrigger({ kind: "cli", text: "x" })).toBe("cli");
  });

  it("sourceFromTrigger maps system observations → observation", () => {
    expect(sourceFromTrigger({ kind: "skillDone", skill: "x", ok: true, summary: "" })).toBe("observation");
    expect(sourceFromTrigger({
      kind: "skillFailed", skill: "x", error: "", code: "UNKNOWN", recoverable: false,
    })).toBe("observation");
    expect(sourceFromTrigger({ kind: "reflexAlert", summary: "x" })).toBe("observation");
    expect(sourceFromTrigger({ kind: "taskPlanDone", planId: 1, title: "x" })).toBe("observation");
    expect(sourceFromTrigger({
      kind: "taskPlanFailed", planId: 1, title: "x", error: "boom",
    })).toBe("observation");
    expect(sourceFromTrigger({ kind: "idleTick" })).toBe("observation");
  });
});
