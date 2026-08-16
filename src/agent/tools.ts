import { z } from "zod";
import type { SkillErrorCode } from "../skills/types.js";
import type { CapabilityPolicy } from "../permissions/capabilities.js";

export const saySchema = z.object({
  text: z.string().min(1).max(256).describe("Private message to the current authorized requester."),
});

export type SayInput = z.infer<typeof saySchema>;

export interface ToolResult {
  ok: boolean;
  summary: string;
  code?: SkillErrorCode;
  recoverable?: boolean;
  details?: Record<string, unknown>;
}

// inputSchema is constrained to ZodObject so that .shape always exists (no cast needed).
export interface ToolDef<I> {
  name: string;
  description: string;
  /** Explicit access/effect metadata used by the authorization boundary. */
  policy: CapabilityPolicy;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.ZodObject<any, any, any, I>;
  handler: (input: I) => Promise<ToolResult>;
}

const normalizeChatText = (text: string): string =>
  text
    .replace(/[—–]/g, " ")        // em / en dashes -> space
    .replace(/\s+/g, " ")          // collapse internal whitespace (incl. newlines)
    .trim()
    .toLowerCase();

const sayPublicSchema = z.object({
  text: z.string().min(1).max(256).describe("Public chat message visible to everyone on the server."),
});

export type SayPublicInput = z.infer<typeof sayPublicSchema>;

export function createSayPublicTool(
  sendPublicChat: (text: string) => void,
  recordBotReply: (text: string) => void,
): ToolDef<SayPublicInput> {
  return {
    name: "sayPublic",
    policy: { minimumRole: "owner", effect: "communicate", reversible: false, mission: "forbidden" },
    description:
      "Send a message to the SERVER PUBLIC CHAT visible to everyone (NOT a private whisper). " +
      "Use this only when the owner explicitly tells you to 'say in chat', 'tell everyone', 'announce', etc. " +
      "Default to the private `say` tool otherwise.",
    inputSchema: sayPublicSchema,
    handler: async ({ text }) => {
      const normalized = normalizeChatText(text);
      if (normalized.length === 0) {
        return { ok: false, summary: "sayPublic: text was empty after normalization." };
      }
      sendPublicChat(normalized);
      recordBotReply(normalized);
      return { ok: true, summary: `said publicly: ${normalized}` };
    },
  };
}

export function createSayTool(
  sendChat: (text: string) => void,
  recordBotReply: (text: string) => void,
): ToolDef<SayInput> {
  return {
    name: "say",
    policy: { minimumRole: "viewer", effect: "communicate", reversible: false, mission: "forbidden" },
    description: "Send a private chat reply to the current authorized requester in Minecraft.",
    inputSchema: saySchema,
    handler: async ({ text }) => {
      const normalized = normalizeChatText(text);
      if (normalized.length === 0) {
        return { ok: false, summary: "say: text was empty after normalization." };
      }
      sendChat(normalized);
      recordBotReply(normalized);
      return { ok: true, summary: `said: ${normalized}` };
    },
  };
}
