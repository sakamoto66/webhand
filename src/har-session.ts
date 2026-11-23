/**
 * Lifecycle and Unix-socket control for the detached HAR recorder sidecar (src/har-daemon.ts).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { childExited, children, exited, listening } from "./engines/process.ts";
import { SessionError } from "./errors.ts";
import { sleep } from "./format.ts";
import { lines } from "./remote.ts";

/** Session state stored when --har is active. */
export interface HarState {
  path: string;
  pid: number;
  socket: string;
  dir: string;
}

export interface HarStopResult {
  entries: number;
  error?: string;
}

const DEFAULT_STARTUP_MS = Number(process.env.WEBHAND_STARTUP_MS) || 15_000;
const STOP_TIMEOUT_MS = 10_000;

/** har-daemon.ts in dev/tests, or har-daemon.js once built. */
function harDaemonScript(): string {
  const ts = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(ts ? "./har-daemon.ts" : "./har-daemon.js", import.meta.url));
}

/** Spawns the detached CDP HAR recorder sidecar and waits until it is attached and listening. */
export async function startHarRecorder(
  port: number,
  harPath: string,
  startupMs: number = DEFAULT_STARTUP_MS,
): Promise<HarState> {
  const dir = mkdtempSync(join(tmpdir(), "webhand-har-"));
  const socket = join(dir, "har.sock");
  const child = spawn(process.execPath, [harDaemonScript(), socket, String(port), harPath], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  const pid = child.pid as number;
  children.set(pid, child);
  const state: HarState = { path: harPath, pid, socket, dir };
  const deadline = performance.now() + startupMs;
  while (performance.now() < deadline) {
    if (childExited(pid)) break;
    if (await listening(socket)) return state;
    await sleep(50);
  }
  await killHarSidecar(state);
  throw new SessionError("HAR recorder did not attach to Chrome");
}

async function sendStop(socketPath: string): Promise<HarStopResult> {
  return await new Promise<HarStopResult>((resolve, reject) => {
    const client = connect(socketPath);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("HAR recorder timed out while flushing")));
    }, STOP_TIMEOUT_MS);
    client.once("connect", () => {
      client.write(`${JSON.stringify({ cmd: "stop" })}\n`);
    });
    client.on(
      "data",
      lines((line) => {
        try {
          const reply = JSON.parse(line) as { ok?: boolean; entries?: number; error?: string };
          if (reply.ok) finish(() => resolve({ entries: reply.entries ?? 0 }));
          else finish(() => reject(new Error(reply.error ?? "HAR recorder failed to save")));
        } catch (error) {
          finish(() => reject(error as Error));
        }
      }),
    );
    client.once("error", (error) => finish(() => reject(error)));
    client.once("close", () => finish(() => reject(new Error("HAR recorder closed before replying"))));
  });
}

async function killHarSidecar(har: HarState): Promise<void> {
  try {
    process.kill(-har.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  if (!(await exited(har.pid, 2000))) {
    try {
      process.kill(-har.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await exited(har.pid, 2000);
  }
  try {
    rmSync(har.dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of temp socket folder.
  }
}

/** Tells the HAR sidecar to flush pending bodies, write the HAR file, and exit. Must run before Chrome stops. */
export async function stopHarRecorder(har: HarState): Promise<HarStopResult> {
  try {
    const result = await sendStop(har.socket);
    await exited(har.pid, 3000);
    return result;
  } catch (error) {
    return { entries: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await killHarSidecar(har);
  }
}
