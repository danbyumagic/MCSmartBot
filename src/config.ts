import { z } from "zod";
import { isAbsolute } from "node:path";
import { AGENT_PROVIDERS, type AgentProvider } from "./agent/provider.js";

const Schema = z.object({
  SERVER_HOST: z.string().min(1),
  SERVER_PORT: z.coerce.number().int().positive().default(25565),
  SERVER_VERSION: z.string().min(1),
  BOT_USERNAME: z.string().min(1),
  BOT_AUTH: z.enum(["offline", "microsoft"]),
  JOIN_COMMAND: z.string().trim().min(1).max(256)
    .regex(/^[^/\r\n]+$/, "must omit the leading slash and contain one command line")
    .optional(),

  OWNER_USERNAME: z.string().min(1),

  AGENT_PROVIDER: z.enum(AGENT_PROVIDERS).default("codex"),

  // API-key providers are deliberately optional at schema-parse time. The
  // selected provider's startup preflight gives the actionable error when a
  // key is missing, while subscription-backed providers do not need one.
  AGENT_API_KEY: z.string().trim().min(1).optional(),
  OPENROUTER_API_KEY: z.string().trim().min(1).optional(),
  AGENT_MODEL: z.string().trim().min(1).optional(),
  OPENROUTER_MODEL: z.string().trim().min(1).default("openai/gpt-4o-mini"),
  AGENT_BASE_URL: z.string().trim().url().optional(),
  OPENROUTER_BASE_URL: z.string().trim().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_HTTP_REFERER: z.string().trim().url().optional(),

  CLAUDE_CODE_EXECUTABLE: z.string().trim().min(1)
    .refine(isAbsolute, "must be an absolute path")
    .optional(),
  CODEX_EXECUTABLE: z.string().trim().min(1)
    .refine(isAbsolute, "must be an absolute path")
    .optional(),

  DATA_DIR: z.string().min(1).default("./data"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  CHAT_MIRROR_ENABLED: z.enum(["true", "false"]).default("true"),

  HP_FLEE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(6),
  FOOD_EAT_THRESHOLD: z.coerce.number().int().min(1).max(20).default(14),
  AGENT_IDLE_TICK_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  RECONNECT_BASE_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  RECONNECT_MAX_DELAY_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  RECONNECT_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.2),
  DASHBOARD_ENABLED: z.enum(["true", "false"]).default("true"),
  DASHBOARD_HOST: z.string().min(1).default("127.0.0.1"),
  DASHBOARD_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
}).refine(
  (value) => value.RECONNECT_MAX_DELAY_MS >= value.RECONNECT_BASE_DELAY_MS,
  {
    path: ["RECONNECT_MAX_DELAY_MS"],
    message: "must be greater than or equal to RECONNECT_BASE_DELAY_MS",
  },
);

export type Config = {
  serverHost: string;
  serverPort: number;
  serverVersion: string;
  botUsername: string;
  botAuth: "offline" | "microsoft";
  joinCommand?: string;
  ownerUsername: string;
  agentProvider: AgentProvider;
  agentApiKey?: string;
  agentModel?: string;
  agentBaseUrl?: string;
  openrouterHttpReferer?: string;
  claudeCodeExecutable?: string;
  codexExecutable?: string;
  dataDir: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  chatMirrorEnabled: boolean;
  hpFleeThreshold: number;
  foodEatThreshold: number;
  agentIdleTickMinutes: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  reconnectJitterRatio: number;
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n  ");
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const v = parsed.data;
  return {
    serverHost: v.SERVER_HOST,
    serverPort: v.SERVER_PORT,
    serverVersion: v.SERVER_VERSION,
    botUsername: v.BOT_USERNAME,
    botAuth: v.BOT_AUTH,
    joinCommand: v.JOIN_COMMAND,
    ownerUsername: v.OWNER_USERNAME,
    agentProvider: v.AGENT_PROVIDER,
    agentApiKey: v.AGENT_API_KEY ?? v.OPENROUTER_API_KEY,
    agentModel: v.AGENT_MODEL ?? v.OPENROUTER_MODEL,
    agentBaseUrl: v.AGENT_BASE_URL ?? v.OPENROUTER_BASE_URL,
    openrouterHttpReferer: v.OPENROUTER_HTTP_REFERER,
    claudeCodeExecutable: v.CLAUDE_CODE_EXECUTABLE,
    codexExecutable: v.CODEX_EXECUTABLE,
    dataDir: v.DATA_DIR,
    logLevel: v.LOG_LEVEL,
    chatMirrorEnabled: v.CHAT_MIRROR_ENABLED === "true",
    hpFleeThreshold: v.HP_FLEE_THRESHOLD,
    foodEatThreshold: v.FOOD_EAT_THRESHOLD,
    agentIdleTickMinutes: v.AGENT_IDLE_TICK_MINUTES,
    reconnectBaseDelayMs: v.RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs: v.RECONNECT_MAX_DELAY_MS,
    reconnectJitterRatio: v.RECONNECT_JITTER_RATIO,
    dashboardEnabled: v.DASHBOARD_ENABLED === "true",
    dashboardHost: v.DASHBOARD_HOST,
    dashboardPort: v.DASHBOARD_PORT,
  };
}
