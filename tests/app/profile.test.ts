import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeProfile, summarizeRuntimeProfile } from "../../src/app/profile.js";

function makeProfile(overrides = ""): { root: string; envPath: string } {
  const root = mkdtempSync(join(tmpdir(), "smbmc-profile-"));
  const envPath = join(root, ".env");
  writeFileSync(envPath, [
    "SERVER_HOST=localhost",
    "SERVER_PORT=25565",
    "SERVER_VERSION=1.21.11",
    "BOT_USERNAME=SmartBot",
    "BOT_AUTH=offline",
    "OWNER_USERNAME=alice",
    "DATA_DIR=./data",
    overrides,
  ].filter(Boolean).join("\n") + "\n");
  return { root, envPath };
}

describe("loadRuntimeProfile", () => {
  it("loads a structured JSON profile with Microsoft and OpenRouter settings", () => {
    const root = mkdtempSync(join(tmpdir(), "smbmc-json-profile-"));
    const profilePath = join(root, "smartbot.json");
    writeFileSync(profilePath, JSON.stringify({
      version: 1,
      server: { host: "json-host", port: 25565, version: "1.21.11" },
      minecraft: { username: "player@example.com", auth: "microsoft" },
      ownerUsername: "alice",
      agent: {
        provider: "openrouter",
        apiKey: "sk-or-test",
        model: "openai/gpt-4o-mini",
      },
      dataDir: "./data",
    }));
    try {
      const profile = loadRuntimeProfile({ envPath: profilePath, processEnv: {} });
      expect(profile.config).toMatchObject({
        serverHost: "json-host",
        botUsername: "player@example.com",
        botAuth: "microsoft",
        agentProvider: "openrouter",
        agentApiKey: "sk-or-test",
      });
      expect(profile.config.dataDir).toBe(join(root, "data"));
      expect(summarizeRuntimeProfile(profile).displayPath).toBe(profilePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads dotenv values, process overrides, adjacent server config, and resolves data", () => {
    const { root, envPath } = makeProfile("SERVER_HOST=file-host");
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "server.json"), JSON.stringify({ name: "ExampleServer" }));
    try {
      const profile = loadRuntimeProfile({
        envPath,
        processEnv: { SERVER_HOST: "process-host" },
      });
      expect(profile.config.serverHost).toBe("process-host");
      expect(profile.config.dataDir).toBe(join(root, "data"));
      expect(profile.serverConfig.name).toBe("ExampleServer");
      expect(summarizeRuntimeProfile(profile)).toMatchObject({
        configured: true,
        serverHost: "process-host",
        serverLabel: "ExampleServer",
        botUsername: "SmartBot",
        agentProvider: "codex",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves absolute data directories and supports absolute provider paths", () => {
    const { root, envPath } = makeProfile(
      "DATA_DIR=/tmp/smartbot-data\n" +
      "CLAUDE_CODE_EXECUTABLE=/opt/homebrew/bin/claude\n" +
      "CODEX_EXECUTABLE=/opt/homebrew/bin/codex",
    );
    try {
      const profile = loadRuntimeProfile({ envPath, processEnv: {} });
      expect(profile.config.dataDir).toBe("/tmp/smartbot-data");
      expect(profile.config.claudeCodeExecutable).toBe("/opt/homebrew/bin/claude");
      expect(profile.config.codexExecutable).toBe("/opt/homebrew/bin/codex");
      expect(summarizeRuntimeProfile(profile).displayPath).toBe(envPath);
      expect(JSON.stringify(summarizeRuntimeProfile(profile))).not.toContain("homebrew");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty adjacent server config when server.json is absent", () => {
    const { root, envPath } = makeProfile();
    try {
      expect(loadRuntimeProfile({ envPath, processEnv: {} }).serverConfig).toEqual({
        commands: [],
        notes: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing profile and relative provider override without exposing values", () => {
    const { root, envPath } = makeProfile("CLAUDE_CODE_EXECUTABLE=claude");
    try {
      expect(() => loadRuntimeProfile({ envPath, processEnv: {} })).toThrow(/Invalid configuration/);
      writeFileSync(envPath, readFileSync(envPath, "utf8").replace(
        "CLAUDE_CODE_EXECUTABLE=claude",
        "CODEX_EXECUTABLE=codex",
      ));
      expect(() => loadRuntimeProfile({ envPath, processEnv: {} })).toThrow(/Invalid configuration/);
      expect(() => loadRuntimeProfile({ envPath: join(root, "missing.env"), processEnv: {} }))
        .toThrow(/runtime profile file not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
