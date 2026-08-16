import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";

const CommandSchema = z.object({
  name: z.string().min(1).max(64).describe("Short name for the command, no slash."),
  syntax: z.string().min(1).max(256).describe("Usage syntax shown to Claude, e.g. '/home <name>'."),
  description: z.string().min(1).max(512).describe("What the command does, when to use it."),
  destructive: z.boolean().default(false).describe(
    "If true, Claude must ask the owner via `say` before calling `runCommand` with this. " +
    "Examples: /pay, /sell, /ban.",
  ),
});

const ServerConfigSchema = z.object({
  name: z.string().min(1).max(64).optional().describe("Server display name (for logs/prompt)."),
  publicChatCommand: z.string().min(1).max(32).optional().describe(
    "Slash command prefix for `sayPublic`. E.g. 'nc' makes the bot send /nc <text>. " +
    "Omit for vanilla public chat.",
  ),
  commands: z.array(CommandSchema).default([]),
  notes: z.array(z.string().min(1).max(512)).default([]).describe(
    "Free-form notes about server quirks Claude should know (chat format peculiarities, " +
    "plugin behaviors, etc.). Each entry becomes a separate line in the system prompt.",
  ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ServerCommand = z.infer<typeof CommandSchema>;

/** Empty config used when no server.json file exists. */
export const EMPTY_SERVER_CONFIG: ServerConfig = {
  commands: [],
  notes: [],
};

export function parseServerConfig(json: unknown): ServerConfig {
  return ServerConfigSchema.parse(json);
}

/**
 * Load server config from a file. Returns EMPTY_SERVER_CONFIG if the file doesn't
 * exist (so the bot is usable out of the box). Throws on malformed JSON or invalid
 * schema — startup should fail fast on a broken config.
 */
export function loadServerConfig(path: string): ServerConfig {
  if (!existsSync(path)) return EMPTY_SERVER_CONFIG;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`failed to read server config at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`server config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = ServerConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`server config at ${path} failed validation: ${issues}`);
  }
  return result.data;
}
