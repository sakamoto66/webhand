/**
 * Lifecycle and Unix-socket control for the detached HAR recorder sidecar (src/har/daemon.ts).
 */

import { connect } from "node:net";
import { exited } from "../engines/process.ts";
import { lines } from "../ipc/remote.ts";
import { killSidecar, resolveSidecarScript, startSidecar } from "../ipc/sidecar.ts";

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

/** Spawns the detached CDP HAR recorder sidecar and waits until it is attached and listening. */
export async function startHarRecorder(
  port: number,
  harPath: string,
  startupMs: number = DEFAULT_STARTUP_MS,
): Promise<HarState> {
  const sidecar = await startSidecar({
    script: resolveSidecarScript(import.meta.url, "./daemon"),
    args: (socket) => [socket, String(port), harPath],
    tmpPrefix: "webhand-har-",
    socketName: "har.sock",
    startupMs,
    failureMessage: "HAR recorder did not attach to Chrome",
  });
  return { path: harPath, ...sidecar };
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

/** Tells the HAR sidecar to flush pending bodies, write the HAR file, and exit. Must run before Chrome stops. */
export async function stopHarRecorder(har: HarState): Promise<HarStopResult> {
  try {
    const result = await sendStop(har.socket);
    await exited(har.pid, 3000);
    return result;
  } catch (error) {
    return { entries: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await killSidecar(har);
  }
}
