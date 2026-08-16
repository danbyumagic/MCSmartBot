// Portions adapted from win10ogod/mc-multimodal-agent,
// src/tools/MinecraftTools.ts @ 8d1b9dc62d5a9e99aa2b33fd50fe19ee2b920f0e.
// Copyright 2025 win10ogod. Licensed under Apache-2.0; see
// LICENSES/mc-multimodal-agent-Apache-2.0.txt. Modified by SmartBotMC:
// strict typed MissionScript parsing, bounded JSON-only source, BuildOps
// embedding, canonical hashing, and no execution or meta-operation dispatch.

import { createHash } from "node:crypto";
import { z } from "zod";
import { buildSourceSchema } from "../construction/buildOps/schema.js";
import type { BuildSourceDefinition } from "../construction/buildOps/types.js";
import {
  MAX_MISSION_EXPANDED_STEPS,
  MAX_MISSION_JSON_DEPTH,
  MAX_MISSION_JSON_KEY_LENGTH,
  MAX_MISSION_JSON_VALUES,
  MAX_MISSION_LOGICAL_STEPS,
  MAX_MISSION_NAME_LENGTH,
  MAX_MISSION_RUNTIME_MINUTES,
  MAX_MISSION_SOURCE_BYTES,
  MAX_MISSION_STEP_ID_LENGTH,
  MAX_MISSION_WORLD_CHANGES,
  MISSION_SCHEMA,
  type MissionDefinition,
  type MissionJsonValue,
} from "./types.js";

function safeInteger(minimum?: number, maximum?: number) {
  let schema = z.number().finite().int();
  if (minimum !== undefined) schema = schema.min(minimum);
  if (maximum !== undefined) schema = schema.max(maximum);
  return schema.refine(Number.isSafeInteger, {
    message: "must be a safe integer",
  });
}
const coordinate = safeInteger();
const coordinateTuple = z.tuple([coordinate, coordinate, coordinate]);
const maxAttempts = safeInteger(1, 10).default(3);
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0);
const stepId = z.string()
  .min(1)
  .max(MAX_MISSION_STEP_ID_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must contain only letters, digits, '_' or '-'");
const missionName = z.string().trim().min(1).max(MAX_MISSION_NAME_LENGTH);
const skillName = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must be a registered skill-style identifier");

const jsonValueSchema: z.ZodType<MissionJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));
const jsonObjectSchema = z.record(jsonValueSchema);

/** Names reserved for nested/meta orchestration, never executable MissionScript steps. */
export const FORBIDDEN_MISSION_SKILLS: ReadonlySet<string> = new Set([
  "execute_steps",
  "executesteps",
  "run_mission",
  "runmission",
  "execute_mission",
  "executemission",
  "create_task_plan",
  "createtaskplan",
  "sub_mission",
  "submission",
]);

const limitsSchema = z.object({
  maxLogicalSteps: safeInteger(1, MAX_MISSION_LOGICAL_STEPS),
  maxExpandedSteps: safeInteger(1, MAX_MISSION_EXPANDED_STEPS),
  maxWorldChanges: safeInteger(1, MAX_MISSION_WORLD_CHANGES),
  maxRuntimeMinutes: safeInteger(1, MAX_MISSION_RUNTIME_MINUTES),
}).strict().superRefine((limits, context) => {
  if (limits.maxExpandedSteps < limits.maxLogicalSteps) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxExpandedSteps"],
      message: "must be at least maxLogicalSteps",
    });
  }
});

const skillStepSchema = z.object({
  id: stepId,
  op: z.literal("skill"),
  skill: skillName,
  params: jsonObjectSchema,
  maxAttempts,
}).strict().superRefine((step, context) => {
  if (FORBIDDEN_MISSION_SKILLS.has(step.skill.replaceAll("-", "_").toLowerCase())) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["skill"],
      message: "nested or meta-operation skills are not allowed in MissionScript v1",
    });
  }
});

const clearStepSchema = z.object({
  id: stepId,
  op: z.literal("clear"),
  from: coordinateTuple,
  to: coordinateTuple,
  includeContainers: z.boolean().default(false),
  maxAttempts,
}).strict();

const namedBuildStepSchema = z.object({
  id: stepId,
  op: z.literal("build"),
  blueprintName: missionName,
  origin: coordinateTuple,
  rotation,
  maxAttempts,
}).strict();

const inlineBuildStepSchema = z.object({
  id: stepId,
  op: z.literal("build"),
  definition: buildSourceSchema,
  origin: coordinateTuple,
  rotation,
  maxAttempts,
}).strict();

/** Strict operation vocabulary: no loops, branches, recursion, or sub-missions. */
export const missionStepSchema = z.union([
  skillStepSchema,
  clearStepSchema,
  namedBuildStepSchema,
  inlineBuildStepSchema,
]);

