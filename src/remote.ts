/**
 * A browser that lives in another process. Lightpanda drops its pages when a CDP connection ends, so a daemon
 * (daemon.ts) holds the connection and the page for the whole session, and each CLI command talks to it over a
 * unix socket. RemoteBrowser has the shape of Browser for what the CLI uses; the daemon runs the real Browser,
 * freshness check and all, so nothing is acted on without it.
 *
 * Wire format: one JSON object per line. Request {id, method, params, view}; reply {id, result} or
 * {id, error: {name, message, changed}}.
 */

import { connect, type Socket } from "node:net";
import type { StorageState } from "./auth.ts";
import type { PageCheck, ViewChoice } from "./browser.ts";
import type { RowReader } from "./collect.ts";
import type { Reader } from "./compare.ts";
import { type Action, MutationUncertain, type Page, StalePage } from "./types.ts";

/** What the CLI needs of a browser, local or remote. */
export interface Driver extends Reader, RowReader {
  view: ViewChoice | null;
  readonly version: string;
  screenshot(): Promise<Buffer>;
  check(): Promise<PageCheck>;
  unseen(): Promise<Record<string, number>>;
  ignoredWindows(): Promise<string[]>;
  storageState(): Promise<StorageState>;
  restore(state: StorageState, url: string): Promise<string[]>;
  close(): Promise<void>;
}

/** The only methods the daemon runs for a client. */
export const METHODS = [
  "version",
  "observe",
  "fresh",
  "act",
  "contexts",
  "goto",
  "rows",
  "listEnd",
  "check",
  "unseen",
  "ignoredWindows",
  "screenshot",
  "evaluate",
  "storageState",
  "restore",
  "shutdown",
] as const;

export type Method = (typeof METHODS)[number];

export interface Request {
  id: number;
  method: string;
  // biome-ignore lint/suspicious/noExplicitAny: parameters are the browser method's own JSON.
  params: any[];
  view: ViewChoice | null;
}

export interface Failure {
  name: string;
  message: string;
  changed?: string[];
}

export type Reply = { id: number; result: unknown } | { id: number; error: Failure };

export function failure(error: unknown): Failure {
  if (error instanceof StalePage) return { name: error.name, message: error.message, changed: error.changed };
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

/** The error the daemon saw, as the same class the CLI's callers already catch. */
function revive(error: Failure): Error {
  if (error.name === "StalePage") return new StalePage(error.message, error.changed ?? []);
  if (error.name === "MutationUncertain") return new MutationUncertain(error.message);
  return new Error(error.message);
}

/** Splits a stream into lines; the last partial line waits for more. */
export function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let rest = "";
  return (chunk) => {
    rest += chunk.toString("utf8");
    for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      if (line) onLine(line);
    }
  };
}

export class RemoteBrowser implements Driver {
  view: ViewChoice | null;
  version = "";
  private readonly socket: Socket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(socket: Socket, view: ViewChoice | null) {
    this.socket = socket;
    this.view = view;
    socket.on(
      "data",
      lines((line) => {
        const reply = JSON.parse(line) as Reply;
        const waiting = this.pending.get(reply.id);
        if (!waiting) return;
        this.pending.delete(reply.id);
        if ("error" in reply) waiting.reject(revive(reply.error));
        else waiting.resolve(reply.result);
      }),
    );
    const lost = () => {
      for (const waiting of this.pending.values())
        waiting.reject(new Error("The browser daemon closed the connection"));
      this.pending.clear();
    };
    socket.on("close", lost);
    socket.on("error", lost);
  }

  /** Connects to the session's daemon. Nothing on the page changes. */
  static async connect(path: string, view: ViewChoice | null = null): Promise<RemoteBrowser> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const opened = connect(path);
      opened.once("connect", () => resolve(opened));
      opened.once("error", reject);
    });
    const remote = new RemoteBrowser(socket, view);
    try {
      remote.version = (await remote.call("version")) as string;
    } catch (error) {
      await remote.close();
      throw error;
    }
    return remote;
  }

  // biome-ignore lint/suspicious/noExplicitAny: results are the browser method's own JSON.
  private call(method: Method, ...params: unknown[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const request: Request = { id, method, params, view: this.view };
      this.socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  observe(): Promise<Page> {
    return this.call("observe");
  }

  fresh(page: Page, action: Action | Page | null = null): Promise<boolean> {
    return this.call("fresh", page, action);
  }

  async act(action: Action, page: Page, text: string | null = null): Promise<void> {
    await this.call("act", action, page, text);
  }

  contexts(nodes: number[]): Promise<Record<string, string>> {
    return this.call("contexts", nodes);
  }

  async goto(url: string): Promise<void> {
    await this.call("goto", url);
  }

  rows(): Promise<string[]> {
    return this.call("rows");
  }

  listEnd(): Promise<number | null> {
    return this.call("listEnd");
  }

  check(): Promise<PageCheck> {
    return this.call("check");
  }

  unseen(): Promise<Record<string, number>> {
    return this.call("unseen");
  }

  ignoredWindows(): Promise<string[]> {
    return this.call("ignoredWindows");
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from((await this.call("screenshot")) as string, "base64");
  }

  /** Read-only evaluation, for a research task's independent verification. */
  evaluate(expression: string, options: { awaitPromise?: boolean } = {}): Promise<unknown> {
    return this.call("evaluate", expression, options);
  }

  storageState(): Promise<StorageState> {
    return this.call("storageState");
  }

  restore(state: StorageState, url: string): Promise<string[]> {
    return this.call("restore", state, url);
  }

  /** Ends this connection only. The daemon, its browser and the page stay until the session is stopped. */
  async close(): Promise<void> {
    this.socket.destroy();
  }
}
