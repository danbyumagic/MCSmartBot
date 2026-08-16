import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../../src/runtime/instanceLock.js";

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("single-instance lock", () => {
  it("rejects a second live SmartBot process", () => {
    directory = mkdtempSync(join(tmpdir(), "smartbot-lock-"));
    const first = acquireInstanceLock(directory, {
      pid: 101,
      isProcessAlive: (pid) => pid === 101,
    });
    expect(() => acquireInstanceLock(directory!, {
      pid: 202,
      isProcessAlive: (pid) => pid === 101,
    })).toThrow(/already running.*101/i);
    first.release();
  });

  it("allows another start after a clean release", () => {
    directory = mkdtempSync(join(tmpdir(), "smartbot-lock-"));
    const first = acquireInstanceLock(directory, {
      pid: 101,
      isProcessAlive: () => true,
    });
    first.release();
    const second = acquireInstanceLock(directory, {
      pid: 202,
      isProcessAlive: () => true,
    });
    expect(second.path).toBe(join(directory, "smartbot.lock"));
    second.release();
  });

  it("reclaims a stale or malformed crash lock", () => {
    directory = mkdtempSync(join(tmpdir(), "smartbot-lock-"));
    writeFileSync(join(directory, "smartbot.lock"), "{\"pid\":303}");
    const lock = acquireInstanceLock(directory, {
      pid: 404,
      isProcessAlive: () => false,
    });
    expect(lock.path).toBe(join(directory, "smartbot.lock"));
    lock.release();

    writeFileSync(join(directory, "smartbot.lock"), "not-json");
    const replacement = acquireInstanceLock(directory, {
      pid: 505,
      isProcessAlive: () => false,
    });
    replacement.release();
  });
});
