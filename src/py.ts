/**
 * Python-compatible formatting. What the CLI prints is measured (handoff chars) and read by Claude,
 * so it stays exactly as the Python implementation printed it.
 */

// Python's str.isprintable() is false for these: other (Cc, Cf, Cs, Co, Cn) and separators except the space.
const NOT_PRINTABLE = /[\p{C}\p{Z}]/u;

function escapeChar(char: string, quote: string): string {
  if (char === "\\") return "\\\\";
  if (char === quote) return `\\${quote}`;
  if (char === "\n") return "\\n";
  if (char === "\r") return "\\r";
  if (char === "\t") return "\\t";
  if (char !== " " && NOT_PRINTABLE.test(char)) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x100) return `\\x${code.toString(16).padStart(2, "0")}`;
    if (code < 0x10000) return `\\u${code.toString(16).padStart(4, "0")}`;
    return `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return char;
}

function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let body = "";
  for (const char of text) body += escapeChar(char, quote);
  return quote + body + quote;
}

function reprNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  return String(value);
}

/** repr() of a JSON-like value. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return reprString(value);
  if (typeof value === "number") return reprNumber(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (value instanceof Map) {
    return `{${[...value].map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
      .join(", ")}}`;
  }
  return String(value);
}

/** str() of a JSON-like value, as an f-string prints it. */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  return pyRepr(value);
}

/**
 * json.dumps(value, ensure_ascii=False). Maps keep their order, which a plain object would not keep
 * for keys like "2" and "1". compact gives the separators httpx uses for a request body.
 */
export function pyJson(value: unknown, compact = false): string {
  const comma = compact ? "," : ", ";
  const colon = compact ? ":" : ": ";
  const encode = (item: unknown): string => {
    if (item === null || item === undefined) return "null";
    if (typeof item === "number") return Number.isFinite(item) ? JSON.stringify(item) : "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(comma)}]`;
    const entries = item instanceof Map ? [...item] : Object.entries(item as object);
    return `{${entries
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(String(k))}${colon}${encode(v)}`)
      .join(comma)}}`;
  };
  return encode(value);
}

/** round() to an int: halves go to the even neighbour. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python truthiness: None, False, 0, "", [] and {} are false. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** time.strftime("%Y%m%dT%H%M%S") in local time. */
export function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** datetime.now(timezone.utc).isoformat(). */
export function utcIso(date = new Date()): string {
  return `${date.toISOString().slice(0, 23)}000+00:00`;
}

/** The length Python reports for a str: code points, not UTF-16 units. */
export function pyLen(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** type(error).__name__: error, as Python formats an exception for a log. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Error: ${String(error)}`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
