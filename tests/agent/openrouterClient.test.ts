import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenRouterClient } from "../../src/agent/openrouterClient.js";
import type { SessionEvent } from "../../src/agent/client.js";

describe("OpenRouter client", () => {
  it("executes function tools and continues the conversation", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
      const toolResultSent = body.messages.some((message) => message.role === "tool");
      return new Response(JSON.stringify(toolResultSent
        ? { choices: [{ message: { role: "assistant", content: "done" } }] }
        : {
            choices: [{ message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: { name: "say", arguments: JSON.stringify({ text: "hello" }) },
              }],
            } }],
          }), { status: 200 });
    });
    const handler = vi.fn(async () => ({ ok: true, summary: "said hello" }));
    const client = createOpenRouterClient([{
      name: "say",
      description: "Say something.",
      policy: { minimumRole: "viewer", effect: "communicate", reversible: false, mission: "forbidden" },
      inputSchema: z.object({ text: z.string() }),
      handler,
    }], {
      apiKey: "sk-or-secret",
      model: "openai/gpt-4o-mini",
      fetch,
    });

    const events: SessionEvent[] = [];
    for await (const event of client.sendMessage("reply", { system: "system" })) events.push(event);

    expect(handler).toHaveBeenCalledWith({ text: "hello" });
    expect(events).toEqual([
      { kind: "toolUse", name: "say", input: { text: "hello" } },
      { kind: "text", text: "done" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((requests[0]?.init?.headers as Record<string, string>).authorization)
      .toBe("Bearer sk-or-secret");
  });

  it("does not expose upstream response bodies for HTTP failures", async () => {
    const fetch = vi.fn(async () => new Response("token=sk-or-secret", { status: 401 }));
    const client = createOpenRouterClient([], { apiKey: "sk-or-secret", fetch });
    const consume = async (): Promise<void> => {
      for await (const _event of client.sendMessage("reply", { system: "system" })) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow("HTTP 401");
    await expect(consume()).rejects.not.toThrow("sk-or-secret");
  });
});
