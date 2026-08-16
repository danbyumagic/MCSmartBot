import { z } from "zod";
import type { ToolDef } from "./tools.js";
import type { SkillRunner } from "../skills/runner.js";

const runCommandSchema = z.object({
  command: z.string().min(1).max(256).describe(
    "Slash command to run on the server, with or without the leading /. " +
    "Examples: 'tp alice', '/tp alice', 'gamemode creative'."
  ),
});

export function createRunCommandTool(
  runCommand: (command: string) => Promise<string[]>,
): ToolDef<z.infer<typeof runCommandSchema>> {
  return {
    name: "runCommand",
    policy: { minimumRole: "owner", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Run a server slash command (anything starting with '/'). Use this for teleport (/tp), " +
      "gamemode changes, weather, time, give, /list, /seed, /tps, etc. The bot captures the " +
      "server's response (~750ms window) and returns it so you can see the result. Many commands " +
      "are irreversible. An explicit destructive order from the configured owner is already " +
      "authorization; execute it without asking again. If a destructive command is your proposed " +
      "means rather than the owner's explicit request, ask the owner for confirmation via `say`. " +
      "Commands run with the bot's own permission level on the server.",
    inputSchema: runCommandSchema,
    handler: async ({ command }) => {
      const cleaned = command.trim().replace(/^\/+/, "");
      if (cleaned.length === 0) {
        return { ok: false, summary: "runCommand: empty command after trimming slashes." };
      }
      const output = await runCommand(cleaned);
      if (output.length === 0) {
        return { ok: true, summary: `Ran /${cleaned} (no visible server response)` };
      }
      return { ok: true, summary: `Ran /${cleaned}:\n${output.join("\n")}` };
    },
  };
}

const stopSchema = z.object({});

export interface StopToolPlanPause {
  planId: number;
  paused: boolean;
  constructionJobId?: number;
}

export function createStopTool(
  runner: SkillRunner,
  pauseActivePlan?: () => StopToolPlanPause | undefined,
): ToolDef<z.infer<typeof stopSchema>> {
  return {
    name: "stop",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Stop the current movement or gameplay skill and pause its durable task plan when present. " +
      "Use when the owner says 'stop', 'wait', 'hold on', 'stay there', etc. " +
      "Paused task plans and construction jobs can later be resumed explicitly. " +
      "No-op if nothing is currently running.",
    inputSchema: stopSchema,
    handler: async () => {
      const active = runner.activeName();
      const plan = pauseActivePlan?.();
      if (!active && !plan) {
        return { ok: true, summary: "nothing to stop" };
      }
      if (active) runner.cancel();
      const parts: string[] = [];
      if (active) parts.push(`stopped ${active}`);
      if (plan?.paused) {
        parts.push(
          `paused task plan ${plan.planId}` +
          (plan.constructionJobId
            ? ` for construction job ${plan.constructionJobId}`
            : ""),
        );
      }
      return {
        ok: true,
        summary: parts.join("; "),
        details: plan
          ? {
              activeSkill: active,
              planId: plan.planId,
              planPaused: plan.paused,
              constructionJobId: plan.constructionJobId ?? null,
              resumeWith: plan.constructionJobId
                ? "manageConstruction resume"
                : "manageTaskPlan resume",
            }
          : { activeSkill: active },
      };
    },
  };
}
