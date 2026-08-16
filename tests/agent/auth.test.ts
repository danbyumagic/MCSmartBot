import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  resolveClaudeExecutable,
  resolveCodexExecutable,
  verifyCodexSubscriptionAuth,
  verifyOpenRouterAuth,
  verifySubscriptionAuth,
  type ExecFileFn,
} from "../../src/agent/auth.js";

function executable(root: string, name: string): string {
  const path = join(root, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe("Claude executable discovery", () => {
  it("prefers an explicitly configured absolute path", () => {
    const root = mkdtempSync(join(tmpdir(), "smbmc-claude-"));
    const path = executable(root, "claude");
    try {
      expect(resolveClaudeExecutable({
        configuredPath: path,
        env: { PATH: "" },
        fallbackCandidates: [],
      })).toBe(realpathSync(path));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds PATH and Finder-style fallback candidates without a shell", () => {
    const root = mkdtempSync(join(tmpdir(), "smbmc-claude-"));
    const path = executable(root, "claude");
    try {
      expect(resolveClaudeExecutable({ env: { PATH: root }, fallbackCandidates: [] })).toBe(realpathSync(path));
      expect(resolveClaudeExecutable({
        env: { PATH: "/usr/bin:/bin" },
        platform: "darwin",
        fallbackCandidates: [path],
      })).toBe(realpathSync(path));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects relative, missing, and non-executable configured paths", () => {
    const root = mkdtempSync(join(tmpdir(), "smbmc-claude-"));
    const missing = join(root, "missing");
    const notExecutable = join(root, "not-executable");
    writeFileSync(notExecutable, "text");
    try {
      expect(() => resolveClaudeExecutable({ configuredPath: "claude" })).toThrow(/absolute/);
      expect(() => resolveClaudeExecutable({ configuredPath: missing })).toThrow(/configured/);
      expect(() => resolveClaudeExecutable({ configuredPath: notExecutable })).toThrow(/configured/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Codex executable discovery and subscription auth", () => {
  it("resolves an explicit executable and accepts ChatGPT login status", async () => {
    const root = mkdtempSync(join(tmpdir(), "smbmc-codex-"));
    const path = executable(root, "codex");
    const calls: string[][] = [];
    const run: ExecFileFn = async (executablePath, args) => {
      calls.push([executablePath, ...args]);
      return {
        stdout: args[0] === "login" ? "Logged in using ChatGPT" : "codex-cli 1.0.0",
        stderr: "",
        code: 0,
      };
    };
    try {
      mkdirSync(join(root, ".codex"));
      writeFileSync(join(root, ".codex", "auth.json"), JSON.stringify({
        tokens: {
          access_token: "test-access-token",
          account_id: "test-account-id",
        },
      }));
      const resolved = path;
      expect(resolveCodexExecutable({ configuredPath: path })).toBe(resolved);
      await expect(verifyCodexSubscriptionAuth({
        configuredPath: path,
        homeDir: root,
        env: { PATH: "" },
        run,
      }))
        .resolves.toBe(resolved);
      expect(calls).toEqual([
        [resolved, "--version"],
        [resolved, "app-server", "--help"],
        [resolved, "login", "status"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects API-key login without exposing command output", async () => {
    const root = mkdtempSync(join(tmpdir(), "smbmc-codex-"));
    const path = executable(root, "codex");
    const run: ExecFileFn = async (_executablePath, args) => ({
      stdout: args[0] === "login" ? "Logged in using API key private-account" : "1.0.0",
      stderr: "secret-token-from-cli",
      code: 0,
    });
    try {
      await expect(verifyCodexSubscriptionAuth({ configuredPath: path, run }))
        .rejects.toThrow(/ChatGPT subscription/);
      await expect(verifyCodexSubscriptionAuth({ configuredPath: path, run }))
        .rejects.not.toThrow(/private-account|secret-token/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verifySubscriptionAuth", () => {
  it("uses executable and argument arrays and returns the resolved path", async () => {
    const root = mkdtempSync(join(tmpdir(), "smbmc-claude-"));
    const path = executable(root, "claude");
    const calls: string[][] = [];
    const run: ExecFileFn = async (executablePath, args) => {
      calls.push([executablePath, ...args]);
      return { stdout: "ok", stderr: "", code: 0 };
    };
    try {
      const resolved = realpathSync(path);
      await expect(verifySubscriptionAuth({ configuredPath: path, run })).resolves.toBe(resolved);
      expect(calls).toEqual([[resolved, "--version"], [resolved, "auth", "status"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not expose raw command output in auth failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "smbmc-claude-"));
    const path = executable(root, "claude");
    const run: ExecFileFn = async (_executablePath, args) => ({
      stdout: args[0] === "--version" ? "1.2.3" : "private-account-output",
      stderr: "secret-token-from-cli",
      code: args[0] === "--version" ? 0 : 1,
    });
    try {
      await expect(verifySubscriptionAuth({ configuredPath: path, run }))
        .rejects.toThrow(/not authenticated/);
      await expect(verifySubscriptionAuth({ configuredPath: path, run }))
        .rejects.not.toThrow(/secret-token|private-account-output/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verifyOpenRouterAuth", () => {
  it("requires a key without including secret material in failures", () => {
    expect(() => verifyOpenRouterAuth({ env: {} })).toThrow(/OpenRouter API key/);
  });

  it("returns provider connection metadata without changing the key", () => {
    expect(verifyOpenRouterAuth({
      apiKey: "sk-or-test",
      model: "anthropic/claude-3.5-sonnet",
      baseUrl: "https://openrouter.ai/api/v1",
    })).toMatchObject({
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: "anthropic/claude-3.5-sonnet",
    });
  });
});
