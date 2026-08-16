import { z } from "zod";
import type { DB } from "../../memory/db.js";
import { getInventoryPolicy } from "../../memory/inventoryPolicies.js";
import { defineSkill, type SkillDefinition } from "../types.js";
import { retrieveItem } from "./retrieveItem.js";

const params = z.object({
  policyName: z.string().min(1).max(64).default("default"),
});

export function restockInventory(db: DB): SkillDefinition<z.infer<typeof params>> {
  const retrieve = retrieveItem(db);
  return defineSkill({
    name: "restockInventory",
    policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
    description:
      "Apply a saved inventory policy by retrieving each item below its minimum from indexed storage.",
    params,
    async run({ policyName }, ctx) {
      const policy = getInventoryPolicy(db, policyName);
      if (!policy) {
        return {
          ok: false, summary: `no inventory policy named '${policyName}'`,
          code: "NOT_CONFIGURED", recoverable: true, details: { policyName },
        };
      }

      const completed: Array<{ item: string; target: number }> = [];
      const failures: Array<{ item: string; target: number; code?: string; summary: string }> = [];
      for (const [item, target] of Object.entries(policy.alwaysCarry)) {
        if (target <= 0) continue;
        if (ctx.signal.aborted) {
          return {
            ok: false, summary: `restockInventory cancelled after ${completed.length} items`,
            code: "INTERRUPTED", recoverable: true,
            details: { policyName, completed, failures },
          };
        }
        const result = await retrieve.run({
          item,
          quantity: target,
          chestName: policy.preferredStorage,
        }, ctx);
        if (result.ok) completed.push({ item, target });
        else failures.push({ item, target, code: result.code, summary: result.summary });
      }

      if (failures.length > 0) {
        return {
          ok: false,
          summary: `restocked ${completed.length} items but ${failures.length} minimums remain unmet`,
          code: "NO_MATERIAL",
          recoverable: true,
          details: { policyName, completed, failures },
        };
      }
      return {
        ok: true,
        summary: `inventory policy '${policyName}' satisfied (${completed.length} minimums)`,
        data: { policyName, completed },
      };
    },
  });
}
