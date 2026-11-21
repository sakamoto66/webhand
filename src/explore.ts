/**
 * Exploring (`start --explore`): what keeps a session inside the test environment, what counts as an anomaly, and
 * how the candidates are written for Claude. Pure logic; the browser listeners are in browser.ts.
 *
 * A finding is a candidate, not a verdict: nothing here says the page is wrong. Claude reads the candidates and
 * confirms each one by repeating its steps in a new session. Only the kind of signal, the page's address without its
 * query, a clipped message and the step it followed are kept, never a typed value.
 */

import type { Page } from "./types.ts";

/** What exploring watches for. */
const SIGNALS = ["console_error", "pageerror", "http_5xx", "request_failed", "dead_end", "out_of_scope"] as const;
type Signal = (typeof SIGNALS)[number];

export interface Finding {
  signal: Signal;
  /** Host and path of the page or request; no query and no hash. */
  url: string;
  /** What the browser reported, clipped. Empty for a dead end. */
  detail: string;
  status?: number;
}

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/;

/** Hosts from --allow-domain, lower-cased. A scheme, a path or a wildcard is refused: only a host is a boundary. */
export function parseAllow(values: string[]): string[] {
  if (!values.length) throw new ExploreError("--explore needs --allow-domain HOST: the hosts it may visit");
  const hosts = values.map((value) => value.trim().toLowerCase());
  for (const host of hosts) {
    if (!HOST.test(host)) {
      throw new ExploreError(
        `--allow-domain takes a host such as shop.test or localhost:8080, not ${JSON.stringify(host)}`,
      );
    }
  }
  return [...new Set(hosts)];
}

export class ExploreError extends Error {
  override name = "ExploreError";
}

/**
 * Whether a request may go out. A host matches itself and its subdomains; a port in the rule must match. Pages
 * without a network host (about:blank, data:, blob:) are not a way out.
 */
export function hostAllowed(url: string, allow: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return ["about:", "data:", "blob:"].includes(parsed.protocol);
  return allow.some((rule) => {
    const [name, port] = rule.split(":");
    if (port && parsed.port !== port) return false;
    return parsed.hostname === name || parsed.hostname.endsWith(`.${name}`);
  });
}

/** An address as a finding keeps it: host and path. The query and hash may hold values. */
export function plainUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unknown)";
  }
}

const DETAIL_MAX = 200;

/** A browser message for a finding: one line, addresses without their queries, clipped. Page text is data. */
export function clip(text: string): string {
  const flat = text
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => plainUrl(url))
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX)}…` : flat;
}

/** The page offers nothing to do: no action other than waiting or switching tabs. */
export function isDeadEnd(page: Page): boolean {
  return !page.actions.some((action: { kind: string }) => !["wait", "tab"].includes(action.kind));
}

/** The same signal on the same address with the same message is one finding. */
export function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.signal}|${f.url}|${f.detail}|${f.status ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A logged finding event, as `findings` reads it back. */
export interface Logged extends Finding {
  step: number;
}

/** The finding events of a run log (JSON lines), in order. Lines that are not findings are skipped. */
export function loggedFindings(text: string): Logged[] {
  const found: Logged[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "finding" && SIGNALS.includes(event.signal)) {
        found.push({
          signal: event.signal,
          url: String(event.url ?? ""),
          detail: String(event.detail ?? ""),
          ...(typeof event.status === "number" ? { status: event.status } : {}),
          step: Number(event.step ?? 0),
        });
      }
    } catch {
      // A damaged line is not a finding.
    }
  }
  return found;
}

/** The text `findings` prints: the candidates, then the steps that led to them. */
export function describeFindings(found: Logged[], steps: string[]): string {
  const unique = found.filter(
    (f, i) => found.findIndex((g) => g.signal === f.signal && g.url === f.url && g.detail === f.detail) === i,
  );
  const lines = [
    unique.length
      ? `FINDINGS: ${unique.length} candidate${unique.length === 1 ? "" : "s"} (not verdicts: confirm each by repeating its steps in a new session)`
      : "FINDINGS: none",
  ];
  unique.forEach((f, i) => {
    const status = f.status ? `  status ${f.status}` : "";
    const detail = f.detail ? `  ${f.detail}` : "";
    lines.push(`${i + 1}. ${f.signal}  ${f.url}${status}${detail}  (after step ${f.step})`);
  });
  if (steps.length) {
    lines.push("STEPS:", ...steps);
  }
  return lines.join("\n");
}
