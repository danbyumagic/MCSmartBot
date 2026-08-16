import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDef } from "./tools.js";
import {
  serializeToolResult,
  type SdkClient,
  type SessionEvent,
} from "./client.js";

type JsonObject = Record<string, unknown>;
type JsonRpcId = number | string;
const SMARTBOTMC_CLIENT_VERSION = "0.1.0-beta.1";

interface CodexRuntimePaths {
  root: string;
  home: string;
  workspace: string;
}

interface CodexExternalAuthTokens {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: null;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface DynamicToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  events: AsyncEventQueue<SessionEvent>;
  toolCalls: number;
}

const MAX_TOOL_CALLS_PER_TURN = 12;

const DISABLED_CODEX_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugins",
  "recommended_plugins",
  "remote_plugin",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
] as const;

const CODEX_CONFIG_OVERRIDES = [
  'forced_login_method="chatgpt"',
  'cli_auth_credentials_store="file"',
  'web_search="disabled"',
  "tools.update_plan.enabled=false",
  "tools.experimental_request_user_input.enabled=false",
  "include_environment_context=false",
  "include_permissions_instructions=false",
  "include_apps_instructions=false",
  "include_collaboration_mode_instructions=false",
] as const;

const CODEX_DEVELOPER_INSTRUCTIONS = [
  "You are the reasoning layer inside SmartBotMC, not a coding assistant.",
  "The only actions you may take are the SmartBotMC dynamic tools supplied to this thread.",
  "Do not use or ask for shell, filesystem, browser, MCP, plugin, app, sub-agent, or code-editing access.",
  "Never claim an in-game action succeeded unless its tool result says it succeeded.",
  "Use the private say tool when a direct reply to the requester is appropriate.",
].join(" ");

/**
 * Create a Codex adapter backed by the user's existing `codex login` session.
 *
 * The child receives a temporary CODEX_HOME and external access tokens read
 * from the user's authoritative CLI login. The refresh token is never copied;
 * refresh requests are delegated to a short-lived, auth-only CLI app-server so
 * the normal CLI and SmartBotMC cannot invalidate each other's login state.
 * Personal config, MCP servers, plugins, skills, and project instructions are
 * excluded from the model process. A fresh empty working directory and no
 * Codex environment keep built-in filesystem/process tools unavailable.
 */
