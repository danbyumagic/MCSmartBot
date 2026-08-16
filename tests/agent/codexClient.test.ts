import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexDynamicToolInputSchema,
  codexAppServerArgs,
  createCodexClient,
  createIsolatedCodexRuntime,
} from "../../src/agent/codexClient.js";
import { previewBuildDefinitionSchema } from "../../src/agent/constructionTools.js";
import type { SessionEvent } from "../../src/agent/client.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Codex CLI adapter", () => {
  it("copies neither auth nor personal config into the isolated runtime", () => {
    const source = mkdtempSync(join(tmpdir(), "smbmc-codex-source-"));
    roots.push(source);
    writeFileSync(join(source, "auth.json"), '{"auth_mode":"chatgpt"}');
    writeFileSync(join(source, "config.toml"), "[mcp_servers.private]\ncommand='private'\n");

    const runtime = createIsolatedCodexRuntime();
    roots.push(runtime.root);
    expect(existsSync(join(runtime.home, "auth.json"))).toBe(false);
    expect(existsSync(join(runtime.home, "config.toml"))).toBe(false);
    expect(runtime.workspace).not.toContain(source);
  });

  it("starts app-server with built-in capabilities disabled", () => {
    const args = codexAppServerArgs();
    expect(args.slice(0, 3)).toEqual(["app-server", "--stdio", "--strict-config"]);
    expect(args).toContain("forced_login_method=\"chatgpt\"");
    expect(args).toContain("shell_tool");
    expect(args).toContain("plugins");
    expect(args).toContain("multi_agent");
    expect(args).not.toContain("code_mode_host");
  });

  it("normalizes fixed tuples into the Codex app-server schema subset", () => {
    const inputSchema = z.object({
      at: z.tuple([
        z.number().int().min(-64).max(64),
        z.number().int().min(-64).max(64),
        z.number().int().min(-64).max(64),
      ]),
      mixed: z.tuple([z.string(), z.number().int()]),
    });

    const schema = codexDynamicToolInputSchema(inputSchema) as any;
    expect(schema.properties.at).toMatchObject({
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "integer", minimum: -64, maximum: 64 },
    });
    expect(Array.isArray(schema.properties.at.items)).toBe(false);
    expect(schema.properties.mixed.items.anyOf).toEqual([
      { type: "string" },
      { type: "integer" },
    ]);
    expect(inputSchema.safeParse({ at: [0, 1], mixed: ["ok", 1] }).success).toBe(false);
    expect(inputSchema.safeParse({ at: [0, 1, 2], mixed: ["ok", 1] }).success).toBe(true);
  });

  it("brokers auth refresh and projects tools/text through the provider seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "smbmc-codex-fake-"));
    roots.push(root);
    const executable = join(root, "fake-codex");
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const forbiddenRoot = ${JSON.stringify(root)};
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
  else if (message.method === "account/login/start") {
    const valid = message.params.type === "chatgptAuthTokens" &&
      typeof message.params.accessToken === "string" &&
      typeof message.params.chatgptAccountId === "string";
    if (!valid) send({ id: message.id, error: { code: -1, message: "invalid external auth" } });
    else send({ id: message.id, result: { type: "chatgptAuthTokens" } });
  }
  else if (message.method === "account/read") {
    if (message.params.refreshToken === true) {
      const authPath = path.join(process.env.CODEX_HOME, "auth.json");
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      auth.tokens.access_token = "refreshed-access-token";
      fs.writeFileSync(authPath, JSON.stringify(auth));
    }
    send({ id: message.id, result: { account: { type: process.env.OPENAI_API_KEY ? "apiKey" : "chatgpt", planType: "pro" }, requiresOpenaiAuth: true } });
  }
  else if (message.method === "thread/start") {
    const isolated = message.params.cwd !== forbiddenRoot && process.env.HOME !== forbiddenRoot &&
      message.params.runtimeWorkspaceRoots.length === 0 && message.params.environments.length === 0 &&
      message.params.dynamicTools.length === 1;
    if (!isolated) send({ id: message.id, error: { code: -1, message: "not isolated" } });
    else send({ id: message.id, result: { thread: { id: "thread-1" } } });
  }
  else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    setImmediate(() => send({ id: "auth-refresh", method: "account/chatgptAuthTokens/refresh", params: {
      reason: "expired", previousAccountId: "test-account-id"
    }}));
  } else if (message.id === "auth-refresh" && message.result?.accessToken === "refreshed-access-token") {
    send({ id: "tool-request", method: "item/tool/call", params: {
      threadId: "thread-1", turnId: "turn-1", callId: "call-1", namespace: null,
      tool: "say", arguments: { text: "hello" }
    }});
  } else if (message.id === "tool-request" && message.result) {
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "done" } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "done" } } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-2", text: "tail" } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
  }
});
`);
    chmodSync(executable, 0o755);
    writeFileSync(join(root, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "test-access-token",
        account_id: "test-account-id",
      },
    }));
    const previousHome = process.env.CODEX_HOME;
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.CODEX_HOME = root;
    process.env.OPENAI_API_KEY = "must-not-reach-codex";
    const handler = vi.fn(async () => ({ ok: true, summary: "said hello" }));
    const client = createCodexClient([{
      name: "say",
      description: "Say something.",
      policy: { minimumRole: "viewer", effect: "communicate", reversible: false, mission: "forbidden" },
      inputSchema: z.object({ text: z.string() }),
      handler,
    }], {
      codexExecutable: executable,
    });

    try {
      const events: SessionEvent[] = [];
      for await (const event of client.sendMessage("reply", { system: "test" })) {
        events.push(event);
      }
      expect(handler).toHaveBeenCalledWith({ text: "hello" });
      expect(events).toEqual([
        { kind: "toolUse", name: "say", input: { text: "hello" } },
        { kind: "text", text: "done" },
        { kind: "text", text: "tail" },
      ]);
    } finally {
      client.close?.();
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  it("projects a wrapped BuildOps definition through the Codex dynamic-tool schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "smbmc-codex-buildops-"));
    roots.push(root);
    const executable = join(root, "fake-codex");
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "account/login/start") send({ id: message.id, result: {} });
  else if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  else if (message.method === "thread/start") {
    const tool = message.params.dynamicTools[0];
    const definition = tool?.inputSchema?.properties?.definition;
    const putCoordinates = definition?.anyOf?.[0]?.properties?.ops?.items?.anyOf?.[0]?.properties?.at;
    const compatible = message.params.dynamicTools.length === 1 &&
      tool?.name === "previewBuildDefinition" && definition?.type !== "string" &&
      Array.isArray(definition?.anyOf) && definition.anyOf.length === 2 &&
      putCoordinates?.minItems === 3 && putCoordinates?.maxItems === 3 &&
      putCoordinates?.items?.type === "integer" && !Array.isArray(putCoordinates?.items);
    if (!compatible) send({ id: message.id, error: { message: "BuildOps schema was not an object union" } });
    else send({ id: message.id, result: { thread: { id: "build-thread" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "build-turn" } } });
    setImmediate(() => send({ id: "build-call", method: "item/tool/call", params: {
      threadId: "build-thread", turnId: "build-turn", callId: "build-call", namespace: null,
      tool: "previewBuildDefinition", arguments: { definition: {
        schema: "smartbot.build/v1", name: "marker", targetVersion: "1.21.11",
        ops: [{ op: "put", at: [0, 0, 0], block: "stone" }]
      }}
    }}));
  } else if (message.id === "build-call") {
    send({ method: "turn/completed", params: { threadId: "build-thread", turn: { id: "build-turn", status: "completed", error: null } } });
  }
});
`);
    chmodSync(executable, 0o755);
    writeFileSync(join(root, "auth.json"), JSON.stringify({
      tokens: { access_token: "test-access-token", account_id: "test-account-id" },
    }));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    const handler = vi.fn(async () => ({ ok: true, summary: "previewed" }));
    const client = createCodexClient([{
      name: "previewBuildDefinition",
      description: "Preview a BuildOps definition.",
      policy: { minimumRole: "operator", effect: "read", reversible: false, mission: "forbidden" },
      inputSchema: previewBuildDefinitionSchema,
      handler,
    }], { codexExecutable: executable });

    try {
      for await (const _event of client.sendMessage("preview", { system: "test" })) {
        // The fake's assertion is in its thread/start handling; consume events.
      }
      expect(handler).toHaveBeenCalledWith({
        definition: {
          schema: "smartbot.build/v1", name: "marker", targetVersion: "1.21.11",
          ops: [{ op: "put", at: [0, 0, 0], block: "stone" }],
        },
      });
    } finally {
      client.close?.();
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });
});
