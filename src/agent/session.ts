import type { Logger } from "../util/logger.js";
import type { DB } from "../memory/db.js";
import { getRecentConversations } from "../memory/conversations.js";
import { buildSystemPrompt, formatRecentConversations } from "./prompt.js";
import type { ToolDef } from "./tools.js";
import type { AgentTrigger } from "../bus/index.js";
import { sourceFromTrigger, type TriggerSourceState } from "./triggerSource.js";
import type { ServerConfig } from "../config/serverConfig.js";
import type { ActorContext, PlayerRole } from "../permissions/roles.js";
import type { ExecutionSource } from "../permissions/executionActor.js";
import { isOwner } from "../permissions/index.js";
import type { AgentProvider } from "./provider.js";
import {
  serializeToolResult,
  type AgentClientOptions,
  type SdkClient,
  type SessionEvent,
} from "./client.js";
import { createCodexClient } from "./codexClient.js";
import { createOpenRouterClient } from "./openrouterClient.js";

/**
 * Internal event shape yielded by SdkClient.sendMessage().
 * This is an adapter layer over the real SDK's SDKMessage union.
 *
 * The real SDK yields SDKMessage (type: 'assistant' | 'user' | 'result' | 'system' | ...).
 * We project only the two event kinds this session loop cares about.
 *
 * See docs/notes/agent-sdk.md for the full SDK API shape.
 */
export type { SdkClient, SessionEvent } from "./client.js";

export interface AgentSessionDeps {
  log: Logger;
  db: DB;
  ownerUsername: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: ToolDef<any>[];
  /** Factory so tests can inject a fake client. In production, omit to use the real SDK. */
  createClient?: (options: AgentClientOptions) => SdkClient;
  /** Selected reasoning provider. Production supplies this from the profile. */
  agentProvider?: AgentProvider;
  /** Absolute Claude executable discovered during startup preflight. */
  claudeCodeExecutable?: string;
  /** Absolute Codex executable discovered during startup preflight. */
  codexExecutable?: string;
  /** OpenRouter credentials discovered during startup preflight. */
  agentApiKey?: string;
  agentModel?: string;
  agentBaseUrl?: string;
  agentHttpReferer?: string;
  /** Profile root used as the SDK process working directory. */
  workingDirectory?: string;
  /** Shared mutable state tracking the current trigger source for memory attribution. */
  triggerSource?: TriggerSourceState;
  /** Server-specific config injected into the system prompt. */
  serverConfig?: ServerConfig;
  /** Mutable request actor used by tool authorization and reply routing. */
  actorContext?: ActorContext;
  /** Resolve an in-game player's current role. */
  resolveRole?: (username: string) => PlayerRole | undefined;
  /** Compact live bot state injected into every agent turn. */
  runtimeContext?: () => string | undefined;
  /** Hard cap for one agent turn so a stalled provider cannot block later chat. */
  agentTurnTimeoutMs?: number;
}

export interface AgentSession {
  handleTrigger(trigger: AgentTrigger): Promise<void>;
  /** Abort the active provider turn immediately. Returns true when one existed. */
  cancelCurrent(): boolean;
  /** Release any provider subprocess owned by this session. */
  close(): void;
}

/**
 * Build a real SdkClient backed by @anthropic-ai/claude-agent-sdk.
 *
 * Tool registration:
 * - Each ToolDef is wrapped with the SDK's `tool()` helper (takes a Zod raw shape).
 * - The tools are bundled into an in-process MCP server via `createSdkMcpServer()`.
 * - The MCP server is passed to `query()` options so Claude can call them.
 *
 * Event projection:
 * - SDK yields SDKMessage (union). We filter to `type === 'assistant'` and project
 *   content blocks to our internal SessionEvent shape.
 * - Text blocks (type === 'text') → { kind: 'text', text }
 * - Tool-use blocks (type === 'tool_use') → { kind: 'toolUse', name, input }
 * - All other SDKMessage types (result, system, user, etc.) are ignored.
 *
 * Auth is automatic — the claude CLI handles credentials.
 *
 * The MCP server is constructed once per session (lazy on first sendMessage call)
 * and reused across all subsequent calls via a closure-scoped cache.
 */
