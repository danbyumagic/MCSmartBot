/**
 * CLI command parser. The terminal is the operator's direct line to the bot:
 *
 * - Plain text (default)  → bot sends it as a public chat message.
 * - "ask <instruction>"   → send a private owner instruction to the AI agent.
 * - "/<command>"          → bot runs a slash command on the server.
 * - "quit" or "exit"      → shut down.
 * - "status"              → print bot state once.
 *
 * The reserved keywords (`quit`, `exit`, `status`) take precedence over public
 * chat. To literally chat the word "quit", prefix with a space (the parser
 * trims, so " quit" still hits the reserved branch — but you can chat "quit "
 * with no leading space won't help either; just say "quitting" or similar).
 */
export type CliCommand =
  | { kind: "noop" }
  | { kind: "chat"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "command"; command: string }
  | { kind: "status" }
  | { kind: "quit" };

export function parseCliCommand(line: string): CliCommand {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "noop" };

  if (trimmed === "quit" || trimmed === "exit") return { kind: "quit" };
  if (trimmed === "status") return { kind: "status" };
  if (trimmed.toLowerCase().startsWith("ask ")) {
    const text = trimmed.slice(4).trim();
    return text.length > 0 ? { kind: "agent", text } : { kind: "noop" };
  }

  if (trimmed.startsWith("/")) {
    const command = trimmed.slice(1).trim();
    if (command.length === 0) return { kind: "noop" };
    return { kind: "command", command };
  }

  return { kind: "chat", text: trimmed };
}
