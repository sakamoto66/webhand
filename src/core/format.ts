/** How values are written into what Claude reads, what Jev receives, and the logs. */

/** A value as JSON, the way the CLI quotes a value inside a message. */
export function quote(value: unknown): string {
  return toJson(value);
}

/** Strings as they are, anything else as JSON. */
export function show(value: unknown): string {
  return typeof value === "string" ? value : quote(value);
}

/**
 * Compact JSON. Maps keep their insertion order, which a plain object would not keep for keys like
 * "2" and "1". Undefined object entries are dropped; undefined elsewhere is null.
 */
export function toJson(value: unknown): string {
  const encode = (item: unknown): string => {
    if (item === null || item === undefined) return "null";
    if (typeof item === "number") return Number.isFinite(item) ? JSON.stringify(item) : "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    const entries = item instanceof Map ? [...item] : Object.entries(item as object);
    return `{${entries
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(String(k))}:${encode(v)}`)
      .join(",")}}`;
  };
  return encode(value);
}

/** A run folder name: YYYYMMDDTHHMMSS in local time. */
export function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** An error for a log line: its name and message. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Error: ${String(error)}`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
