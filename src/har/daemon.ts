/**
 * Detached CDP sidecar that records HTTP traffic across a webhand session into a HAR 1.2 file.
 * Started by startHarRecorder() as `node har/daemon.ts SOCKET PORT HAR_PATH`.
 */

import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { lines } from "../ipc/remote.ts";
import { type CdpSender, connectCdp, fetchVersion, parseBrowser } from "./cdp-client.ts";
import { HarCollector, writeHarAtomic } from "./collector.ts";
import { createHarEventHandler } from "./events.ts";

const FLUSH_TIMEOUT_MS = 3000;

async function run(socketPath: string, port: number, harPath: string): Promise<void> {
  const version = await fetchVersion(port);
  const collector = new HarCollector({ browser: parseBrowser(version.Browser) });
  const server = createServer();
  let stopping = false;
  let handler: ReturnType<typeof createHarEventHandler> | null = null;
  let cdp: { send: CdpSender; close: () => void } | null = null;

  const flushAndExit = async (replySocket?: Socket): Promise<void> => {
    if (stopping) return;
    stopping = true;
    let writeError: string | null = null;
    try {
      await handler?.waitForInflight(FLUSH_TIMEOUT_MS);
      writeHarAtomic(harPath, collector.toHar());
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error);
    }
    if (replySocket && !replySocket.destroyed) {
      const payload = writeError ? { ok: false, error: writeError } : { ok: true, entries: collector.count };
      await new Promise<void>((resolve) => replySocket.end(`${JSON.stringify(payload)}\n`, resolve));
    }
    server.close();
    cdp?.close();
    rmSync(socketPath, { force: true });
    process.exit(writeError ? 1 : 0);
  };

  cdp = await connectCdp(
    version.webSocketDebuggerUrl,
    (message) => handler?.onEvent(message),
    () => void flushAndExit(),
  );
  handler = createHarEventHandler(collector, cdp.send);

  process.on("SIGTERM", () => void flushAndExit());
  process.on("SIGINT", () => void flushAndExit());

  await handler.attachExistingTargets();
  await handler.waitForInflight(1000);

  server.on("connection", (socket: Socket) => {
    socket.on("error", () => {});
    socket.on(
      "data",
      lines((line) => {
        try {
          const message = JSON.parse(line) as { cmd?: string };
          if (message.cmd === "stop") void flushAndExit(socket);
        } catch {
          // Ignore malformed control frames.
        }
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [socketPath, portArg, harPath] = process.argv.slice(2);
  run(socketPath, Number.parseInt(portArg, 10), harPath).catch(() => process.exit(1));
}
