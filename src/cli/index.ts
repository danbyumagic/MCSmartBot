import readline from "node:readline";
import type { Logger } from "../util/logger.js";
import { parseCliCommand } from "./commands.js";

export interface CliDeps {
  /** Optional adapter logger retained for compatibility with embedding callers. */
  log?: Logger;
  /** Send a public chat message via the server's configured channel (e.g., /nc). */
  sendPublicChat: (text: string) => void;
  /** Send a private owner instruction through the AI agent. */
  requestAgent: (text: string) => void;
  /** Send a raw slash command (without leading `/`). */
  runCommand: (command: string) => void;
  /** Render the current bot status as a single-line string. */
  getStatus: () => string;
  /** Called when the operator types `quit`/`exit` or closes stdin. */
  onQuit: () => void;
}

export function startCli(deps: CliDeps): { stop: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "smbmc> " });
  rl.prompt();
  rl.on("line", (line) => {
    const cmd = parseCliCommand(line);
    switch (cmd.kind) {
      case "noop":
        break;
      case "chat":
        deps.sendPublicChat(cmd.text);
        break;
      case "agent":
        deps.requestAgent(cmd.text);
        break;
      case "command":
        deps.runCommand(cmd.command);
        break;
      case "status":
        process.stdout.write(deps.getStatus() + "\n");
        break;
      case "quit":
        deps.onQuit();
        return;
    }
    rl.prompt();
  });
  rl.on("close", () => deps.onQuit());
  return { stop: () => rl.close() };
}
