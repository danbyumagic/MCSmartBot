import { z } from "zod";
import type { Bot } from "mineflayer";
import type { ToolDef } from "./tools.js";
import { setFlightEnabled, isFlightEnabled } from "../skills/pathfinder.js";
import {
  activateFlight,
  deactivateFlight,
  gameModeAllowsFlight,
} from "../skills/flight.js";

const flightSchema = z.object({
  enabled: z.boolean().describe(
    "true to activate flight (creative double-jump behavior or /fly), false to stop flying",
  ),
});

export function createSetFlightTool(
  bot: Bot,
  runCommand: (command: string) => Promise<string[]>,
): ToolDef<z.infer<typeof flightSchema>> {
  return {
    name: "setFlight",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "forbidden" },
    description:
      "Activate or stop real three-dimensional flight. In Creative/Spectator this performs " +
      "the client flight toggle directly; otherwise it runs the server's /fly command. " +
      "When enabled, subsequent movement skills (gotoCoords, gotoPlayer, returnToBase, followPlayer) " +
      "fly through the air instead of walking around terrain. Use when the owner says 'fly to me', " +
      "'enable flight', 'land', 'fly mode on/off'. Check the server's response in the tool output " +
      "to confirm — if neither Creative flight nor /fly is available, this will fail.",
    inputSchema: flightSchema,
    handler: async ({ enabled }) => {
      if (isFlightEnabled() === enabled) {
        return {
          ok: true,
          summary: `flight already ${enabled ? "enabled" : "disabled"}`,
        };
      }
      const directFlight = gameModeAllowsFlight(bot);
      let output: string[] = [];
      if (!directFlight) {
        output = await runCommand("fly");
        const combined = output.join(" | ");
        if (/unknown command|permission|don't have|not allowed/i.test(combined)) {
          return { ok: false, summary: `flight unavailable on this server: ${combined}` };
        }

        // /fly is commonly a toggle. If its response says it landed in the
        // opposite state, toggle once more so the requested state wins.
        const opposite = enabled
          ? /flight(?: mode)? (?:disabled|off)/i
          : /flight(?: mode)? (?:enabled|on)/i;
        if (opposite.test(combined)) {
          output = await runCommand("fly");
        }
      }

      try {
        if (enabled) await activateFlight(bot, true);
        else deactivateFlight(bot);
      } catch (err) {
        setFlightEnabled(bot, false);
        return {
          ok: false,
          summary: `could not ${enabled ? "take off" : "stop flight"}: ${(err as Error).message}`,
        };
      }
      const responseLine = output.find((line) => line.trim().length > 0) ?? "";
      return {
        ok: true,
        summary: `flight ${enabled ? "enabled and airborne" : "disabled"}${responseLine ? `: ${responseLine}` : ""}`,
      };
    },
  };
}
