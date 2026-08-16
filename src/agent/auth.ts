import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AgentProvider } from "./provider.js";

const execFileAsync = promisify(execFile);

export type ExecResult = { stdout: string; stderr: string; code: number };

/** Kept as a source-compatible type for callers that only need a command stub. */
export type ExecFn = (cmd: string) => Promise<ExecResult>;

export type ExecFileFn = (
  executable: string,
  args: readonly string[],
) => Promise<ExecResult>;

export interface ClaudeAuthOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  run?: ExecFileFn;
  /** Test-only fallback injection; production uses the platform candidates below. */
  fallbackCandidates?: string[];
}

export interface CodexAuthOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  run?: ExecFileFn;
  /** Test-only fallback injection; production uses the platform candidates below. */
  fallbackCandidates?: string[];
}

export interface AgentSubscriptionAuthOptions {
  provider: AgentProvider;
  claude?: ClaudeAuthOptions;
  codex?: CodexAuthOptions;
  openrouter?: OpenRouterAuthOptions;
}

export interface ResolvedAgentProvider {
  provider: AgentProvider;
  executable?: string;
  /** API credentials are returned only to the in-process provider adapter. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  httpReferer?: string;
}

export interface OpenRouterAuthOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  httpReferer?: string;
  env?: NodeJS.ProcessEnv;
}

export const defaultExecFile: ExecFileFn = async (executable, args) => {
  try {
    const result = await execFileAsync(executable, [...args], {
      timeout: 10_000,
      maxBuffer: 1_000_000,
      env: withExecutableOnPath(executable),
    });
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const value = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
    };
    return {
      stdout: String(value.stdout ?? ""),
      stderr: String(value.stderr ?? ""),
      code: typeof value.code === "number" ? value.code : 1,
    };
  }
};

export function resolveClaudeExecutable(options: ClaudeAuthOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const home = options.homeDir ?? homedir();

  if (options.configuredPath !== undefined) {
    if (!isAbsolute(options.configuredPath)) {
      throw new Error("CLAUDE_CODE_EXECUTABLE must be an absolute path");
    }
    const configured = validateCandidate(options.configuredPath);
    if (!configured) {
      throw new Error("configured Claude executable was not found or is not executable");
    }
    return configured;
  }

  const pathEntries = (environment.PATH ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean);
  const pathNames = platform === "win32"
    ? ["claude", "claude.exe", "claude.cmd"]
    : ["claude"];
  for (const directory of pathEntries) {
    for (const name of pathNames) {
      const found = validateCandidate(join(directory, name));
      if (found) return found;
    }
  }

  const fallbackCandidates = options.fallbackCandidates ?? (
    platform === "darwin"
      ? [
          join(home, ".local", "bin", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
          join(home, ".claude", "local", "claude"),
        ]
      : []
  );
  for (const candidate of fallbackCandidates) {
    const found = validateCandidate(candidate);
    if (found) return found;
  }

  throw new Error(
    "Claude Code was not found. Install it or set CLAUDE_CODE_EXECUTABLE to an absolute path.",
  );
}

export async function verifySubscriptionAuth(
  options: ClaudeAuthOptions = {},
): Promise<string> {
  const executable = resolveClaudeExecutable(options);
  const run = options.run ?? defaultExecFile;
  const version = await run(executable, ["--version"]);
  if (version.code !== 0) {
    throw new Error("Claude Code could not be started. Install it and run it once to sign in.");
  }

  const candidates: readonly (readonly string[])[] = [
    ["auth", "status"],
    ["/status"],
    ["config", "get"],
  ];
  for (const args of candidates) {
    const result = await run(executable, args);
    if (result.code === 0) return executable;
  }
  throw new Error(
    "Claude Code is installed but not authenticated. Run `claude` and sign in.",
  );
}

export function resolveCodexExecutable(options: CodexAuthOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const home = options.homeDir ?? homedir();

  if (options.configuredPath !== undefined) {
    if (!isAbsolute(options.configuredPath)) {
      throw new Error("CODEX_EXECUTABLE must be an absolute path");
    }
    const configured = validateCandidate(options.configuredPath, true);
    if (!configured) {
      throw new Error("configured Codex executable was not found or is not executable");
    }
    return configured;
  }

  const pathEntries = (environment.PATH ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean);
  const pathNames = platform === "win32"
    ? ["codex", "codex.exe", "codex.cmd"]
    : ["codex"];
  for (const directory of pathEntries) {
    for (const name of pathNames) {
      const found = validateCandidate(join(directory, name), true);
      if (found) return found;
    }
  }

  const fallbackCandidates = options.fallbackCandidates ?? (
    platform === "darwin"
      ? [
          join(home, ".local", "bin", "codex"),
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          join(home, ".npm-global", "bin", "codex"),
          join(home, ".bun", "bin", "codex"),
        ]
      : []
  );
  for (const candidate of fallbackCandidates) {
    const found = validateCandidate(candidate, true);
    if (found) return found;
  }

  throw new Error(
    "Codex CLI was not found. Install it or set CODEX_EXECUTABLE to an absolute path.",
  );
}

export async function verifyCodexSubscriptionAuth(
  options: CodexAuthOptions = {},
): Promise<string> {
  const executable = resolveCodexExecutable(options);
  const run = options.run ?? defaultExecFile;
  const version = await run(executable, ["--version"]);
  if (version.code !== 0) {
    throw new Error("Codex CLI could not be started. Install it and run `codex login`.");
  }
  const appServer = await run(executable, ["app-server", "--help"]);
  if (appServer.code !== 0) {
    throw new Error(
      "Codex CLI does not provide app-server support. Update Codex, then run `codex login`.",
    );
  }

  const status = await run(executable, ["login", "status"]);
  if (status.code !== 0) {
    throw new Error(
      "Codex CLI is installed but not authenticated. Run `codex login` and sign in with ChatGPT.",
    );
  }
  const output = `${status.stdout}\n${status.stderr}`;
  if (!/chatgpt/i.test(output)) {
    throw new Error(
      "Codex CLI is not using ChatGPT subscription authentication. Run `codex logout`, then `codex login`.",
    );
  }
  if (!hasFileBackedCodexSubscription(options)) {
    throw new Error(
      "Codex CLI is authenticated, but SmartBotMC requires file-backed subscription credentials. " +
      "Set `cli_auth_credentials_store = \"file\"` in Codex config and run `codex login` again.",
    );
  }
  return executable;
}

export async function verifyAgentSubscriptionAuth(
  options: AgentSubscriptionAuthOptions,
): Promise<ResolvedAgentProvider> {
  if (options.provider === "codex") {
    return {
      provider: "codex",
      executable: await verifyCodexSubscriptionAuth(options.codex),
    };
  }
  if (options.provider === "anthropic") {
    return {
      provider: "anthropic",
      executable: await verifySubscriptionAuth(options.claude),
    };
  }
  return verifyOpenRouterAuth(options.openrouter);
}

/** Validate OpenRouter configuration without ever echoing the secret. */
export function verifyOpenRouterAuth(
  options: OpenRouterAuthOptions = {},
): ResolvedAgentProvider {
  const apiKey = options.apiKey?.trim()
    || options.env?.OPENROUTER_API_KEY?.trim()
    || options.env?.AGENT_API_KEY?.trim()
    || process.env.OPENROUTER_API_KEY?.trim()
    || process.env.AGENT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OpenRouter API key is not configured. Add AGENT_API_KEY to the selected profile.",
    );
  }
  return {
    provider: "openrouter",
    apiKey,
    model: options.model?.trim() || "openai/gpt-4o-mini",
    baseUrl: options.baseUrl?.trim() || "https://openrouter.ai/api/v1",
    httpReferer: options.httpReferer?.trim(),
  };
}

function validateCandidate(candidate: string, preservePath = false): string | null {
  if (!isAbsolute(candidate) || !existsSync(candidate)) return null;
  try {
    if (!statSync(candidate).isFile()) return null;
    accessSync(candidate, constants.X_OK);
    const resolved = realpathSync(candidate);
    return preservePath ? candidate : resolved;
  } catch {
    return null;
  }
}

function hasFileBackedCodexSubscription(options: CodexAuthOptions): boolean {
  const environment = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const codexHome = environment.CODEX_HOME?.trim() || join(home, ".codex");
  try {
    const value = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as {
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    return typeof value.tokens?.access_token === "string" &&
      value.tokens.access_token.length > 0 &&
      typeof value.tokens.account_id === "string" &&
      value.tokens.account_id.length > 0;
  } catch {
    return false;
  }
}

function withExecutableOnPath(executable: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  const separator = process.platform === "win32" ? ";" : delimiter;
  const current = environment.PATH ?? "";
  const executableDirectory = dirname(executable);
  const entries = [
    executableDirectory,
    ...(current ? current.split(separator) : []),
  ].filter((entry, index, values) => entry && values.indexOf(entry) === index);
  environment.PATH = entries.join(separator);
  return environment;
}
