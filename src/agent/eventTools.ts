import { z } from "zod";
import {
  EVENT_SEVERITIES,
  getRecentEvents,
  listNotificationRules,
  setNotificationRule,
} from "../events/store.js";
import type { DB } from "../memory/db.js";
import type { ToolDef } from "./tools.js";

const recentSchema = z.object({
  eventType: z.string().min(1).max(64).optional(),
  minSeverity: z.enum(EVENT_SEVERITIES).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export function createGetRecentEventsTool(
  db: DB,
): ToolDef<z.infer<typeof recentSchema>> {
  return {
    name: "getRecentEvents",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description:
      "Read persistent recent bot, task, safety, connection, and player-presence events.",
    inputSchema: recentSchema,
    handler: async (input) => {
      const rows = getRecentEvents(db, input);
      return {
        ok: true,
        summary: JSON.stringify({
          count: rows.length,
          events: rows.map((row) => ({
            id: row.id,
            ts: row.ts,
            type: row.type,
            severity: row.severity,
            summary: row.summary,
            notified: row.notified,
            details: row.details,
          })),
        }),
      };
    },
  };
}

const setRuleSchema = z.object({
  eventType: z.string().min(1).max(64).regex(/^[a-z0-9_*.-]+$/),
  minSeverity: z.enum(EVENT_SEVERITIES).default("warning"),
  enabled: z.boolean().default(true),
});

export function createSetNotificationRuleTool(
  db: DB,
): ToolDef<z.infer<typeof setRuleSchema>> {
  return {
    name: "setNotificationRule",
    policy: { minimumRole: "owner", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Owner-only: enable disable or set the minimum severity for private event notifications. " +
      "Use eventType '*' as the fallback rule.",
    inputSchema: setRuleSchema,
    handler: async (input) => {
      const row = setNotificationRule(db, input);
      return {
        ok: true,
        summary: `${row.enabled ? "enabled" : "disabled"} ${row.eventType} notifications ` +
          `at ${row.minSeverity} or higher`,
      };
    },
  };
}

const rulesSchema = z.object({});

export function createGetNotificationRulesTool(
  db: DB,
): ToolDef<z.infer<typeof rulesSchema>> {
  return {
    name: "getNotificationRules",
    policy: { minimumRole: "owner", effect: "read", reversible: false, mission: "forbidden" },
    description: "Owner-only: list event notification rules and severity thresholds.",
    inputSchema: rulesSchema,
    handler: async () => ({
      ok: true,
      summary: JSON.stringify({ rules: listNotificationRules(db) }),
    }),
  };
}
