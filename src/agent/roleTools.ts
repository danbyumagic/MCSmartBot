import { z } from "zod";
import type { DB } from "../memory/db.js";
import {
  ASSIGNABLE_ROLES,
  listPlayerRoles,
  removePlayerRole,
  setPlayerRole,
} from "../permissions/roles.js";
import type { ToolDef } from "./tools.js";

const setSchema = z.object({
  username: z.string().min(1).max(16),
  role: z.union([z.enum(ASSIGNABLE_ROLES), z.literal("remove")]),
});

export function createSetPlayerRoleTool(
  db: DB,
  ownerUsername: string,
): ToolDef<z.infer<typeof setSchema>> {
  return {
    name: "setPlayerRole",
    policy: { minimumRole: "owner", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Owner-only: grant a player operator or viewer access, or remove their access. " +
      "Operators may perform safe gameplay actions; viewers are read-only.",
    inputSchema: setSchema,
    handler: async ({ username, role }) => {
      if (username.toLowerCase() === ownerUsername.toLowerCase()) {
        return {
          ok: false,
          summary: "the configured owner role cannot be changed",
          code: "INVALID_PARAMS",
          recoverable: false,
        };
      }
      if (role === "remove") {
        const changed = removePlayerRole(db, username);
        return {
          ok: true,
          summary: changed
            ? `removed bot access for ${username}`
            : `${username} did not have an assigned role`,
        };
      }
      const row = setPlayerRole(db, { username, role, grantedBy: ownerUsername });
      return {
        ok: true,
        summary: `set ${row.username} role to ${row.role}`,
      };
    },
  };
}

const listSchema = z.object({});

export function createGetPlayerRolesTool(
  db: DB,
  ownerUsername: string,
): ToolDef<z.infer<typeof listSchema>> {
  return {
    name: "getPlayerRoles",
    policy: { minimumRole: "owner", effect: "read", reversible: false, mission: "forbidden" },
    description: "Owner-only: list players currently authorized to use the bot.",
    inputSchema: listSchema,
    handler: async () => ({
      ok: true,
      summary: JSON.stringify({
        owner: ownerUsername,
        assigned: listPlayerRoles(db),
      }),
    }),
  };
}
