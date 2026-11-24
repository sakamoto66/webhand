/** What every engine that runs a local process needs: finding binaries, watching children, waiting on ports and sockets. */

import { type ChildProcess, execFileSync } from "node:child_process";
import { type AddressInfo, connect, createServer } from "node:net";
import { delimiter, join } from "node:path";
import { sleep } from "../core/format.ts";
import { isFile } from "../core/fs.ts";

export { isFile };

export function run(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): string {
  return execFileSync(command, args, { ...options, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

export function which(command: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const file = join(dir, command);
    if (dir && isFile(file)) return file;
  }
  return null;
}

/** Browser processes this process started. Only these can be watched for exit directly. */
export const children = new Map<number, ChildProcess>();

export function childExited(pid: number): boolean | null {
  const child = children.get(pid);
  if (!child) return null;
  return child.exitCode !== null || child.signalCode !== null;
}

export function alive(pid: number): boolean {
  const own = childExited(pid);
  if (own !== null) return !own;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function exited(pid: number, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return false;
}

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Whether something accepts connections on this unix socket. */
export async function listening(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/** Whether a Chrome answers on this debugging port. */
export async function reachable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
