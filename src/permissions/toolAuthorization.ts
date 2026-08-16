import type { ToolDef } from "../agent/tools.js";
import type { ActorContext, PlayerRole } from "./roles.js";
import {
  cloneCapabilityPolicy,
  roleSatisfies,
  type CapabilityPolicy,
} from "./capabilities.js";

export function canUseTool(role: PlayerRole, policy: CapabilityPolicy): boolean {
  return roleSatisfies(role, policy);
}

export function authorizeTool<I>(
  tool: ToolDef<I>,
  actor: ActorContext,
): ToolDef<I> {
  const policy = cloneCapabilityPolicy(tool.policy);
  return {
    ...tool,
    policy,
    handler: async (input) => {
      if (!canUseTool(actor.role, policy)) {
        return {
          ok: false,
          summary: `${actor.role} '${actor.username}' is not allowed to use ${tool.name}`,
          code: "PERMISSION_DENIED",
          recoverable: false,
          details: {
            username: actor.username,
            role: actor.role,
            tool: tool.name,
            minimumRole: policy.minimumRole,
            effect: policy.effect,
          },
        };
      }
      return tool.handler(input);
    },
  };
}
