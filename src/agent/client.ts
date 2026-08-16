import type { ToolResult } from "./tools.js";
import type { AgentProvider } from "./provider.js";

/** Provider-neutral events consumed by the runtime session loop. */
export type SessionEvent =
  | { kind: "text"; text: string }
  | { kind: "toolUse"; name: string; input: unknown };

/** Provider-neutral adapter used by the agent session. */
export interface SdkClient {
  sendMessage(
    message: string,
    options: { system: string; signal?: AbortSignal },
  ): AsyncIterable<SessionEvent>;
  close?(): void;
}

export interface AgentClientOptions {
  provider: AgentProvider;
  claudeCodeExecutable?: string;
  codexExecutable?: string;
  /** OpenRouter/OpenAI-compatible API credentials. Never log these values. */
  agentApiKey?: string;
  agentModel?: string;
  agentBaseUrl?: string;
  agentHttpReferer?: string;
  workingDirectory: string;
}

export function serializeToolResult(result: ToolResult): string {
  return JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    ...(result.code ? { code: result.code } : {}),
    ...(result.recoverable !== undefined
      ? { recoverable: result.recoverable }
      : {}),
    ...(result.details ? { details: result.details } : {}),
  });
}
