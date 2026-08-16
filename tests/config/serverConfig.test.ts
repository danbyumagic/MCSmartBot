import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadServerConfig,
  parseServerConfig,
  EMPTY_SERVER_CONFIG,
} from "../../src/config/serverConfig.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-srv-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadServerConfig", () => {
  it("returns the empty config when the file does not exist", () => {
    const cfg = loadServerConfig(join(tmp, "nope.json"));
    expect(cfg).toEqual(EMPTY_SERVER_CONFIG);
  });

  it("parses a well-formed file", () => {
    const path = join(tmp, "server.json");
    writeFileSync(path, JSON.stringify({
      name: "TestServer",
      publicChatCommand: "nc",
      commands: [
        { name: "home", syntax: "/home <name>", description: "Teleport to a saved home." },
        { name: "pay", syntax: "/pay <player> <amount>", description: "Send money.", destructive: true },
      ],
      notes: ["Server uses /tpa instead of vanilla tp"],
    }));
    const cfg = loadServerConfig(path);
    expect(cfg.name).toBe("TestServer");
    expect(cfg.publicChatCommand).toBe("nc");
    expect(cfg.commands).toHaveLength(2);
    expect(cfg.commands[0]?.destructive).toBe(false);
    expect(cfg.commands[1]?.destructive).toBe(true);
    expect(cfg.notes).toEqual(["Server uses /tpa instead of vanilla tp"]);
  });

  it("throws on malformed JSON", () => {
    const path = join(tmp, "server.json");
    writeFileSync(path, "{ not json");
    expect(() => loadServerConfig(path)).toThrow(/not valid JSON/);
  });

  it("throws on schema violation (missing required field on a command)", () => {
    const path = join(tmp, "server.json");
    writeFileSync(path, JSON.stringify({
      commands: [{ name: "incomplete" }],  // missing syntax + description
    }));
    expect(() => loadServerConfig(path)).toThrow(/failed validation/);
  });

  it("parseServerConfig fills defaults for omitted optional fields", () => {
    const cfg = parseServerConfig({ commands: [] });
    expect(cfg.notes).toEqual([]);
    expect(cfg.commands).toEqual([]);
    expect(cfg.publicChatCommand).toBeUndefined();
  });

  it("defaults destructive:false on commands when not specified", () => {
    const cfg = parseServerConfig({
      commands: [{ name: "x", syntax: "/x", description: "x." }],
    });
    expect(cfg.commands[0]?.destructive).toBe(false);
  });
});
