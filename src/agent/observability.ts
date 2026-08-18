const SENSITIVE_KEY = /password|passwd|secret|token|authorization|cookie|api[_-]?key/i;

/**
 * Produce a small, terminal-safe view of agent/tool inputs.
 *
 * This is deliberately not a transcript or chain-of-thought surface. It keeps
 * only operator-relevant arguments, truncates large values, and redacts common
 * credential fields before they reach stdout.
 */
export function summarizeForLog(value: unknown): unknown {
  return summarize(value, 0, new WeakSet<object>());
}

export function summarizeGoal(value: string): string {
  return compact(value, 240);
}

function summarize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return compact(value, 160);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (depth >= 3) return "[depth limit]";
  if (typeof value !== "object") return compact(String(value), 160);
  if (seen.has(value)) return "[circular]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = value.slice(0, 8).map((entry) => summarize(entry, depth + 1, seen));
      if (value.length > 8) entries.push(`[+${value.length - 8} more]`);
      return entries;
    }

    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, entry] of entries.slice(0, 12)) {
      output[key] = SENSITIVE_KEY.test(key)
        ? "[redacted]"
        : summarize(entry, depth + 1, seen);
    }
    if (entries.length > 12) output._truncated = `+${entries.length - 12} fields`;
    return output;
  } finally {
    seen.delete(value);
  }
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit - 1)}…`
    : normalized;
}