export function createCodexClient(
  toolDefs: ToolDef<unknown>[],
  options: {
    codexExecutable: string;
  },
): SdkClient {
  const toolsByName = new Map(toolDefs.map((tool) => [tool.name, tool]));
  const dynamicTools = toolDefs.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    inputSchema: codexDynamicToolInputSchema(tool.inputSchema),
  }));
  const runtime = createIsolatedCodexRuntime();
  const tokenBroker = new CodexSubscriptionTokenBroker(options.codexExecutable);
  const connection = new CodexAppServerConnection(
    options.codexExecutable,
    codexAppServerArgs(),
    runtime,
  );
  let readyPromise: Promise<void> | null = null;
  let activeTurn: ActiveTurn | null = null;
  let closed = false;

  connection.setRequestHandler(async (method, params) => {
    if (method === "account/chatgptAuthTokens/refresh") {
      return tokenBroker.refresh();
    }
    if (method !== "item/tool/call") {
      throw new Error(`Codex requested unsupported host method: ${method}`);
    }
    const call = params as unknown as DynamicToolCall;
    const active = activeTurn;
    if (!active || call.threadId !== active.threadId ||
      (active.turnId !== null && call.turnId !== active.turnId)) {
      return dynamicToolResponse("Tool call did not belong to the active turn.", false);
    }
    active.toolCalls += 1;
    if (active.toolCalls > MAX_TOOL_CALLS_PER_TURN) {
      return dynamicToolResponse(
        `SmartBotMC tool-call limit reached (${MAX_TOOL_CALLS_PER_TURN}). Finish the turn without another action.`,
        false,
      );
    }

    active.events.push({
      kind: "toolUse",
      name: call.tool,
      input: call.arguments,
    });
    const tool = toolsByName.get(call.tool);
    if (!tool || call.namespace !== null) {
      return dynamicToolResponse(`Unknown SmartBotMC tool: ${call.tool}`, false);
    }
    const parsed = tool.inputSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return dynamicToolResponse(
        `Invalid input for ${call.tool}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
          .join("; ")}`,
        false,
      );
    }
    try {
      const result = await tool.handler(parsed.data);
      return dynamicToolResponse(serializeToolResult(result), true);
    } catch {
      return dynamicToolResponse(`SmartBotMC tool ${call.tool} failed unexpectedly.`, false);
    }
  });

  const ensureReady = (): Promise<void> => {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      await connection.start();
      await connection.request("initialize", {
        clientInfo: {
          name: "smartbotmc",
          title: "SmartBotMC",
          version: SMARTBOTMC_CLIENT_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [
            "thread/tokenUsage/updated",
            "item/reasoning/summaryTextDelta",
            "item/reasoning/textDelta",
          ],
        },
      });
      connection.notify("initialized");
      const tokens = tokenBroker.current();
      await connection.request("account/login/start", {
        type: "chatgptAuthTokens",
        ...tokens,
      });
      const account = await connection.request<{
        account: { type?: string } | null;
        requiresOpenaiAuth: boolean;
      }>("account/read", { refreshToken: false });
      if (account.account?.type !== "chatgpt") {
        throw new Error(
          "Codex CLI is not signed in with a ChatGPT subscription. Run `codex login`.",
        );
      }
    })();
    return readyPromise;
  };

  return {
    sendMessage(message, sendOptions) {
      return (async function* (): AsyncIterable<SessionEvent> {
        if (closed) throw new Error("Codex client is closed.");
        if (activeTurn) throw new Error("Codex client already has an active turn.");
        await ensureReady();

        const threadResult = await connection.request<{
          thread: { id: string };
        }>("thread/start", {
          cwd: runtime.workspace,
          runtimeWorkspaceRoots: [],
          approvalPolicy: "never",
          sandbox: "read-only",
          baseInstructions: sendOptions.system,
          developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
          ephemeral: true,
          historyMode: "legacy",
          environments: [],
          dynamicTools,
        });
        const events = new AsyncEventQueue<SessionEvent>();
        const active: ActiveTurn = {
          threadId: threadResult.thread.id,
          turnId: null,
          events,
          toolCalls: 0,
        };
        activeTurn = active;
        const streamedAgentText = new Map<string, string>();

        const unsubscribeNotifications = connection.onNotification((method, params) => {
          if (method === "item/agentMessage/delta") {
            const delta = params as {
              threadId?: string;
              turnId?: string;
              delta?: string;
            };
            if (delta.threadId === active.threadId &&
              (!active.turnId || delta.turnId === active.turnId) &&
              typeof delta.delta === "string") {
              const itemId = typeof (params as { itemId?: unknown }).itemId === "string"
                ? (params as { itemId: string }).itemId
                : "unknown";
              streamedAgentText.set(
                itemId,
                `${streamedAgentText.get(itemId) ?? ""}${delta.delta}`,
              );
              events.push({ kind: "text", text: delta.delta });
            }
            return;
          }
          if (method === "item/completed") {
            const completed = params as {
              threadId?: string;
              turnId?: string;
              item?: { type?: string; id?: string; text?: string };
            };
            if (completed.threadId !== active.threadId ||
              (active.turnId && completed.turnId !== active.turnId) ||
              completed.item?.type !== "agentMessage" ||
              typeof completed.item.text !== "string") return;
            const itemId = completed.item.id ?? "unknown";
            const streamed = streamedAgentText.get(itemId) ?? "";
            const remainder = completed.item.text.startsWith(streamed)
              ? completed.item.text.slice(streamed.length)
              : streamed.length === 0 ? completed.item.text : "";
            if (remainder) events.push({ kind: "text", text: remainder });
            return;
          }
          if (method === "turn/completed") {
            const completed = params as {
              threadId?: string;
              turn?: {
                id?: string;
                status?: string;
                error?: { message?: string } | null;
              };
            };
            if (completed.threadId !== active.threadId ||
              (active.turnId && completed.turn?.id !== active.turnId)) return;
            if (completed.turn?.status === "failed") {
              events.fail(new Error(
                sanitizeProviderError(completed.turn.error?.message) ||
                "Codex turn failed.",
              ));
            } else {
              events.end();
            }
          }
        });
        const unsubscribeFailure = connection.onFailure((error) => events.fail(error));
        let abort: (() => void) | null = null;
        try {
          const turnResult = await connection.request<{
            turn: { id: string };
          }>("turn/start", {
            threadId: active.threadId,
            input: [{ type: "text", text: message, text_elements: [] }],
            environments: [],
            cwd: runtime.workspace,
            runtimeWorkspaceRoots: [],
            approvalPolicy: "never",
          });
          active.turnId = turnResult.turn.id;
          abort = () => {
            void connection.request("turn/interrupt", {
              threadId: active.threadId,
              turnId: active.turnId,
            }).catch(() => undefined);
            events.end();
          };
          if (sendOptions.signal?.aborted) abort();
          sendOptions.signal?.addEventListener("abort", abort, { once: true });

          for await (const event of events) yield event;
        } finally {
          if (abort) sendOptions.signal?.removeEventListener("abort", abort);
          unsubscribeNotifications();
          unsubscribeFailure();
          if (activeTurn === active) activeTurn = null;
        }
      })();
    },
    close() {
      if (closed) return;
      closed = true;
      activeTurn?.events.fail(new Error("Codex client closed."));
      connection.close();
    },
  };
}

