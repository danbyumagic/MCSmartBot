import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDef, ToolResult } from "./tools.js";
import {
  serializeToolResult,
  type SdkClient,
  type SessionEvent,
} from "./client.js";

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const MAX_TOOL_CALLS_PER_MESSAGE = 12;

type JsonObject = Record<string, unknown>;

export type OpenRouterFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenRouterClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  httpReferer?: string;
  fetch?: OpenRouterFetch;
}

interface ChatMessage extends JsonObject {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenRouter's chat-completions API is OpenAI-compatible. The adapter keeps
 * the provider boundary deliberately small: SmartBot's Zod tools are exposed
 * as function tools, then tool results are sent back until the model finishes.
 */
export function createOpenRouterClient(
  toolDefs: ToolDef<unknown>[],
  options: OpenRouterClientOptions,
): SdkClient {
  const toolsByName = new Map(toolDefs.map((tool) => [tool.name, tool]));
  const tools = toolDefs.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeSchema(zodToJsonSchema(tool.inputSchema, {
        $refStrategy: "none",
      })),
    },
  }));
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("OpenRouter API key is empty.");
  const model = options.model?.trim() || DEFAULT_MODEL;
  const endpoint = completionEndpoint(options.baseUrl?.trim() || DEFAULT_BASE_URL);
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    sendMessage(message, opts) {
      return streamResponse({
        message,
        system: opts.system,
        signal: opts.signal,
        apiKey,
        model,
        endpoint,
        httpReferer: options.httpReferer,
        request,
        tools,
        toolsByName,
      });
    },
  };
}

async function* streamResponse(options: {
  message: string;
  system: string;
  signal?: AbortSignal;
  apiKey: string;
  model: string;
  endpoint: string;
  httpReferer?: string;
  request: OpenRouterFetch;
  tools: readonly JsonObject[];
  toolsByName: Map<string, ToolDef<unknown>>;
}): AsyncIterable<SessionEvent> {
  const messages: ChatMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.message },
  ];
  let toolCallCount = 0;

  while (true) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    };
    if (options.httpReferer) headers["HTTP-Referer"] = options.httpReferer;
    headers["X-OpenRouter-Title"] = "SmartBotMC";

    const response = await options.request(options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: options.model,
        messages,
        tools: options.tools,
        tool_choice: options.tools.length > 0 ? "auto" : undefined,
      }),
      signal: options.signal,
    });
    if (!response.ok) {
      // Do not include the provider response body: upstreams occasionally echo
      // request metadata, and an API failure is already actionable by status.
      throw new Error(`OpenRouter request failed with HTTP ${response.status}.`);
    }

    const payload = await response.json() as unknown;
    const assistant = readAssistantMessage(payload);
    const text = assistant.contentText;
    if (text) yield { kind: "text", text };

    if (assistant.toolCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: assistant.rawContent,
      tool_calls: assistant.toolCalls,
    });

    for (const call of assistant.toolCalls) {
      toolCallCount += 1;
      if (toolCallCount > MAX_TOOL_CALLS_PER_MESSAGE) {
        yield {
          kind: "text",
          text: `tool-call limit reached (${MAX_TOOL_CALLS_PER_MESSAGE})`,
        };
        return;
      }

      const name = call.function.name;
      let input: unknown;
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        const result: ToolResult = {
          ok: false,
          summary: `tool ${name} received invalid JSON arguments`,
        };
        yield { kind: "toolUse", name, input: call.function.arguments };
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializeToolResult(result),
        });
        continue;
      }

      yield { kind: "toolUse", name, input };
      const tool = options.toolsByName.get(name);
      const result = tool
        ? await invokeTool(tool, input)
        : { ok: false, summary: `unknown SmartBot tool: ${name}` } satisfies ToolResult;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: serializeToolResult(result),
      });
    }
  }
}

async function invokeTool(
  tool: ToolDef<unknown>,
  input: unknown,
): Promise<ToolResult> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, summary: `invalid arguments for ${tool.name}` };
  }
  try {
    return await tool.handler(parsed.data);
  } catch (error) {
    return {
      ok: false,
      summary: `${tool.name} failed: ${error instanceof Error ? error.message : "unknown error"}`,
      recoverable: true,
    };
  }
}

function readAssistantMessage(payload: unknown): {
  contentText: string;
  rawContent: unknown;
  toolCalls: OpenRouterToolCall[];
} {
  const root = isObject(payload) ? payload : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = isObject(choices[0]) ? choices[0] : {};
  const message = isObject(first.message) ? first.message : {};
  const rawContent = message.content ?? null;
  const contentText = extractText(rawContent);
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: OpenRouterToolCall[] = [];
  for (let index = 0; index < rawCalls.length; index += 1) {
    const raw = isObject(rawCalls[index]) ? rawCalls[index] : {};
    const fn = isObject(raw.function) ? raw.function : {};
    if (typeof fn.name !== "string") continue;
    toolCalls.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : `smartbot-tool-${index}`,
      type: "function",
      function: {
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
      },
    });
  }
  if (!contentText && toolCalls.length === 0) {
    throw new Error("OpenRouter returned no assistant message.");
  }
  return { contentText, rawContent, toolCalls };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text))
    .join("");
}

function normalizeSchema(value: unknown): JsonObject {
  if (!isObject(value)) return { type: "object", properties: {} };
  const schema = { ...value };
  delete schema.$schema;
  return schema;
}

function completionEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
