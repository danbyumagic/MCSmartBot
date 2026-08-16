import { z } from "zod";
import type { DB } from "../memory/db.js";
import {
  getInventoryPolicy,
  upsertInventoryPolicy,
} from "../memory/inventoryPolicies.js";
import type { ToolDef } from "./tools.js";

const setPolicySchema = z.object({
  name: z.string().min(1).max(64).default("default"),
  alwaysCarry: z.record(
    z.string().min(1).max(64),
    z.number().int().min(0).max(256),
  ).describe("Exact item names mapped to minimum inventory counts"),
  preferredStorage: z.string().min(1).max(64).optional(),
});

export function createSetInventoryPolicyTool(
  db: DB,
): ToolDef<z.infer<typeof setPolicySchema>> {
  return {
    name: "setInventoryPolicy",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Create or replace a durable inventory restock policy. " +
      "Use for lasting instructions such as always carrying food or torches.",
    inputSchema: setPolicySchema,
    handler: async ({ name, alwaysCarry, preferredStorage }) => {
      const invalid = Object.entries(alwaysCarry).find(([item]) => item.trim().length === 0);
      if (invalid) {
        return { ok: false, summary: "inventory policy contains an empty item name" };
      }
      const row = upsertInventoryPolicy(db, { name, alwaysCarry, preferredStorage });
      return {
        ok: true,
        summary: `saved inventory policy '${row.name}' with ${Object.keys(row.alwaysCarry).length} minimums`,
      };
    },
  };
}

const getPolicySchema = z.object({
  name: z.string().min(1).max(64).default("default"),
});

export function createGetInventoryPolicyTool(
  db: DB,
): ToolDef<z.infer<typeof getPolicySchema>> {
  return {
    name: "getInventoryPolicy",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description: "Read a durable inventory restock policy by name.",
    inputSchema: getPolicySchema,
    handler: async ({ name }) => {
      const policy = getInventoryPolicy(db, name);
      if (!policy) return { ok: true, summary: `no inventory policy named '${name}'` };
      return {
        ok: true,
        summary: `inventory policy '${name}': ${JSON.stringify({
          alwaysCarry: policy.alwaysCarry,
          preferredStorage: policy.preferredStorage ?? null,
        })}`,
      };
    },
  };
}