/**
 * Project a Zod schema into the JSON-Schema subset accepted by Codex app-server.
 *
 * zod-to-json-schema emits draft-07 tuples as an array-valued `items`. Codex
 * 0.147 rejects that representation while accepting an ordinary array schema
 * with fixed min/max lengths. Homogeneous tuples retain their exact item
 * schema. Heterogeneous tuples expose the union of their item schemas to the
 * model; the original Zod schema still performs position-exact validation
 * before SmartBotMC invokes the tool handler.
 */
export function codexDynamicToolInputSchema(inputSchema: ToolDef<unknown>["inputSchema"]): JsonObject {
  const converted = zodToJsonSchema(inputSchema, { $refStrategy: "none" });
  const normalized = normalizeCodexJsonSchema(converted);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new Error("Codex dynamic-tool schema must be a JSON object.");
  }
  return normalized as JsonObject;
}

function normalizeCodexJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCodexJsonSchema);
  if (!value || typeof value !== "object") return value;

  const normalized: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "items" && Array.isArray(nested)) {
      const candidates = nested.map(normalizeCodexJsonSchema);
      const unique = candidates.filter((candidate, index) =>
        candidates.findIndex((other) => JSON.stringify(other) === JSON.stringify(candidate)) === index
      );
      normalized.items = unique.length <= 1
        ? unique[0] ?? {}
        : { anyOf: unique };
      continue;
    }
    normalized[key] = normalizeCodexJsonSchema(nested);
  }
  return normalized;
}

export function codexAppServerArgs(): string[] {
  const args = ["app-server", "--stdio", "--strict-config"];
  for (const config of CODEX_CONFIG_OVERRIDES) args.push("-c", config);
  for (const feature of DISABLED_CODEX_FEATURES) args.push("--disable", feature);
  return args;
}

export function createIsolatedCodexRuntime(): CodexRuntimePaths {
  const root = mkdtempSync(join(tmpdir(), "smartbotmc-codex-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  chmodSync(root, 0o700);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });

  return { root, home, workspace };
}

function resolveCodexHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

class CodexSubscriptionTokenBroker {
  private readonly codexHome = resolveCodexHome();
  private refreshPromise: Promise<CodexExternalAuthTokens> | null = null;

  constructor(private readonly executable: string) {}

  current(): CodexExternalAuthTokens {
    const authPath = join(this.codexHome, "auth.json");
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
    } catch {
      throw new Error(
        "SmartBotMC could not read file-backed Codex subscription credentials. " +
        "Use `codex login` with file-backed credentials, then try again.",
      );
    }
    const tokens = value && typeof value === "object"
      ? (value as { tokens?: unknown }).tokens
      : undefined;
    const accessToken = tokens && typeof tokens === "object"
      ? (tokens as { access_token?: unknown }).access_token
      : undefined;
    const accountId = tokens && typeof tokens === "object"
      ? (tokens as { account_id?: unknown }).account_id
      : undefined;
    if (typeof accessToken !== "string" || accessToken.length === 0 ||
      typeof accountId !== "string" || accountId.length === 0) {
      throw new Error(
        "Codex CLI login does not contain usable ChatGPT subscription credentials. " +
        "Run `codex login` and try again.",
      );
    }
    return {
      accessToken,
      chatgptAccountId: accountId,
      chatgptPlanType: null,
    };
  }

  refresh(): Promise<CodexExternalAuthTokens> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      await refreshAuthoritativeCodexLogin(this.executable, this.codexHome);
      return this.current();
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }
}

