/**
 * Holds one browser for a session, for engines that lose their pages when a CDP connection ends (Lightpanda, Obscura).
 * Started by session.startChrome as `node daemon.ts SOCKET ENGINE BINARY PORT`: it runs the engine's `serve`, attaches
 * one Browser to it, and answers the CLI's requests on SOCKET (see remote.ts). The socket is owner-only.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { Browser } from "./browser.ts";
import { sleep } from "./format.ts";
import { failure, lines, METHODS, type Reply, type Request } from "./remote.ts";

const STARTUP_MS = 15_000;

/** Attaches once the engine accepts connections. */
async function attach(engine: string, port: number, child: ChildProcess): Promise<Browser> {
  const deadline = performance.now() + STARTUP_MS;
  for (;;) {
    try {
      // about:blank gives the run its own tab; Lightpanda's placeholder tab is not one.
      return await Browser.open("about:blank", {
        port,
        rememberTab: false,
        trackWindows: true, // Neither engine opens a second window for target=_blank or window.open: the log should say so
        compat: engine === "obscura",
      });
    } catch (error) {
      if (child.exitCode !== null || performance.now() > deadline) throw error;
      await sleep(50);
    }
  }
}

/** The engine's own command line. Obscura refuses loopback and private addresses unless told otherwise (its SSRF guard). */
function serveArguments(engine: string, port: number): string[] {
  if (engine === "obscura") {
    const open = process.env.WEBHAND_OBSCURA_ALLOW_PRIVATE === "1" ? ["--allow-private-network"] : [];
    return ["serve", "--port", String(port), ...open];
  }
  return ["serve", "--host", "127.0.0.1", "--port", String(port)];
}

async function run(socketPath: string, engine: string, executable: string, port: number): Promise<void> {
  const child = spawn(executable, serveArguments(engine, port), { stdio: "ignore" });
  child.on("exit", () => process.exit(1));
  const browser = await attach(engine, port, child);
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
      if (!(METHODS as readonly string[]).includes(request.method)) throw new Error(`Unknown method ${request.method}`);
      browser.view = request.view;
      const [a, b, c] = request.params;
      switch (request.method) {
        case "version":
          return { id: request.id, result: browser.version };
        case "observe":
          return { id: request.id, result: await browser.observe() };
        case "fresh":
          return { id: request.id, result: await browser.fresh(a, b) };
        case "act":
          await browser.act(a, b, c);
          return { id: request.id, result: null };
        case "contexts":
          return { id: request.id, result: await browser.contexts(a) };
        case "goto":
          await browser.goto(a);
          return { id: request.id, result: null };
        case "rows":
          return { id: request.id, result: await browser.rows() };
        case "listEnd":
          return { id: request.id, result: await browser.listEnd() };
        case "check":
          return { id: request.id, result: await browser.check() };
        case "unseen":
          return { id: request.id, result: await browser.unseen() };
        case "ignoredWindows":
          return { id: request.id, result: await browser.ignoredWindows() };
        case "screenshot":
          return { id: request.id, result: (await browser.screenshot()).toString("base64") };
        case "evaluate":
          return { id: request.id, result: await browser.evaluate(a, b) };
        default:
          setImmediate(stop);
          return { id: request.id, result: null };
      }
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