function createAnthropicClient(
  toolDefs: ToolDef<unknown>[],
  options: { claudeCodeExecutable?: string; workingDirectory: string },
): SdkClient {
  // Cache is populated on the first sendMessage call (lazy, once per session lifetime).
  // mcpServer is typed as ReturnType of createSdkMcpServer; we use a branded object
  // alias to avoid a top-level import of the optional SDK package.
  type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");
  let cache: {
    mcpServer: ReturnType<SdkModule["createSdkMcpServer"]>;
    mcpServerName: string;
    mcpPrefix: string;
    allowedMcpTools: string[];
    query: SdkModule["query"];
  } | null = null;

  return {
    sendMessage(message, opts) {
      return (async function* (): AsyncIterable<SessionEvent> {
        if (!cache) {
          // Dynamic import so tests that inject a fake client never touch the real SDK.
          const { query, tool, createSdkMcpServer } = await import(
            "@anthropic-ai/claude-agent-sdk"
          );

          const mcpServerName = "smartbot-tools";
          const mcpPrefix = `mcp__${mcpServerName}__`;

          // Register each ToolDef as an SDK MCP tool. The SDK's tool() takes a Zod raw shape.
          // inputSchema is ZodObject so .shape always exists — no cast needed.
          const sdkTools = toolDefs.map((def) => {
            const shape = def.inputSchema.shape;
            return tool(
              def.name,
              def.description,
              shape as Parameters<typeof tool>[2],
              async (args: unknown) => {
                const result = await def.handler(
                  args as Parameters<typeof def.handler>[0],
                );
                const text = result.code
                  ? serializeToolResult(result)
                  : result.summary;
                return { content: [{ type: "text" as const, text }] };
              },
            );
          });

          const mcpServer = createSdkMcpServer({ name: mcpServerName, tools: sdkTools });
          // Restrict Claude to only MCP tools (no built-in Claude Code tools).
          const allowedMcpTools = toolDefs.map((d) => `${mcpPrefix}${d.name}`);

          cache = { mcpServer, mcpServerName, mcpPrefix, allowedMcpTools, query };
        }

        const { mcpServer, mcpServerName, mcpPrefix, allowedMcpTools, query } = cache;

        const abortController = new AbortController();
        const abort = () => abortController.abort();
        if (opts.signal?.aborted) abort();
        opts.signal?.addEventListener("abort", abort, { once: true });
        try {
          const gen = query({
            prompt: message,
            options: {
              systemPrompt: opts.system,
              cwd: options.workingDirectory,
              pathToClaudeCodeExecutable: options.claudeCodeExecutable,
              mcpServers: { [mcpServerName]: mcpServer },
              tools: [] as string[],
              allowedTools: allowedMcpTools,
              permissionMode: "bypassPermissions" as const,
              allowDangerouslySkipPermissions: true,
              persistSession: false,
              abortController,
              maxTurns: 12,
              maxThinkingTokens: 2_048,
            },
          });

          for await (const msg of gen) {
            if (msg.type !== "assistant") continue;
            for (const block of msg.message.content) {
              if (block.type === "text") {
                yield { kind: "text", text: block.text };
              } else if (block.type === "tool_use") {
                // Strip MCP server prefix: 'mcp__smartbot-tools__say' → 'say'
                const rawName = block.name as string;
                const name = rawName.startsWith(mcpPrefix)
                  ? rawName.slice(mcpPrefix.length)
                  : rawName;
                yield { kind: "toolUse", name, input: block.input };
              }
            }
          }
        } finally {
          opts.signal?.removeEventListener("abort", abort);
        }
      })();
    },
  };
}

/**
 * Create the configured provider adapter without attaching SmartBot runtime
 * tools. Desktop authoring surfaces use this for bounded, read-only turns.
 */
export function createProviderClient(
  toolDefs: ToolDef<unknown>[],
  options: AgentClientOptions,
): SdkClient {
  if (options.provider === "codex") {
    return createCodexClient(toolDefs, {
      codexExecutable: options.codexExecutable ?? "codex",
    });
  }
  if (options.provider === "anthropic") {
    return createAnthropicClient(toolDefs, {
      claudeCodeExecutable: options.claudeCodeExecutable,
      workingDirectory: options.workingDirectory,
    });
  }
  return createOpenRouterClient(toolDefs, {
    apiKey: options.agentApiKey ?? "",
    model: options.agentModel,
    baseUrl: options.agentBaseUrl,
    httpReferer: options.agentHttpReferer,
  });
}