async function refreshAuthoritativeCodexLogin(
  executable: string,
  codexHome: string,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "smartbotmc-codex-auth-"));
  const workspace = join(root, "workspace");
  chmodSync(root, 0o700);
  mkdirSync(workspace, { mode: 0o700 });
  const runtime: CodexRuntimePaths = { root, home: codexHome, workspace };
  const connection = new CodexAppServerConnection(
    executable,
    codexAppServerArgs(),
    runtime,
  );
  try {
    await connection.start();
    await connection.request("initialize", {
      clientInfo: {
        name: "smartbotmc-auth-broker",
        title: "SmartBotMC auth broker",
        version: SMARTBOTMC_CLIENT_VERSION,
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    connection.notify("initialized");
    const account = await connection.request<{
      account: { type?: string } | null;
    }>("account/read", { refreshToken: true });
    if (account.account?.type !== "chatgpt") {
      throw new Error(
        "Codex CLI could not refresh the ChatGPT subscription login. Run `codex login`.",
      );
    }
  } finally {
    connection.close();
  }
}

function codexChildEnvironment(
  runtime: CodexRuntimePaths,
  executable: string,
): NodeJS.ProcessEnv {
  const source = process.env;
  const names = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  environment.CODEX_HOME = runtime.home;
  environment.HOME = runtime.root;
  if (process.platform === "win32") environment.USERPROFILE = runtime.root;
  const executablePath = process.execPath;
  const separator = process.platform === "win32" ? ";" : delimiter;
  const currentPath = environment.PATH ?? "";
  environment.PATH = [
    dirname(executable),
    dirname(executablePath),
    currentPath,
  ]
    .filter(Boolean)
    .join(separator);
  return environment;
}

class CodexAppServerConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(
    method: string,
    params: JsonObject,
  ) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private requestHandler: ((method: string, params: JsonObject) => Promise<unknown>) | null = null;
  private failure: Error | null = null;
  private closed = false;

  constructor(
    private readonly executable: string,
    private readonly args: string[],
    private readonly runtime: CodexRuntimePaths,
  ) {}

  start(): Promise<void> {
    if (this.child) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed."));
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.executable, this.args, {
        cwd: this.runtime.workspace,
        env: codexChildEnvironment(this.runtime, this.executable),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      let settled = false;
      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("error", (error) => {
        if (!settled) reject(new Error("Codex app-server could not be started."));
        this.fail(new Error("Codex app-server could not be started."));
        this.cleanupRuntime();
      });
      child.once("close", (code, signal) => {
        if (!this.closed) {
          this.fail(new Error(
            `Codex app-server exited unexpectedly (${signal ?? code ?? "unknown"}).`,
          ));
        }
        this.cleanupRuntime();
      });
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => this.handleLine(line));
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const child = this.child;
    if (!child || this.closed) {
      return Promise.reject(new Error("Codex app-server is not running."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 15_000);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  setRequestHandler(
    handler: (method: string, params: JsonObject) => Promise<unknown>,
  ): void {
    this.requestHandler = handler;
  }

  onNotification(listener: (method: string, params: JsonObject) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failureListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Codex app-server closed.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const child = this.child;
    child?.kill("SIGTERM");
    if (child) {
      const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        this.cleanupRuntime();
      }, 2_000);
      forceKill.unref();
    } else {
      this.cleanupRuntime();
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let value: JsonObject;
    try {
      value = JSON.parse(line) as JsonObject;
    } catch {
      this.fail(new Error("Codex app-server emitted an invalid protocol message."));
      return;
    }
    const method = typeof value.method === "string" ? value.method : null;
    const hasId = typeof value.id === "number" || typeof value.id === "string";
    if (hasId && !method) {
      const pending = this.pending.get(value.id as JsonRpcId);
      if (!pending) return;
      this.pending.delete(value.id as JsonRpcId);
      clearTimeout(pending.timer);
      if (value.error && typeof value.error === "object") {
        const protocolError = value.error as { message?: unknown };
        pending.reject(new Error(
          sanitizeProviderError(protocolError.message) || "Codex app-server request failed.",
        ));
      } else {
        pending.resolve(value.result);
      }
      return;
    }
    if (!method) return;
    const params = value.params && typeof value.params === "object"
      ? value.params as JsonObject
      : {};
    if (hasId) {
      void this.handleServerRequest(value.id as JsonRpcId, method, params);
      return;
    }
    for (const listener of this.notificationListeners) listener(method, params);
  }

  private async handleServerRequest(
    id: JsonRpcId,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    try {
      if (!this.requestHandler) throw new Error("No host request handler is available.");
      const result = await this.requestHandler(method, params);
      this.write({ id, result });
    } catch (error) {
      this.write({
        id,
        error: {
          code: -32601,
          message: sanitizeProviderError(error) || "Unsupported host request.",
        },
      });
    }
  }

  private write(value: JsonObject): void {
    if (!this.child || this.closed || this.failure) return;
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.failureListeners) listener(error);
  }

  private cleanupRuntime(): void {
    try {
      rmSync(this.runtime.root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup after a child process exits.
    }
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: Error): void;
  }> = [];
  private ended = false;
  private error: Error | null = null;

  push(value: T): void {
    if (this.ended || this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended || this.error) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    if (this.ended || this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.error) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

function dynamicToolResponse(text: string, success: boolean): JsonObject {
  return {
    contentItems: [{ type: "inputText", text }],
    success,
  };
}

function sanitizeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message
    .replace(/[\r\n]+/g, " ")
    .replace(
      /(password|secret|token|authorization|cookie)\s*[:=]\s*[^\s]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 512);
}
