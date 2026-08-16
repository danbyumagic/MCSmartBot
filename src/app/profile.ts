import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { loadConfig, type Config } from "../config.js";
import {
  EMPTY_SERVER_CONFIG,
  loadServerConfig,
  type ServerConfig,
} from "../config/serverConfig.js";
import type { AgentProvider } from "../agent/provider.js";

export interface RuntimeProfile {
  envPath: string;
  rootDir: string;
  config: Config;
  serverConfig: ServerConfig;
  serverConfigPath: string;
}

export interface RuntimeProfileSummary {
  configured: boolean;
  displayPath: string | null;
  serverHost: string | null;
  serverPort: number | null;
  serverVersion: string | null;
  serverLabel: string | null;
  botUsername: string | null;
  botAuth: "offline" | "microsoft" | null;
  ownerUsername: string | null;
  agentProvider: AgentProvider | null;
  /** Display-only model metadata; never contains a credential. */
  agentModel?: string | null;
  agentApiKeyConfigured?: boolean;
}

export function loadRuntimeProfile(options: {
  envPath: string;
  processEnv?: NodeJS.ProcessEnv;
}): RuntimeProfile {
  const envPath = resolve(options.envPath);
  const rootDir = dirname(envPath);
  let contents: string;
  try {
    contents = readFileSync(envPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`runtime profile file not found: ${envPath}`);
    }
    throw new Error(`could not read runtime profile: ${envPath}`);
  }

  const fileValues = parseProfileContents(contents, envPath);
  const processValues = options.processEnv ?? process.env;
  const merged: Record<string, string | undefined> = {
    ...fileValues,
    ...processValues,
  };
  const config = loadConfig(merged);
  const dataDir = isAbsolute(config.dataDir)
    ? config.dataDir
    : resolve(rootDir, config.dataDir);
  const resolvedConfig: Config = { ...config, dataDir };
  const serverConfigPath = join(rootDir, "server.json");
  const serverConfig = loadServerConfig(serverConfigPath);

  return {
    envPath,
    rootDir,
    config: resolvedConfig,
    serverConfig,
    serverConfigPath,
  };
}

export function summarizeRuntimeProfile(
  profile: RuntimeProfile | null,
): RuntimeProfileSummary {
  if (!profile) {
    return {
      configured: false,
      displayPath: null,
      serverHost: null,
      serverPort: null,
      serverVersion: null,
      serverLabel: null,
      botUsername: null,
      botAuth: null,
      ownerUsername: null,
      agentProvider: null,
      agentModel: null,
      agentApiKeyConfigured: false,
    };
  }
  return {
    configured: true,
    displayPath: profile.envPath,
    serverHost: profile.config.serverHost,
    serverPort: profile.config.serverPort,
    serverVersion: profile.config.serverVersion,
    serverLabel: profile.serverConfig.name ?? null,
    botUsername: profile.config.botUsername,
    botAuth: profile.config.botAuth,
    ownerUsername: profile.config.ownerUsername,
    agentProvider: profile.config.agentProvider,
    agentModel: profile.config.agentModel ?? null,
    agentApiKeyConfigured: Boolean(profile.config.agentApiKey),
  };
}

export const EMPTY_RUNTIME_PROFILE_SUMMARY: RuntimeProfileSummary =
  summarizeRuntimeProfile(null);

export { EMPTY_SERVER_CONFIG };

/**
 * Read either the legacy dotenv profile or the safer structured profile.
 *
 * JSON profiles are useful for the desktop and for machines that do not want
 * to keep an `.env` file. Secrets are still treated as sensitive local data;
 * the loader never includes them in profile summaries or logs. Both a flat
 * env-like object and a small nested document are accepted so migration does
 * not require a specific editor.
 */
function parseProfileContents(
  contents: string,
  profilePath: string,
): Record<string, string> {
  if (extname(profilePath).toLowerCase() !== ".json" && !contents.trimStart().startsWith("{")) {
    return parseDotenv(contents);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`could not parse runtime profile: ${profilePath}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`runtime profile must be a JSON object: ${profilePath}`);
  }
  return flattenJsonProfile(parsed);
}

function flattenJsonProfile(document: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  const assign = (key: string, value: unknown): void => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      values[key] = String(value);
    }
  };
  const assignObject = (value: unknown, prefix: string): void => {
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      assign(`${prefix ? `${prefix}_` : ""}${camelToSnake(key)}`, item);
    }
  };

  // Flat uppercase documents can be generated from `.env` with no changes.
  for (const [key, value] of Object.entries(document)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) assign(key, value);
  }

  const server = document.server;
  if (isRecord(server)) {
    assign("SERVER_HOST", server.host);
    assign("SERVER_PORT", server.port);
    assign("SERVER_VERSION", server.version);
  }
  const minecraft = document.minecraft;
  if (isRecord(minecraft)) {
    assign("BOT_USERNAME", minecraft.username);
    assign("BOT_AUTH", minecraft.auth);
  }
  if (typeof document.ownerUsername === "string") assign("OWNER_USERNAME", document.ownerUsername);
  else if (typeof document.owner === "string") assign("OWNER_USERNAME", document.owner);
  else if (isRecord(document.owner)) assign("OWNER_USERNAME", document.owner.username);

  const agent = document.agent;
  if (typeof agent === "string") assign("AGENT_PROVIDER", agent);
  else if (isRecord(agent)) {
    assign("AGENT_PROVIDER", agent.provider);
    assign("AGENT_API_KEY", agent.apiKey ?? agent.openrouterApiKey);
    assign("AGENT_MODEL", agent.model);
    assign("AGENT_BASE_URL", agent.baseUrl);
    assign("OPENROUTER_HTTP_REFERER", agent.httpReferer);
    assign("CODEX_EXECUTABLE", agent.codexExecutable);
    assign("CLAUDE_CODE_EXECUTABLE", agent.claudeCodeExecutable);
  }

  for (const section of ["runtime", "settings", "bot"] as const) {
    assignObject(document[section], "");
  }
  if (isRecord(document.bot)) {
    assign("BOT_USERNAME", document.bot.username);
    assign("BOT_AUTH", document.bot.auth);
  }
  for (const [key, value] of Object.entries(document)) {
    if (key === "server" || key === "minecraft" || key === "owner" ||
        key === "ownerUsername" || key === "agent" || key === "runtime" ||
        key === "settings" || key === "bot" || key === "version") continue;
    if (/^[a-z]/.test(key)) {
      assign(key === "apiKey" ? "AGENT_API_KEY" : camelToSnake(key), value);
    }
  }
  return values;
}

function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
