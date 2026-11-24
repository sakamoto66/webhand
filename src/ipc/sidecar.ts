/**
 * Lifecycle helpers for detached Node sidecar processes that listen on an owner-only Unix socket
 * (used by both served browser engines and the HAR recorder).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionError } from "../core/errors.ts";
import { sleep } from "../core/format.ts";
import { childExited, children, exited, listening } from "../engines/process.ts";

export interface SidecarHandle {
  pid: number;
  socket: string;
  dir: string;
}

/** Resolves a sibling/relative sidecar entrypoint as .ts in dev/tests or .js once built. */
export function resolveSidecarScript(fromMetaUrl: string, relativeStem: string): string {
  const ext = fromMetaUrl.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`${relativeStem}${ext}`, fromMetaUrl));
}

/** Spawns a detached Node sidecar process and waits until it listens on its Unix socket. */
export async function startSidecar(options: {
  script: string;
  args: (socket: string) => string[];
  tmpPrefix: string;
  socketName: string;
  startupMs: number;
  failureMessage: string;
}): Promise<SidecarHandle> {
  const dir = mkdtempSync(join(tmpdir(), options.tmpPrefix));
  const socket = join(dir, options.socketName);
  const child = spawn(process.execPath, [options.script, ...options.args(socket)], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  const pid = child.pid as number;
  children.set(pid, child);
  const handle: SidecarHandle = { pid, socket, dir };
  const deadline = performance.now() + options.startupMs;
  while (performance.now() < deadline) {
    if (childExited(pid)) break;
    if (await listening(socket)) return handle;
    await sleep(50);
  }
  await killSidecar(handle);
  throw new SessionError(options.failureMessage);
}

/** Ends a detached sidecar's process group (SIGTERM -> SIGKILL) and removes its temporary socket folder. */
export async function killSidecar(handle: { pid: number; dir: string }): Promise<void> {
  try {
    process.kill(-handle.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  if (!(await exited(handle.pid, 2000))) {
    try {
      process.kill(-handle.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await exited(handle.pid, 2000);
  }
  try {
    rmSync(handle.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Best-effort cleanup of temp socket folder.
  }
}
