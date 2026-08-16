import pino, { type Logger } from "pino";
import type { AppLogLevel } from "../app/contracts.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface CreateLoggerOptions {
  level: LogLevel;
  pretty?: boolean;
  onRecord?: (record: {
    ts: number;
    level: AppLogLevel;
    component: string;
    message: string;
    context: Record<string, unknown>;
  }) => void;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const pretty = opts.pretty ?? process.env.NODE_ENV !== "production";
  const onRecord = opts.onRecord;
  return pino({
    level: opts.level,
    transport: pretty
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
            singleLine: true,
            messageFormat: "{component} {msg}",
          },
        }
      : undefined,
    hooks: {
      logMethod: onRecord
        ? function logMethod(this: Logger, args, method, level) {
            try {
              const normalized = normalizeLogArgs(args as unknown[]);
              const bindings = this.bindings() as Record<string, unknown>;
              const component = typeof bindings.component === "string"
                ? limitString(bindings.component, 4_000)
                : "app";
              onRecord({
                ts: Date.now(),
                level: levelName(level),
                component,
                message: normalized.message,
                context: sanitizeObject(normalized.context),
              });
            } catch {
              // Observability must never change the behavior of the real logger.
            }
            method.apply(this, args);
          }
        : undefined,
    },
  });
}

export type { Logger };

function normalizeLogArgs(args: unknown[]): {
  message: string;
  context: Record<string, unknown>;
} {
  const [first, second] = args;
  if (typeof first === "string") {
    return { message: limitString(first, 4_000), context: {} };
  }
  if (first instanceof Error) {
    return {
      message: typeof second === "string" ? limitString(second, 4_000) : "",
      context: { err: first },
    };
  }
  if (isRecord(first)) {
    return {
      message: typeof second === "string" ? limitString(second, 4_000) : "",
      context: first,
    };
  }
  return {
    message: first === undefined ? "" : limitString(String(first), 4_000),
    context: {},
  };
}

function levelName(level: number): AppLogLevel {
  if (level <= 10) return "trace";
  if (level <= 20) return "debug";
  if (level <= 30) return "info";
  if (level <= 40) return "warn";
  return "error";
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(value, 0, new WeakSet<object>()) as Record<string, unknown>;
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  key?: string,
): unknown {
  if (key && /password|passwd|secret|token|authorization|cookie/i.test(key)) {
    return "[redacted]";
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return limitString(value, 4_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value instanceof Error) {
    return {
      name: limitString(value.name, 256),
      message: limitString(value.message, 4_000),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, 50)
        .map((entry) => sanitizeValue(entry, depth + 1, seen))
        .filter((entry) => entry !== undefined);
    }
    if (!isRecord(value)) return limitString(String(value), 4_000);
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, 50)) {
      const sanitized = sanitizeValue(entryValue, depth + 1, seen, entryKey);
      if (sanitized !== undefined) output[entryKey] = sanitized;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitString(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
