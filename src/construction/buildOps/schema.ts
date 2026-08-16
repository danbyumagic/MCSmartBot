import { z } from "zod";
import {
  BUILDOPS_ASCII_SCHEMA,
  BUILDOPS_SCHEMA,
  type BuildAsciiDefinition,
  type BuildDefinition,
  type BuildSourceDefinition,
} from "./types.js";

const coordinate = z.number().finite().int().min(-64).max(64);
const tuple = z.tuple([coordinate, coordinate, coordinate]);
const operationName = z.string().trim().min(1).max(64);
const blockName = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^(?:minecraft:)?[A-Za-z0-9_]+$/, "must be a Minecraft block identifier without states");
const named = { name: operationName.optional() };

const put = z.object({
  op: z.literal("put"),
  ...named,
  at: tuple,
  block: blockName,
}).strict();

const box = z.object({
  op: z.literal("box"),
  ...named,
  from: tuple,
  to: tuple,
  block: blockName,
  mode: z.enum(["solid", "hollow", "outline"]).default("solid"),
}).strict();

const walls = z.object({
  op: z.literal("walls"),
  ...named,
  from: tuple,
  to: tuple,
  block: blockName,
  thickness: z.number().int().min(1).max(32).default(1),
}).strict();

const floor = z.object({
  op: z.literal("floor"),
  ...named,
  from: tuple,
  to: tuple,
  block: blockName,
}).strict();

const cylinder = z.object({
  op: z.literal("cylinder"),
  ...named,
  center: tuple,
  radius: z.number().int().min(1).max(32),
  height: z.number().int().min(1).max(129),
  block: blockName,
  mode: z.enum(["filled", "hollow"]).default("hollow"),
}).strict();

const disc = z.object({
  op: z.literal("disc"),
  ...named,
  center: tuple,
  radius: z.number().int().min(1).max(32),
  block: blockName,
}).strict();

const ring = z.object({
  op: z.literal("ring"),
  ...named,
  center: tuple,
  radius: z.number().int().min(1).max(32),
  block: blockName,
}).strict();

const punch = z.object({
  op: z.literal("punch"),
  ...named,
  from: tuple,
  to: tuple,
}).strict();

const window = z.object({
  op: z.literal("window"),
  ...named,
  from: tuple,
  to: tuple,
  block: blockName,
}).strict();

const gableRoof = z.object({
  op: z.literal("gableRoof"),
  ...named,
  from: tuple,
  to: tuple,
  ridge: z.enum(["x", "z"]).default("x"),
  block: blockName,
}).strict();

const curvedWall = z.object({
  op: z.literal("curvedWall"),
  ...named,
  center: tuple,
  radius: z.number().int().min(1).max(32),
  startAngle: z.number().finite().min(-360).max(360),
  endAngle: z.number().finite().min(-360).max(360),
  height: z.number().int().min(1).max(129),
  thickness: z.number().int().min(1).max(32).default(1),
  block: blockName,
}).strict();

const dome = z.object({
  op: z.literal("dome"),
  ...named,
  center: tuple,
  radius: z.number().int().min(1).max(32),
  block: blockName,
  mode: z.enum(["filled", "hollow"]).default("hollow"),
  thickness: z.number().int().min(1).max(32).default(1),
}).strict();

const spiralStairs = z.object({
  op: z.literal("spiralStairs"),
  ...named,
  center: tuple,
  radius: z.number().int().min(1).max(32),
  height: z.number().int().min(1).max(129),
  turns: z.number().int().min(1).max(32).default(1),
  clockwise: z.boolean().default(true),
  block: blockName,
}).strict();

const copy = z.object({
  op: z.literal("copy"),
  ...named,
  from: tuple,
  to: tuple,
  offset: tuple,
}).strict();

const rotate = z.object({
  op: z.literal("rotate"),
  ...named,
  from: tuple,
  to: tuple,
  pivot: tuple,
  quarterTurns: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
}).strict();

const mirror = z.object({
  op: z.literal("mirror"),
  ...named,
  from: tuple,
  to: tuple,
  pivot: tuple,
  axis: z.enum(["x", "z"]),
}).strict();

/** Strict v1 operation vocabulary. Unknown ops/keys are validation errors. */
export const buildOperationSchema = z.discriminatedUnion("op", [
  put,
  box,
  walls,
  floor,
  cylinder,
  disc,
  ring,
  punch,
  window,
  gableRoof,
  curvedWall,
  dome,
  spiralStairs,
  copy,
  rotate,
  mirror,
]);

/** The exact BuildOps v1 source envelope; no coercion or silent repair occurs here. */
export const buildDefinitionSchema = z.object({
  schema: z.literal(BUILDOPS_SCHEMA),
  name: z.string().trim().min(1).max(120),
  targetVersion: z.string().trim().min(1).max(64),
  ops: z.array(buildOperationSchema).min(1).max(128),
}).strict().superRefine((definition, context) => {
  const seen = new Map<string, number>();
  definition.ops.forEach((operation, index) => {
    if (operation.op === "floor" && operation.from[1] !== operation.to[1]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ops", index, "to", 1],
        message: "floor from and to must use the same y coordinate",
      });
    }
    if (!operation.name) return;
    const previous = seen.get(operation.name);
    if (previous !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ops", index, "name"],
        message: `duplicate operation name '${operation.name}' (already used by ops[${previous}])`,
      });
      return;
    }
    seen.set(operation.name, index);
  });
});

