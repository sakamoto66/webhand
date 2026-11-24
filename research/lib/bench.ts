/** Shared benchmark helpers (PSS memory measurement, fixture HTTP server, CLI option reader) for research scripts. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/** Sums PSS (proportional set size, in MiB) across every process in a process group. */
export function pssMb(group: number): { mb: number; procs: number } {
  let pids: string[] = [];
  try {
    pids = execFileSync("pgrep", ["-g", String(group)])
      .toString()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    // none left
  }
  let kb = 0;
  for (const pid of pids) {
    try {
      kb += Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1] ?? 0);
    } catch {
      // exited between listing and reading
    }
  }
  return { mb: kb / 1024, procs: pids.length };
}

/** Serves tasks/fixtures over loopback HTTP for multi-engine benchmarks. */
export async function startFixtureServer(root = process.cwd()): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://x").pathname;
    try {
      const body = readFileSync(join(root, "tasks", "fixtures", pathname));
      response.writeHead(200, { "content-type": "text/html" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

export function cliOption(args: string[], name: string, fallback: string): string {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
}
