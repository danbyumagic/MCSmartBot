// Portions adapted from win10ogod/mc-multimodal-agent,
// test/execute-steps.test.ts @ 8d1b9dc62d5a9e99aa2b33fd50fe19ee2b920f0e.
// Copyright 2025 win10ogod. Licensed under Apache-2.0; see
// LICENSES/mc-multimodal-agent-Apache-2.0.txt. Modified by SmartBotMC:
// strict typed MissionScript validation, bounded data-only operation unions,
// canonical hashing, and no tool execution or dry-run dispatch.

import { describe, expect, it } from "vitest";
import {
  canonicalizeMissionSource,
  hashMissionSource,
  parseMissionDefinition,
  safeParseMissionDefinition,
} from "../../src/missions/schema.js";
import {
  MAX_MISSION_LOGICAL_STEPS,
  MAX_MISSION_SOURCE_BYTES,
} from "../../src/missions/types.js";

function definition(steps: unknown[] = [skillStep()]): Record<string, unknown> {
  return {
    schema: "smartbot.mission/v1",
    name: "restore-watchtower",
    limits: {
      maxLogicalSteps: 16,
      maxExpandedSteps: 32,
      maxWorldChanges: 4096,
      maxRuntimeMinutes: 60,
    },
    steps,
  };
}

function skillStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "survey",
    op: "skill",
    skill: "surveyArea",
    params: { radius: 24, center: { x: 10, y: 64, z: 10 } },
    maxAttempts: 2,
    ...overrides,
  };
}

function inlineBuildStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rebuild",
    op: "build",
    definition: {
      schema: "smartbot.build/v1",
      name: "tower",
      targetVersion: "1.21.11",
      ops: [{ op: "put", at: [0, 0, 0], block: "stone" }],
    },
    origin: [100, 64, 100],
    rotation: 90,
    maxAttempts: 3,
    ...overrides,
  };
}

