import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface InstanceLock {
  path: string;
  release(): void;
}

export interface InstanceLockOptions {
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Acquire a filesystem-backed, cross-platform single-instance lock.
 *
 * The lock survives process crashes, so an existing PID is checked before a
 * stale lock is reclaimed. Exclusive file creation makes simultaneous starts
 * race safely: exactly one process wins.
 */
export function acquireInstanceLock(
  dataDir: string,
  options: InstanceLockOptions = {},
): InstanceLock {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "smartbot.lock");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, JSON.stringify({
          pid,
          startedAt: Date.now(),
        }));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try {
            const owner = readLockPid(path);
            if (owner === pid) unlinkSync(path);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        },
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "EEXIST") throw err;
      const existingPid = readLockPid(path);
      if (existingPid !== undefined && isAlive(existingPid)) {
        throw new Error(
          `another SmartBot instance is already running (pid ${existingPid})`,
        );
      }
      // The prior process is gone or the lock is malformed. Reclaim only this
      // exact lock file, then retry exclusive creation once.
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }
  }
  throw new Error("could not acquire SmartBot instance lock");
}

function readLockPid(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