/** The exact data-only MissionScript v1 envelope. */
export const missionDefinitionSchema = z.object({
  schema: z.literal(MISSION_SCHEMA),
  name: missionName,
  limits: limitsSchema,
  steps: z.array(missionStepSchema).min(1).max(MAX_MISSION_LOGICAL_STEPS),
}).strict().superRefine((definition, context) => {
  if (definition.steps.length > definition.limits.maxLogicalSteps) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps"],
      message: "step count may not exceed limits.maxLogicalSteps",
    });
  }
  const seen = new Map<string, number>();
  definition.steps.forEach((step, index) => {
    const earlier = seen.get(step.id);
    if (earlier !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps", index, "id"],
        message: `duplicate step id '${step.id}' (already used by steps[${earlier}])`,
      });
      return;
    }
    seen.set(step.id, index);
  });
  const bytes = new TextEncoder().encode(stableJson(definition)).byteLength;
  if (bytes > MAX_MISSION_SOURCE_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: `canonical mission source may not exceed ${MAX_MISSION_SOURCE_BYTES} bytes`,
    });
  }
});

export type MissionDefinitionInput = z.input<typeof missionDefinitionSchema>;

/** Parse, normalize defaults, and preserve the discriminated v1 operation union. */
export function parseMissionDefinition(input: unknown): MissionDefinition {
  const boundedError = missionJsonBoundaryError(input);
  if (boundedError) throw boundedError;
  return missionDefinitionSchema.parse(input) as unknown as MissionDefinition;
}

export function safeParseMissionDefinition(input: unknown):
  | { readonly success: true; readonly data: MissionDefinition }
  | { readonly success: false; readonly error: z.ZodError } {
  const boundedError = missionJsonBoundaryError(input);
  if (boundedError) return { success: false, error: boundedError };
  const result = missionDefinitionSchema.safeParse(input);
  return result.success
    ? { success: true, data: result.data as unknown as MissionDefinition }
    : result;
}

/** Canonical source bytes are stable across JSON key order and used for durable hashes. */
export function canonicalizeMissionSource(input: MissionDefinition | unknown): string {
  const definition = parseMissionDefinition(input);
  const canonical = stableJson(definition);
  const bytes = new TextEncoder().encode(canonical).byteLength;
  if (bytes > MAX_MISSION_SOURCE_BYTES) {
    throw new Error(`canonical mission source may not exceed ${MAX_MISSION_SOURCE_BYTES} bytes`);
  }
  return canonical;
}

export function hashMissionSource(input: MissionDefinition | unknown): string {
  return createHash("sha256").update(canonicalizeMissionSource(input)).digest("hex");
}

/** Reparse an inline source at the persistence boundary without widening its type. */
export function parseMissionInlineBuildSource(input: unknown): BuildSourceDefinition {
  return buildSourceSchema.parse(input) as unknown as BuildSourceDefinition;
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonical JSON cannot contain non-finite numbers");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
    }
    default:
      throw new Error("canonical JSON accepts only JSON data");
  }
}

/**
 * Do this iteratively before Zod recursively descends into `skill.params`.
 * It makes deeply nested/cyclic non-JSON values an ordinary validation error
 * rather than a validation-process stack overflow.
 */
function missionJsonBoundaryError(input: unknown): z.ZodError | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    count++;
    if (count > MAX_MISSION_JSON_VALUES) {
      return boundaryError(`MissionScript may not contain more than ${MAX_MISSION_JSON_VALUES} JSON values`);
    }
    if (current.depth > MAX_MISSION_JSON_DEPTH) {
      return boundaryError(`MissionScript JSON nesting may not exceed ${MAX_MISSION_JSON_DEPTH} levels`);
    }
    const value = current.value;
    if (value === null || typeof value === "boolean" || typeof value === "string") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return boundaryError("MissionScript may not contain non-finite numbers");
      continue;
    }
    if (typeof value !== "object") return boundaryError("MissionScript must contain JSON data only");
    if (seen.has(value)) return boundaryError("MissionScript cannot contain cyclic or shared object references");
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) {
        stack.push({ value: value[index], depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return boundaryError("MissionScript must contain plain JSON objects only");
    }
    for (const key of Object.keys(value)) {
      if (key.length > MAX_MISSION_JSON_KEY_LENGTH) {
        return boundaryError(`MissionScript JSON keys may not exceed ${MAX_MISSION_JSON_KEY_LENGTH} characters`);
      }
      const property = (value as Record<string, unknown>)[key];
      // Zod defaults intentionally support an explicitly-undefined optional
      // field from a programmatic caller. It is removed/normalized before the
      // canonical source is generated, so it is not persisted as JSON.
      if (property !== undefined) stack.push({ value: property, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function boundaryError(message: string): z.ZodError {
  return new z.ZodError([{
    code: z.ZodIssueCode.custom,
    path: [],
    message,
  }]);
}