describe("MissionScript v1 schema", () => {
  it("parses a bounded ordered union and applies explicit defaults", () => {
    const parsed = parseMissionDefinition(definition([
      skillStep({ maxAttempts: undefined }),
      {
        id: "remove",
        op: "clear",
        from: [100, 64, 100],
        to: [110, 78, 110],
        includeContainers: true,
      },
      inlineBuildStep({ maxAttempts: undefined, rotation: undefined }),
      {
        id: "named-build",
        op: "build",
        blueprintName: "stone-watchtower",
        origin: [100, 64, 100],
      },
    ]));

    expect(parsed.steps).toEqual([
      expect.objectContaining({ id: "survey", op: "skill", maxAttempts: 3 }),
      expect.objectContaining({ id: "remove", op: "clear", includeContainers: true, maxAttempts: 3 }),
      expect.objectContaining({ id: "rebuild", op: "build", rotation: 0, maxAttempts: 3 }),
      expect.objectContaining({ id: "named-build", op: "build", rotation: 0, maxAttempts: 3 }),
    ]);
    expect(parsed.steps[2]).toMatchObject({ definition: expect.objectContaining({ schema: "smartbot.build/v1" }) });
  });

  it("rejects unknown keys at the envelope and every logical operation", () => {
    expect(() => parseMissionDefinition({ ...definition(), extra: true })).toThrow(/unrecognized key/i);
    expect(() => parseMissionDefinition(definition([skillStep({ untrusted: true })]))).toThrow(/unrecognized key/i);
    expect(() => parseMissionDefinition(definition([{
      id: "clear", op: "clear", from: [0, 0, 0], to: [1, 1, 1], nested: { loop: true },
    }]))).toThrow(/unrecognized key/i);
  });

  it("does not coerce string limits, coordinates, or attempts into numbers", () => {
    expect(safeParseMissionDefinition({
      ...definition(),
      limits: { maxLogicalSteps: "16", maxExpandedSteps: 32, maxWorldChanges: 10, maxRuntimeMinutes: 1 },
    }).success).toBe(false);
    expect(safeParseMissionDefinition(definition([skillStep({ maxAttempts: "2" })])).success).toBe(false);
    expect(safeParseMissionDefinition(definition([{
      id: "clear", op: "clear", from: ["0", 0, 0], to: [1, 1, 1],
    }])).success).toBe(false);
  });

  it("enforces hard limits, safe unique IDs, and ordered bounded steps", () => {
    expect(safeParseMissionDefinition({
      ...definition(),
      limits: { maxLogicalSteps: 1, maxExpandedSteps: 65, maxWorldChanges: 1, maxRuntimeMinutes: 1 },
    }).success).toBe(false);
    expect(safeParseMissionDefinition({
      ...definition(),
      limits: { maxLogicalSteps: 2, maxExpandedSteps: 1, maxWorldChanges: 1, maxRuntimeMinutes: 1 },
    }).success).toBe(false);
    expect(safeParseMissionDefinition(definition([skillStep(), skillStep({ id: "survey" })])).success).toBe(false);
    expect(safeParseMissionDefinition(definition([skillStep({ id: "bad id" })])).success).toBe(false);
    const tooMany = Array.from({ length: MAX_MISSION_LOGICAL_STEPS + 1 }, (_, index) =>
      skillStep({ id: `s-${index}` }));
    expect(safeParseMissionDefinition(definition(tooMany)).success).toBe(false);
    expect(safeParseMissionDefinition({
      ...definition([skillStep({ id: "one" }), skillStep({ id: "two" })]),
      limits: { maxLogicalSteps: 1, maxExpandedSteps: 2, maxWorldChanges: 1, maxRuntimeMinutes: 1 },
    }).success).toBe(false);
  });

  it("permits exactly one build source and validates an inline BuildOps source", () => {
    expect(safeParseMissionDefinition(definition([inlineBuildStep()])).success).toBe(true);
    expect(safeParseMissionDefinition(definition([inlineBuildStep({ blueprintName: "also-present" })])).success).toBe(false);
    expect(safeParseMissionDefinition(definition([{
      id: "missing", op: "build", origin: [0, 64, 0],
    }])).success).toBe(false);
    expect(safeParseMissionDefinition(definition([inlineBuildStep({
      definition: { schema: "smartbot.build/v1", name: "bad", targetVersion: "1.21.11", ops: [] },
    })])).success).toBe(false);
  });

  it("rejects nested/meta-operation skill names and non-JSON parameter values", () => {
    expect(safeParseMissionDefinition(definition([skillStep({ skill: "execute_steps" })])).success).toBe(false);
    expect(safeParseMissionDefinition(definition([skillStep({ skill: "runMission" })])).success).toBe(false);
    expect(safeParseMissionDefinition(definition([skillStep({ params: { number: Number.NaN } })])).success).toBe(false);
    expect(safeParseMissionDefinition(definition([skillStep({ params: { matcher: /not-json/ } })])).success).toBe(false);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(safeParseMissionDefinition(definition([skillStep({ params: cyclic })])).success).toBe(false);
    let deeplyNested: unknown = "leaf";
    for (let index = 0; index < 40; index++) deeplyNested = { next: deeplyNested };
    expect(safeParseMissionDefinition(definition([skillStep({ params: { deeplyNested } })])).success).toBe(false);
  });

  it("canonicalizes equivalent source key order and default values before hashing", () => {
    const ordered = definition([{
      id: "clear", op: "clear", from: [0, 64, 0], to: [1, 64, 1], includeContainers: false, maxAttempts: 3,
    }]);
    const reordered = {
      steps: [{ to: [1, 64, 1], from: [0, 64, 0], id: "clear", op: "clear" }],
      limits: { maxRuntimeMinutes: 60, maxWorldChanges: 4096, maxExpandedSteps: 32, maxLogicalSteps: 16 },
      name: "restore-watchtower",
      schema: "smartbot.mission/v1",
    };
    const canonical = canonicalizeMissionSource(ordered);
    expect(canonical).toBe(canonicalizeMissionSource(reordered));
    expect(hashMissionSource(ordered)).toBe(hashMissionSource(reordered));
    expect(hashMissionSource(ordered)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("bounds canonical JSON even when parameter values are valid JSON", () => {
    const oversized = "x".repeat(MAX_MISSION_SOURCE_BYTES);
    expect(safeParseMissionDefinition(definition([skillStep({ params: { oversized } })])).success).toBe(false);
  });
});
