/**
 * Holds one browser for a session, for engines that lose their pages when a CDP connection ends (Lightpanda, Obscura).
 * Started by session.startChrome as `node ipc/daemon.ts SOCKET ENGINE BINARY PORT`: it runs the engine's `serve`,
 * attaches one Browser to it, and answers the CLI's requests on SOCKET (see remote.ts). The socket is owner-only.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { Browser } from "../browser/index.ts";
import { sleep } from "../core/format.ts";
import { engineFor } from "../engines/index.ts";
import type { Engine } from "../engines/types.ts";
import { failure, lines, type Method, type Reply, type Request } from "./remote.ts";

const STARTUP_MS = 15_000;
type Serve = NonNullable<Engine["serve"]>;

/** Attaches once the engine accepts connections. */
async function attach(serve: Serve, port: number, child: ChildProcess): Promise<Browser> {
  const deadline = performance.now() + STARTUP_MS;
  for (;;) {
    try {
      // about:blank gives the run its own tab; Lightpanda's placeholder tab is not one.
      return await Browser.open("about:blank", {
        port,
        rememberTab: false,
        trackWindows: true, // Neither engine opens a second window for target=_blank or window.open: the log should say so
        compat: serve.compat,
      });
    } catch (error) {
      if (child.exitCode !== null || performance.now() > deadline) throw error;
      await sleep(50);
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: RPC parameters are untyped JSON forwarded to Browser methods.
type RpcHandler = (browser: Browser, params: any[], stop: () => void) => Promise<unknown> | unknown;

const HANDLERS: Record<Method, RpcHandler> = {
  version: (b) => b.version,
  observe: (b) => b.observe(),
  fresh: (b, [page, action]) => b.fresh(page, action),
  act: async (b, [action, page, text]) => {
    await b.act(action, page, text);
    return null;
  },
  contexts: (b, [nodes]) => b.contexts(nodes),
  goto: async (b, [url]) => {
    await b.goto(url);
    return null;
  },
  rows: (b) => b.rows(),
  listEnd: (b) => b.listEnd(),
  check: (b) => b.check(),
  unseen: (b) => b.unseen(),
  ignoredWindows: (b) => b.ignoredWindows(),
  screenshot: async (b) => (await b.screenshot()).toString("base64"),
  evaluate: (b, [expression, options]) => b.evaluate(expression, options),
  storageState: (b) => b.storageState(),
  restore: (b, [state, url]) => b.restore(state, url),
  shutdown: (_b, _params, stop) => {
    setImmediate(stop);
    return null;
  },
};

async function run(socketPath: string, engine: string, executable: string, port: number): Promise<void> {
  const serve = engineFor(engine).serve as Serve;
  const child = spawn(executable, serve.arguments(port), { stdio: "ignore" });
  child.on("exit", () => process.exit(1));
  const browser = await attach(serve, port, child);
  const server = createServer();

  const stop = async () => {
    server.close();
    await browser.close();
    child.kill("SIGTERM");
    rmSync(socketPath, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  async function handle(request: Request): Promise<Reply> {
    try {
      const handler = Object.hasOwn(HANDLERS, request.method) ? HANDLERS[request.method as Method] : null;
      if (!handler) throw new Error(`Unknown method ${request.method}`);
      browser.view = request.view;
      return { id: request.id, result: await handler(browser, request.params, () => void stop()) };
    } catch (error) {
      return { id: request.id, error: failure(error) };
    }
  }

  // One request at a time: a command is one thing happening to the page.
  let queue: Promise<unknown> = Promise.resolve();
  server.on("connection", (socket: Socket) => {
    socket.on("error", () => {});
    socket.on(
      "data",
      lines((line) => {
        const request = JSON.parse(line) as Request;
        queue = queue.then(async () => {
          const reply = await handle(request);
          if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
        });
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

const [socketPath, engine, executable, port] = process.argv.slice(2);
run(socketPath, engine, executable, Number.parseInt(port, 10)).catch(() => process.exit(1));