export function createAgentSession(deps: AgentSessionDeps): AgentSession {
  const { log, db, ownerUsername, tools } = deps;
  const provider = deps.agentProvider ?? "anthropic";
  const clientOptions: AgentClientOptions = {
    provider,
    claudeCodeExecutable: deps.claudeCodeExecutable,
    codexExecutable: deps.codexExecutable,
    workingDirectory: deps.workingDirectory ?? process.cwd(),
    ...(deps.agentApiKey ? { agentApiKey: deps.agentApiKey } : {}),
    ...(deps.agentModel ? { agentModel: deps.agentModel } : {}),
    ...(deps.agentBaseUrl ? { agentBaseUrl: deps.agentBaseUrl } : {}),
    ...(deps.agentHttpReferer ? { agentHttpReferer: deps.agentHttpReferer } : {}),
  };
  const client = deps.createClient
    ? deps.createClient(clientOptions)
    : createProviderClient(tools, clientOptions);
  const system = buildSystemPrompt(ownerUsername, deps.serverConfig);
  const agentTurnTimeoutMs = deps.agentTurnTimeoutMs ?? 120_000;
  let activeController: AbortController | null = null;

  async function handleTrigger(trigger: AgentTrigger): Promise<void> {
    const role = trigger.kind === "chat"
      ? deps.resolveRole?.(trigger.from) ??
        (isOwner(trigger.from, ownerUsername) ? "owner" : "viewer")
      : "owner";
    const actorUsername = trigger.kind === "chat" ? trigger.from : ownerUsername;
    const actorSource: ExecutionSource = trigger.kind === "chat"
      ? "minecraft-chat"
      : trigger.kind === "cli"
        ? trigger.executionSource ?? "cli"
        : "recovery";
    if (deps.actorContext) {
      deps.actorContext.username = actorUsername;
      deps.actorContext.role = role;
      deps.actorContext.source = actorSource;
    }
    if (deps.triggerSource) {
      deps.triggerSource.current = sourceFromTrigger(trigger);
    }
    const recent = getRecentConversations(db, 10);
    const triggerLine = (() => {
      switch (trigger.kind) {
        case "chat":
          return `${trigger.from} (in-game role=${role}): ${trigger.text}`;
        case "cli":
          return `${ownerUsername} (${trigger.executionSource ?? "cli"}): ${trigger.text}`;
        case "skillDone":
          return `Observation: skill ${trigger.skill} finished (ok=${trigger.ok}). ${trigger.summary}`;
        case "skillFailed":
          return `Observation: skill ${trigger.skill} FAILED (code=${trigger.code}, recoverable=${trigger.recoverable}). ${trigger.error}`;
        case "reflexAlert":
          return `Observation (reflex): ${trigger.summary}`;
        case "taskPlanDone":
          return `Observation: task plan ${trigger.planId} '${trigger.title}' completed.`;
        case "taskPlanFailed":
          return `Observation: task plan ${trigger.planId} '${trigger.title}' FAILED. ${trigger.error}`;
        case "botDeath":
          return "Observation: the bot died. Active movement was interrupted and will resume after respawn.";
        case "botRespawn":
          return "Observation: the bot respawned and durable work is available to resume.";
        case "idleTick":
          return "Observation: idle tick. Check the open goal in memory and decide whether to act, or stay quiet.";
      }
    })();
    let runtimeContext: string | undefined;
    try {
      runtimeContext = deps.runtimeContext?.();
    } catch (err) {
      log.warn({ err }, "failed to collect live bot context");
    }
    const userMessage = [
      formatRecentConversations(recent),
      "",
      ...(runtimeContext ? [`Current live bot state: ${runtimeContext}`, ""] : []),
      triggerLine,
    ].join("\n");

    const startedAt = Date.now();
    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, agentTurnTimeoutMs);
    log.info({ triggerKind: trigger.kind }, "agent turn started");
    try {
      for await (const part of client.sendMessage(userMessage, {
        system,
        signal: controller.signal,
      })) {
        if (part.kind === "text") {
          log.debug({ text: part.text }, "agent text");
        } else if (part.kind === "toolUse") {
          // Tools are executed by the SDK via the MCP server registered in
          // buildRealClientStream. The session loop only logs the call here.
          // (Tests inject a fake client whose async generator may directly invoke
          //  tool handlers to simulate MCP execution.)
          log.info({ tool: part.name }, "agent tool call observed");
        }
      }
      if (timedOut) {
        throw new Error(`agent turn timed out after ${agentTurnTimeoutMs}ms`);
      }
      log.info({ durationMs: Date.now() - startedAt }, "agent turn completed");
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
  }

  return {
    handleTrigger,
    cancelCurrent: () => {
      if (!activeController) return false;
      activeController.abort();
      return true;
    },
    close: () => {
      activeController?.abort();
      client.close?.();
    },
  };
}
