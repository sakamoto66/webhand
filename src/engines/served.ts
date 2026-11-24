/**
 * An engine (Lightpanda, Obscura) has no window and no profile, and drops its pages when a CDP connection ends. A
 * daemon runs it and holds the connection for the session; commands reach the page through state.socket (see
 * ipc/daemon.ts, ipc/remote.ts). Asks for a saved profile or a window fail here rather than being quietly dropped.
 */

import { SessionError } from "../core/errors.ts";
import { RemoteBrowser } from "../ipc/remote.ts";
import { resolveSidecarScript, startSidecar } from "../ipc/sidecar.ts";
import type { State } from "../storage/session.ts";
import { stopLocal } from "./chrome.ts";
import { freePort, isFile, which } from "./process.ts";
import { type Engine, rejectWindowAndProfile, type StartOptions } from "./types.ts";

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
    capabilities: { localFiles: false, har: false, explore: false },
    serve: spec.serve,
    async start(options: StartOptions): Promise<State> {
      rejectWindowAndProfile(spec.label, options);
      const executable = binary(spec.id, spec.binaryVariable);
      if (!executable) throw new SessionError(`${spec.id} was not found on PATH`);
      const port = await freePort();
      const sidecar = await startSidecar({
        script: resolveSidecarScript(import.meta.url, "../ipc/daemon"),
        args: (socket) => [socket, spec.id, executable, String(port)],
        tmpPrefix: "webhand-",
        socketName: "rpc.sock",
        startupMs: options.startupMs,
        failureMessage: `${spec.label} did not start`,
      });
      return {
        pid: sidecar.pid,
        profile: sidecar.dir,
        saved_profile: null,
        chrome: "linux",
        engine: spec.id,
        headed: false,
        socket: sidecar.socket,
      };
    },
    stop: stopLocal,
    async attach(state, url, view) {
      const remote = await RemoteBrowser.connect(state.socket, view ?? null);
      try {
        if (url) await remote.goto(url);
      } catch (error) {
        await remote.close();
        throw error;
      }
      return remote;
    },
  };
}
