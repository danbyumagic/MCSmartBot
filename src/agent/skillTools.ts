import type { ToolDef } from "./tools.js";
import type { SkillDefinition } from "../skills/types.js";
import type { SkillRunner } from "../skills/runner.js";
import { cloneCapabilityPolicy } from "../permissions/capabilities.js";
import {
  snapshotSkillExecutionContext,
  type ExecutionActor,
} from "../permissions/executionActor.js";

export function createSkillTool<P>(
  skill: SkillDefinition<P>,
  runner: SkillRunner,
  actorProvider: () => ExecutionActor,
): ToolDef<P> {
  return {
    name: skill.name,
    description: skill.description,
    policy: cloneCapabilityPolicy(skill.policy),
    inputSchema: skill.params,
    handler: async (input: P) => {
      // Snapshot at the tool boundary, rather than retaining the mutable
      // session ActorContext while a skill is in flight.
      const execution = snapshotSkillExecutionContext({ actor: actorProvider() });
      const result = await runner.run(skill, input, { execution });
      return {
        ok: result.ok,
        summary: result.summary,
        code: result.code,
        recoverable: result.recoverable,
        details: result.details,
      };
    },
  };
}
