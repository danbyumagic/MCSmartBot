import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    const cfg = loadConfig({
      SERVER_HOST: "localhost",
      SERVER_PORT: "25565",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
      DATA_DIR: "./data",
      LOG_LEVEL: "info",
    });
    expect(cfg.serverPort).toBe(25565);
    expect(cfg.ownerUsername).toBe("alice");
    expect(cfg.botAuth).toBe("offline");
    expect(cfg.agentProvider).toBe("codex");
  });

  it("keeps Anthropic as a selectable provider", () => {
    const cfg = loadConfig({
      SERVER_HOST: "localhost",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
      AGENT_PROVIDER: "anthropic",
    });
    expect(cfg.agentProvider).toBe("anthropic");
  });

  it("accepts an OpenRouter API-key provider and safe defaults", () => {
    const cfg = loadConfig({
      SERVER_HOST: "localhost",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
      AGENT_PROVIDER: "openrouter",
      AGENT_API_KEY: "sk-or-test",
    });
    expect(cfg.agentProvider).toBe("openrouter");
    expect(cfg.agentApiKey).toBe("sk-or-test");
    expect(cfg.agentModel).toBe("openai/gpt-4o-mini");
    expect(cfg.agentBaseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("accepts one safe command to run after the initial spawn", () => {
    const cfg = loadConfig({
      SERVER_HOST: "localhost",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
      JOIN_COMMAND: "server Survival",
    });
    expect(cfg.joinCommand).toBe("server Survival");
    expect(() => loadConfig({
      SERVER_HOST: "localhost",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
      JOIN_COMMAND: "/server Survival",
    })).toThrow(/JOIN_COMMAND/);
  });

  it("throws on missing required field", () => {
    expect(() => loadConfig({ SERVER_HOST: "localhost" })).toThrow(/OWNER_USERNAME/);
  });

  it("rejects an invalid auth value", () => {
    expect(() =>
      loadConfig({
        SERVER_HOST: "localhost",
        SERVER_PORT: "25565",
        SERVER_VERSION: "1.21.11",
        BOT_USERNAME: "SmartBot",
        BOT_AUTH: "wat",
        OWNER_USERNAME: "alice",
      }),
    ).toThrow(/BOT_AUTH/);
  });

  it("applies sensible defaults for reactive thresholds", () => {
    const cfg = loadConfig({
      SERVER_HOST: "localhost",
      SERVER_PORT: "25565",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
    });
    expect(cfg.hpFleeThreshold).toBe(6);
    expect(cfg.foodEatThreshold).toBe(14);
  });

  it("honors explicit reactive threshold env vars", () => {
    const cfg = loadConfig({
      SERVER_HOST: "localhost",
      SERVER_PORT: "25565",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
      HP_FLEE_THRESHOLD: "10",
      FOOD_EAT_THRESHOLD: "16",
    });
    expect(cfg.hpFleeThreshold).toBe(10);
    expect(cfg.foodEatThreshold).toBe(16);
  });

  it("applies default agentIdleTickMinutes", () => {
    const cfg = loadConfig({
      SERVER_HOST: "localhost",
      SERVER_PORT: "25565",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
    });
    expect(cfg.agentIdleTickMinutes).toBe(5);
  });

  it("honors AGENT_IDLE_TICK_MINUTES env override", () => {
    const cfg = loadConfig({
      SERVER_HOST: "localhost",
      SERVER_PORT: "25565",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
      AGENT_IDLE_TICK_MINUTES: "10",
    });
    expect(cfg.agentIdleTickMinutes).toBe(10);
  });

  it("applies reconnect defaults and accepts overrides", () => {
    const base = {
      SERVER_HOST: "localhost",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
    };
    const defaults = loadConfig(base);
    expect(defaults.reconnectBaseDelayMs).toBe(1_000);
    expect(defaults.reconnectMaxDelayMs).toBe(60_000);
    expect(defaults.reconnectJitterRatio).toBe(0.2);
    const custom = loadConfig({
      ...base,
      RECONNECT_BASE_DELAY_MS: "500",
      RECONNECT_MAX_DELAY_MS: "10000",
      RECONNECT_JITTER_RATIO: "0",
    });
    expect(custom.reconnectBaseDelayMs).toBe(500);
    expect(custom.reconnectMaxDelayMs).toBe(10_000);
    expect(custom.reconnectJitterRatio).toBe(0);
  });

  it("enables a loopback dashboard by default and accepts overrides", () => {
    const base = {
      SERVER_HOST: "localhost",
      SERVER_VERSION: "1.21.11",
      BOT_USERNAME: "SmartBot",
      BOT_AUTH: "offline",
      OWNER_USERNAME: "alice",
    };
    const defaults = loadConfig(base);
    expect(defaults.dashboardEnabled).toBe(true);
    expect(defaults.dashboardHost).toBe("127.0.0.1");
    expect(defaults.dashboardPort).toBe(8787);
    const custom = loadConfig({
      ...base,
      DASHBOARD_ENABLED: "false",
      DASHBOARD_HOST: "::1",
      DASHBOARD_PORT: "9000",
    });
    expect(custom.dashboardEnabled).toBe(false);
    expect(custom.dashboardHost).toBe("::1");
    expect(custom.dashboardPort).toBe(9000);
  });

});
