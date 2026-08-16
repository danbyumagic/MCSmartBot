import type { AppLogEntry } from "./contracts.js";

export interface AppLogBuffer {
  append(input: Omit<AppLogEntry, "id">): AppLogEntry;
  entries(afterId?: number): AppLogEntry[];
  clear(): void;
  subscribe(listener: (entry: AppLogEntry) => void): () => void;
}

export function createAppLogBuffer(options: { capacity?: number } = {}): AppLogBuffer {
  const capacity = options.capacity ?? 500;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error("log buffer capacity must be a positive safe integer");
  }

  let nextId = 1;
  let records: AppLogEntry[] = [];
  const listeners = new Set<(entry: AppLogEntry) => void>();

  function append(input: Omit<AppLogEntry, "id">): AppLogEntry {
    const record: AppLogEntry = clone({
      ...input,
      id: nextId++,
      context: input.context,
    });
    records.push(record);
    if (records.length > capacity) records = records.slice(-capacity);

    for (const listener of [...listeners]) {
      try {
        listener(clone(record));
      } catch {
        // One renderer/subscriber must not prevent delivery to other listeners.
      }
    }
    return clone(record);
  }

  function entries(afterId?: number): AppLogEntry[] {
    const selected = afterId === undefined
      ? records
      : records.filter((record) => record.id > afterId);
    return selected.map((record) => clone(record));
  }

  function clear(): void {
    records = [];
  }

  function subscribe(listener: (entry: AppLogEntry) => void): () => void {
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  }

  return { append, entries, clear, subscribe };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
