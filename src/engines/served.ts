/**
 * An engine (Lightpanda, Obscura) has no window and no profile, and drops its pages when a CDP connection ends. A
 * daemon runs it and holds the connection for the session; commands reach the page through state.socket (see
 * daemon.ts, remote.ts). Asks for a saved profile or a window fail here rather than being quietly dropped.
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionError } from "../errors.ts";
import { sleep } from "../format.ts";
import type { State } from "../session.ts";
import { stopLocal } from "./chrome.ts";
import { childExited, children, freePort, isFile, listening, which } from "./process.ts";
import { type Engine, rejectWindowAndProfile, type StartOptions } from "./types.ts";

/** daemon.ts, or daemon.js once built. */
function daemonScript(): string {
  const ts = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(ts ? "../daemon.ts" : "../daemon.js", import.meta.url));
}

/** Where the binary is: the given environment variable when it names a file, else PATH. */
function binary(command: string, variable?: string): string | null {
  const given = variable ? process.env[variable] : undefined;
  return given && isFile(given) ? given : which(command);
}

export function servedEngine(spec: {
  id: string;
  label: string;
  /** An environment variable that names the binary (Obscura's release archive is not installed anywhere). */
  binaryVariable?: string;
  serve: NonNullable<Engine["serve"]>;
}): Engine {
  return {
    id: spec.id,
    label: spec.label,
    serve: spec.serve,
    async start(options: StartOptions): Promise<State> {
      rejectWindowAndProfile(spec.label, options);
      const executable = binary(spec.id, spec.binaryVariable);
      if (!executable) throw new SessionError(`${spec.id} was not found on PATH`);
      const port = await freePort();
      const folder = mkdtempSync(join(tmpdir(), "webhand-")); // Holds the socket; removed when the session stops.
      const socket = join(folder, "rpc.sock");
      const child = spawn(process.execPath, [daemonScript(), socket, spec.id, executable, String(port)], {
        detached: true, // its own process group, so it outlives this CLI call and stops as a group with the engine
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
      const pid = child.pid as number;
      children.set(pid, child);
      const state: State = {
        pid,
        profile: folder,
        saved_profile: null,
        chrome: "linux",
        engine: spec.id,
        headed: false,
        socket,
      };
      const deadline = performance.now() + options.startupMs;
      while (performance.now() < deadline) {
        if (childExited(pid)) break;
        if (await listening(socket)) return state;
        await sleep(50);
      }
      await stopLocal(state);
      throw new SessionError(`${spec.label} did not start`);
    },
    stop: stopLocal,
  };
}