const asciiPaletteKey = z.string().regex(/^[!-~]$/, "must be one printable non-skip ASCII character");
const asciiLayer = z.object({
  y: coordinate,
  rows: z.array(z.string().min(1).max(129)).min(1).max(129),
}).strict();
const defaultSkipCharacters = new Set([" ", ".", "_", "-"]);

/**
 * Strict palette/ASCII source. Layers deliberately apply in order, including
 * repeated `y` values, so final duplicate-cell resolution is visible in the
 * shared canvas diagnostics instead of being silently discarded at parsing.
 */
export const buildAsciiDefinitionSchema = z.object({
  schema: z.literal(BUILDOPS_ASCII_SCHEMA),
  name: z.string().trim().min(1).max(120),
  targetVersion: z.string().trim().min(1).max(64),
  palette: z.record(asciiPaletteKey, blockName).refine((palette) => Object.keys(palette).length <= 128, {
    message: "palette may contain at most 128 entries",
  }),
  layers: z.array(asciiLayer).min(1).max(64),
}).strict().superRefine((definition, context) => {
  let reportedIssues = 0;
  for (const character of Object.keys(definition.palette)) {
    if (!defaultSkipCharacters.has(character)) continue;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["palette", character],
      message: `palette character '${character}' is reserved as a skip cell`,
    });
    reportedIssues++;
  }
  for (const [layerIndex, layer] of definition.layers.entries()) {
    const expectedWidth = layer.rows[0]?.length;
    for (const [rowIndex, row] of layer.rows.entries()) {
      if (row.length !== expectedWidth) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layers", layerIndex, "rows", rowIndex],
          message: `ASCII rows in layer ${layerIndex} must be rectangular (expected width ${expectedWidth})`,
        });
        reportedIssues++;
      }
      for (const [columnIndex, character] of [...row].entries()) {
        if (defaultSkipCharacters.has(character) || Object.hasOwn(definition.palette, character)) continue;
        if (reportedIssues >= 64) return;
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layers", layerIndex, "rows", rowIndex],
          message: `palette missing character '${character}' at column ${columnIndex}`,
        });
        reportedIssues++;
      }
    }
  }
});

/** Both supported BuildOps source envelopes, parsed without coercion. */
export const buildSourceSchema = z.union([buildDefinitionSchema, buildAsciiDefinitionSchema]);

export type BuildDefinitionInput = z.input<typeof buildDefinitionSchema>;
export type BuildAsciiDefinitionInput = z.input<typeof buildAsciiDefinitionSchema>;
export type BuildSourceInput = z.input<typeof buildSourceSchema>;

/** Parse and normalize defaults/trimmed strings into the immutable BuildOps v1 model. */
export function parseBuildDefinition(input: unknown): BuildDefinition {
  return buildDefinitionSchema.parse(input) as unknown as BuildDefinition;
}

export function safeParseBuildDefinition(input: unknown):
  | { readonly success: true; readonly data: BuildDefinition }
  | { readonly success: false; readonly error: z.ZodError } {
  const result = buildDefinitionSchema.safeParse(input);
  return result.success
    ? { success: true, data: result.data as unknown as BuildDefinition }
    : result;
}

export function parseBuildAsciiDefinition(input: unknown): BuildAsciiDefinition {
  return buildAsciiDefinitionSchema.parse(input) as unknown as BuildAsciiDefinition;
}

export function safeParseBuildAsciiDefinition(input: unknown):
  | { readonly success: true; readonly data: BuildAsciiDefinition }
  | { readonly success: false; readonly error: z.ZodError } {
  const result = buildAsciiDefinitionSchema.safeParse(input);
  return result.success
    ? { success: true, data: result.data as unknown as BuildAsciiDefinition }
    : result;
}

export function parseBuildSource(input: unknown): BuildSourceDefinition {
  return sourceSchemaFor(input).parse(input) as unknown as BuildSourceDefinition;
}

export function safeParseBuildSource(input: unknown):
  | { readonly success: true; readonly data: BuildSourceDefinition }
  | { readonly success: false; readonly error: z.ZodError } {
  const result = sourceSchemaFor(input).safeParse(input);
  return result.success
    ? { success: true, data: result.data as unknown as BuildSourceDefinition }
    : result;
}

function sourceSchemaFor(input: unknown) {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const schema = (input as { readonly schema?: unknown }).schema;
    if (schema === BUILDOPS_SCHEMA) return buildDefinitionSchema;
    if (schema === BUILDOPS_ASCII_SCHEMA) return buildAsciiDefinitionSchema;
  }
  return buildSourceSchema;
}
