import { z } from "zod";
import type { DB } from "../memory/db.js";
import type { ToolDef } from "./tools.js";
import { appendFact } from "../memory/facts.js";
import type { FactSource } from "../memory/facts.js";
import { upsertLocation } from "../memory/locations.js";
import { setGoal, clearOpenGoal } from "../memory/goals.js";
import { recall } from "../memory/recall.js";

const rememberFactSchema = z.object({
  topic: z.string().min(1).max(64).describe("Short tag like 'iron' or 'preferences' or 'player:steve'"),
  text: z.string().min(1).max(512).describe("The fact itself, in your own words"),
});

export function createRememberFactTool(
  db: DB,
  getCurrentSource: () => FactSource = () => "observation",
): ToolDef<z.infer<typeof rememberFactSchema>> {
  return {
    name: "rememberFact",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Save a free-form fact under a short topic tag for later recall. " +
      "Use for preferences, observations, player notes, status, etc. " +
      "Pair related facts under the same topic.",
    inputSchema: rememberFactSchema,
    handler: async ({ topic, text }) => {
      appendFact(db, { topic, text, source: getCurrentSource() });
      return { ok: true, summary: `Remembered fact (topic=${topic}).` };
    },
  };
}

const rememberLocationSchema = z.object({
  name: z.string().min(1).max(64).describe("Short unique name like 'base' or 'iron_vein_north'"),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  dimension: z.string().min(1).max(32).default("overworld"),
  notes: z.string().max(256).default(""),
});

export function createRememberLocationTool(db: DB): ToolDef<z.infer<typeof rememberLocationSchema>> {
  return {
    name: "rememberLocation",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Save a named place (x, y, z) for later recall and use with returnToBase-style skills. " +
      "Names are unique — re-using a name overwrites the prior entry. " +
      "Use 'base' for the owner's main hideout. Optional `notes` are searchable via `recall`.",
    inputSchema: rememberLocationSchema,
    handler: async ({ name, x, y, z, dimension, notes }) => {
      upsertLocation(db, {
        name,
        x,
        y,
        z,
        dimension,
        notes: notes.length > 0 ? notes : undefined,
      });
      return { ok: true, summary: `Remembered location '${name}' at (${x}, ${y}, ${z}).` };
    },
  };
}

const recallSchema = z.object({
  query: z.string().min(1).max(128).describe("Free-form keywords to search facts and location notes for."),
  limit: z.number().int().min(1).max(20).default(5),
});

export function createRecallTool(db: DB): ToolDef<z.infer<typeof recallSchema>> {
  return {
    name: "recall",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description:
      "Search saved facts and locations by keyword. Returns up to `limit` matches as a formatted list. " +
      "Use this before deciding when the owner's question references something they might have told you earlier.",
    inputSchema: recallSchema,
    handler: async ({ query, limit }) => {
      const hits = recall(db, query, limit);
      if (hits.length === 0) {
        return { ok: true, summary: `No matches for "${query}".` };
      }
      const lines = hits.map((h) => `- [${h.kind}] ${h.topic}: ${h.text}`);
      return { ok: true, summary: `Recall hits for "${query}":\n${lines.join("\n")}` };
    },
  };
}

const setGoalSchema = z.object({
  text: z.string().min(0).max(256).default("").describe("The new goal text. Leave empty (or omit) and pass clear:true to cancel instead."),
  clear: z.boolean().default(false).describe("Pass true to cancel the current open goal without setting a new one."),
});

export function createSetGoalTool(db: DB): ToolDef<z.infer<typeof setGoalSchema>> {
  return {
    name: "setGoal",
    policy: { minimumRole: "owner", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Set or clear the bot's current high-level goal. Provide `text` to record a new goal (any prior open goal " +
      "is marked done). Pass `clear: true` to cancel the current open goal without setting a new one. " +
      "Setting a goal does NOT make the bot act on its own — it's a memory aid for context.",
    inputSchema: setGoalSchema,
    handler: async ({ text, clear }) => {
      if (clear) {
        const cancelled = clearOpenGoal(db);
        return {
          ok: true,
          summary: cancelled ? `Cleared open goal: ${cancelled.text}` : "No open goal to clear.",
        };
      }
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        const goal = setGoal(db, { text: trimmed, createdBy: "agent" });
        return { ok: true, summary: `Set goal: ${goal.text}` };
      }
      return { ok: false, summary: "setGoal: provide either non-empty `text` or `clear: true`." };
    },
  };
}
