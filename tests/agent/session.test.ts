import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { appendConversation, getRecentConversations } from "../../src/memory/conversations.js";
import { createAgentSession } from "../../src/agent/session.js";
import { createSayTool } from "../../src/agent/tools.js";
import { createPreviewBuildDefinitionTool } from "../../src/agent/constructionTools.js";
import { createLogger } from "../../src/util/logger.js";
import type { SessionEvent } from "../../src/agent/session.js";

const anthropicSdk = vi.hoisted(() => ({
  tool: vi.fn((name: string, description: string, shape: unknown, handler: (args: unknown) => Promise<unknown>) => ({
    name, description, shape, handler,
  })),
  createSdkMcpServer: vi.fn(({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools })),
  query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => anthropicSdk);

let tmp: string;
let db: DB;
afterEach(() => {
  db?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  anthropicSdk.tool.mockClear();
  anthropicSdk.createSdkMcpServer.mockClear();
  anthropicSdk.query.mockReset();
});

describe("AgentSession (fake client)", () => {
  it("executes a say tool call and records the bot's reply", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    const sent: string[] = [];
    const recordedReplies: string[] = [];
    const sayTool = createSayTool(
      (t) => sent.push(t),
      (t) => {
        recordedReplies.push(t);
        appendConversation(db, { speaker: "bot", text: t, channel: "chat" });
      },
    );

    // Test-seam: the fake client must call tool handlers itself before yielding toolUse
    // events. In production the real MCP server handles execution; here we simulate that
    // by invoking the handler directly so side-effects (sendChat, recordBotReply) occur.
    const fakeClient = {
      async *sendMessage(): AsyncIterable<SessionEvent> {
        await sayTool.handler({ text: "hello alice" });
        yield { kind: "toolUse" as const, name: "say", input: { text: "hello alice" } };
      },
    };

    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [sayTool],
      createClient: () => fakeClient,
    });

    await session.handleTrigger({ kind: "chat", from: "alice", text: "hi" });
    expect(sent).toEqual(["hello alice"]);
    expect(recordedReplies).toEqual(["hello alice"]);
    const rows = getRecentConversations(db, 10);
    expect(rows.some((r) => r.speaker === "bot" && r.text === "hello alice")).toBe(true);
  });

  it("formats skillDone observations into the user message", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    let lastMessage = "";
    const sayTool = createSayTool(() => {}, () => {});

    const fakeClient = {
      async *sendMessage(message: string): AsyncIterable<SessionEvent> {
        lastMessage = message;
        yield { kind: "text" as const, text: "ok" };
      },
    };

    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [sayTool],
      createClient: () => fakeClient,
    });

    await session.handleTrigger({
      kind: "skillDone",
      skill: "gotoCoords",
      ok: true,
      summary: "Reached (1,2,3).",
    });
    expect(lastMessage).toMatch(/skill gotoCoords finished/);
    expect(lastMessage).toMatch(/Reached/);
  });

  it("formats skillFailed observations into the user message", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    let lastMessage = "";
    const sayTool = createSayTool(() => {}, () => {});

    const fakeClient = {
      async *sendMessage(message: string): AsyncIterable<SessionEvent> {
        lastMessage = message;
        yield { kind: "text" as const, text: "ok" };
      },
    };

    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [sayTool],
      createClient: () => fakeClient,
    });

    await session.handleTrigger({
      kind: "skillFailed",
      skill: "gotoCoords",
      error: "no path",
      code: "NO_PATH",
      recoverable: true,
    });
    expect(lastMessage).toMatch(/gotoCoords FAILED/);
    expect(lastMessage).toMatch(/code=NO_PATH/);
    expect(lastMessage).toMatch(/recoverable=true/);
    expect(lastMessage).toMatch(/no path/);
  });

  it("formats reflexAlert observations into the user message", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    let lastMessage = "";
    const sayTool = createSayTool(() => {}, () => {});

    const fakeClient = {
      async *sendMessage(message: string): AsyncIterable<SessionEvent> {
        lastMessage = message;
        yield { kind: "text" as const, text: "ok" };
      },
    };

    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [sayTool],
      createClient: () => fakeClient,
    });

    await session.handleTrigger({ kind: "reflexAlert", summary: "fled to safe_spot" });
    expect(lastMessage).toMatch(/reflex/i);
    expect(lastMessage).toMatch(/fled/);
  });

  it("formats idleTick observations into the user message", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    let lastMessage = "";
    const sayTool = createSayTool(() => {}, () => {});

    const fakeClient = {
      async *sendMessage(message: string): AsyncIterable<SessionEvent> {
        lastMessage = message;
        yield { kind: "text" as const, text: "ok" };
      },
    };

    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [sayTool],
      createClient: () => fakeClient,
    });

    await session.handleTrigger({ kind: "idleTick" });
    expect(lastMessage).toMatch(/idle tick/i);
  });

  it("sets the current requester and role before handling a chat trigger", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    const actorContext = {
      username: "alice",
      role: "owner" as "owner" | "operator" | "viewer",
      source: "cli" as const,
    };
    let observedActor = "";
    let message = "";
    const fakeClient = {
      async *sendMessage(input: string): AsyncIterable<SessionEvent> {
        message = input;
        observedActor = `${actorContext.username}:${actorContext.role}`;
        yield { kind: "text" as const, text: "ok" };
      },
    };
    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [],
      createClient: () => fakeClient,
      actorContext,
      resolveRole: (username) => username === "bob" ? "operator" : undefined,
    });
    await session.handleTrigger({ kind: "chat", from: "bob", text: "status" });
    expect(observedActor).toBe("bob:operator");
    expect(message).toMatch(/bob \(in-game role=operator\)/);
    await session.handleTrigger({ kind: "idleTick" });
    expect(actorContext).toEqual({ username: "alice", role: "owner", source: "recovery" });
  });

  it("records desktop instructions as the configured owner with desktop provenance", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    const actorContext = {
      username: "alice",
      role: "owner" as "owner" | "operator" | "viewer",
      source: "cli" as const,
    };
    const fakeClient = {
      async *sendMessage(): AsyncIterable<SessionEvent> {
        yield { kind: "text" as const, text: "ok" };
      },
    };
    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [],
      createClient: () => fakeClient,
      actorContext,
    });

    await session.handleTrigger({
      kind: "cli",
      text: "inspect base",
      executionSource: "desktop",
    });

    expect(actorContext).toEqual({ username: "alice", role: "owner", source: "desktop" });
  });

  it("injects current live bot state into every agent turn", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    let message = "";
    const fakeClient = {
      async *sendMessage(input: string): AsyncIterable<SessionEvent> {
        message = input;
        yield { kind: "text" as const, text: "ok" };
      },
    };
    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [],
      createClient: () => fakeClient,
      runtimeContext: () =>
        "health=20 food=18 active_skill=followPlayer | inventory 2/36 slots (34 free)",
    });

    await session.handleTrigger({ kind: "chat", from: "alice", text: "status" });

    expect(message).toMatch(/Current live bot state:/);
    expect(message).toMatch(/active_skill=followPlayer/);
    expect(message).toMatch(/34 free/);
  });

  it("aborts a stalled AI turn instead of blocking later triggers forever", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    const fakeClient = {
      async *sendMessage(
        _input: string,
        opts: { signal?: AbortSignal },
      ): AsyncIterable<SessionEvent> {
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [],
      createClient: () => fakeClient,
      agentTurnTimeoutMs: 5,
    });

    await expect(session.handleTrigger({
      kind: "chat",
      from: "alice",
      text: "hello?",
    })).rejects.toThrow(/timed out/i);
  });

  it("allows an emergency stop to abort the current AI turn immediately", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const fakeClient = {
      async *sendMessage(
        _input: string,
        opts: { signal?: AbortSignal },
      ): AsyncIterable<SessionEvent> {
        started();
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [],
      createClient: () => fakeClient,
    });
    const handling = session.handleTrigger({ kind: "chat", from: "alice", text: "long task" });
    await didStart;
    expect(session.cancelCurrent()).toBe(true);
    await expect(handling).resolves.toBeUndefined();
    expect(session.cancelCurrent()).toBe(false);
  });

  it("passes the discovered Claude path and profile root to the client seam", () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    let received: {
      provider: "codex" | "anthropic";
      claudeCodeExecutable?: string;
      codexExecutable?: string;
      workingDirectory: string;
    } | undefined;
    const fakeClient = {
      async *sendMessage(): AsyncIterable<SessionEvent> {
        yield { kind: "text" as const, text: "ok" };
      },
    };
    createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [],
      claudeCodeExecutable: "/opt/homebrew/bin/claude",
      workingDirectory: "/tmp/smartbot-profile",
      createClient: (options) => {
        received = options;
        return fakeClient;
      },
    });
    expect(received).toEqual({
      provider: "anthropic",
      claudeCodeExecutable: "/opt/homebrew/bin/claude",
      codexExecutable: undefined,
      workingDirectory: "/tmp/smartbot-profile",
    });
  });

  it("registers and invokes a wrapped BuildOps definition through the Anthropic MCP seam", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
    db = openDatabase(join(tmp, "memory.sqlite"));
    const definition = {
      schema: "smartbot.build/v1",
      name: "marker",
      targetVersion: "1.21.11",
      ops: [{ op: "put", at: [0, 0, 0], block: "stone" }],
    };
    const service = {
      previewBuildDefinition: vi.fn().mockReturnValue({
        ok: true,
        value: {
          schema: "smartbot.build/v1",
          name: "marker",
          targetVersion: "1.21.11",
          placements: [{ x: 0, y: 0, z: 0, block: "stone" }],
          report: {
            operationCount: 1,
            placementCount: 1,
            worldCellCount: 1,
            bounds: { min: [0, 0, 0], max: [0, 0, 0] },
            materials: { stone: 1 },
            overwrites: 0,
            punches: 0,
            warnings: [],
            diagnostics: [],
            requiredAccess: "operator",
            sourceHash: "a".repeat(64),
          },
        },
      }),
    } as any;
    anthropicSdk.query.mockImplementation((request: any) => (async function* () {
      const server = request.options.mcpServers["smartbot-tools"] as { tools: Array<{ name: string; handler: (input: unknown) => Promise<unknown> }> };
      const tool = server.tools.find((candidate) => candidate.name === "previewBuildDefinition");
      await tool!.handler({ definition });
      yield {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "mcp__smartbot-tools__previewBuildDefinition",
            input: { definition },
          }],
        },
      };
    })());

    const session = createAgentSession({
      log: createLogger({ level: "error" }),
      db,
      ownerUsername: "alice",
      tools: [createPreviewBuildDefinitionTool(service, undefined)],
      agentProvider: "anthropic",
    });
    await session.handleTrigger({ kind: "chat", from: "alice", text: "preview this" });

    expect(anthropicSdk.tool).toHaveBeenCalledWith(
      "previewBuildDefinition",
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
    const shape = anthropicSdk.tool.mock.calls[0]![2] as { definition: { safeParse(input: unknown): { success: boolean } } };
    expect(shape.definition.safeParse(definition).success).toBe(true);
    expect(service.previewBuildDefinition).toHaveBeenCalledWith({ definition });
  });

});
