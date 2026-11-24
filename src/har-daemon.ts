/**
 * Detached CDP sidecar that records HTTP traffic across a webhand session into a HAR 1.2 file.
 *
 * Started by startHarRecorder() as `node har-daemon.ts SOCKET PORT HAR_PATH`. Connects directly
 * to Chrome's browser-level CDP WebSocket with Target.setAutoAttach(flatten: true), enables
 * Network.* on every page and iframe target, and flushes pending bodies to HAR_PATH when `finish`
 * sends {"cmd":"stop"} on SOCKET.
 */

import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { sleep } from "./format.ts";
import {
  type CdpLoadingFailed,
  type CdpLoadingFinished,
  type CdpRequestExtraInfo,
  type CdpRequestWillBeSent,
  type CdpResponseExtraInfo,
  type CdpResponseReceived,
  HarCollector,
  writeHarAtomic,
} from "./har.ts";
import { lines } from "./remote.ts";

const VERSION_TIMEOUT_MS = 5000;
const FLUSH_TIMEOUT_MS = 3000;
const BODY_TIMEOUT_MS = 2000;
const MAX_POST_DATA_SIZE = 2 * 1024 * 1024;

export interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  // biome-ignore lint/suspicious/noExplicitAny: raw CDP wire payloads.
  params?: any;
  // biome-ignore lint/suspicious/noExplicitAny: raw CDP wire payloads.
  result?: any;
  error?: { code?: number; message?: string };
}

// biome-ignore lint/suspicious/noExplicitAny: raw CDP results.
export type CdpSender = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>;

interface VersionInfo {
  webSocketDebuggerUrl: string;
  Browser?: string;
}

export function parseBrowser(raw?: string): { name: string; version: string } | undefined {
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  if (slash < 0) return { name: raw, version: "" };
  return { name: raw.slice(0, slash), version: raw.slice(slash + 1) };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise.catch(() => null), sleep(ms).then(() => null)]);
}

/**
 * Routes CDP Target.* and Network.* events into HarCollector, tracking in-flight body/postData
 * fetches so shutdown can flush them before writing the HAR.
 */
export function createHarEventHandler(
  collector: HarCollector,
  send: CdpSender,
  options: { bodyTimeoutMs?: number } = {},
): {
  onEvent: (message: CdpMessage) => void;
  attachExistingTargets: () => Promise<void>;
  waitForInflight: (timeoutMs: number) => Promise<void>;
} {
  const attachedTargets = new Set<string>();
  const inflight = new Set<Promise<unknown>>();
  const bodyTimeoutMs = options.bodyTimeoutMs ?? BODY_TIMEOUT_MS;

  const track = (promise: Promise<unknown>): void => {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
  };

  const enableTarget = async (sessionId: string, type: string | undefined): Promise<void> => {
    if (type !== "page" && type !== "iframe") return;
    try {
      await send("Network.enable", { maxPostDataSize: MAX_POST_DATA_SIZE }, sessionId);
    } catch {
      // Target may have closed before Network.enable finished.
    }
  };

  const onEvent = (message: CdpMessage): void => {
    const { method, params } = message;
    const sessionId = message.sessionId ?? "";
    if (!method || !params) return;

    if (method === "Target.attachedToTarget") {
      const targetId = params.targetInfo?.targetId as string | undefined;
      const type = params.targetInfo?.type as string | undefined;
      const childSessionId = params.sessionId as string | undefined;
      const waiting = Boolean(params.waitingForDebugger);
      const alreadyAttached = Boolean(targetId && attachedTargets.has(targetId));
      if (targetId && !alreadyAttached) attachedTargets.add(targetId);
      if (childSessionId) {
        track(
          (async () => {
            try {
              if (!alreadyAttached) await withTimeout(enableTarget(childSessionId, type), bodyTimeoutMs);
            } finally {
              if (waiting) {
                await send("Runtime.runIfWaitingForDebugger", {}, childSessionId).catch(() => {});
              }
            }
          })(),
        );
      }
      return;
    }

    if (method === "Network.requestWillBeSent") {
      const { entry, needsPostData } = collector.onRequestWillBeSent(sessionId, params as CdpRequestWillBeSent);
      if (entry && needsPostData) {
        track(
          withTimeout(
            send("Network.getRequestPostData", { requestId: params.requestId }, sessionId).then((res) => {
              if (typeof res?.postData === "string") collector.setPostData(entry, res.postData);
            }),
            bodyTimeoutMs,
          ),
        );
      }
      return;
    }

    if (method === "Network.requestWillBeSentExtraInfo") {
      collector.onRequestWillBeSentExtraInfo(sessionId, params as CdpRequestExtraInfo);
      return;
    }

    if (method === "Network.responseReceived") {
      collector.onResponseReceived(sessionId, params as CdpResponseReceived);
      return;
    }

    if (method === "Network.responseReceivedExtraInfo") {
      collector.onResponseReceivedExtraInfo(sessionId, params as CdpResponseExtraInfo);
      return;
    }

    if (method === "Network.loadingFinished") {
      const { entry, shouldFetchBody } = collector.onLoadingFinished(sessionId, params as CdpLoadingFinished);
      if (entry && shouldFetchBody) {
        track(
          withTimeout(
            send("Network.getResponseBody", { requestId: params.requestId }, sessionId).then((res) => {
              if (typeof res?.body === "string") collector.setResponseBody(entry, res.body, Boolean(res.base64Encoded));
            }),
            bodyTimeoutMs,
          ),
        );
      }
      return;
    }

    if (method === "Network.loadingFailed") {
      collector.onLoadingFailed(sessionId, params as CdpLoadingFailed);
    }
  };

  const attachExistingTargets = async (): Promise<void> => {
    // Pause newly created targets until Network.enable finishes, then release via
    // Runtime.runIfWaitingForDebugger, so fast navigations (such as target=_blank popups on
    // localhost) cannot complete before Network.* listeners are attached.
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const targets = (await send("Target.getTargets")) as {
      targetInfos?: { targetId: string; type: string }[];
    };
    for (const info of targets?.targetInfos ?? []) {
      if ((info.type === "page" || info.type === "iframe") && !attachedTargets.has(info.targetId)) {
        attachedTargets.add(info.targetId);
        const attached = (await send("Target.attachToTarget", { targetId: info.targetId, flatten: true }).catch(
          () => null,
        )) as { sessionId?: string } | null;
        if (attached?.sessionId) {
          await enableTarget(attached.sessionId, info.type);
        }
      }
    }
  };

  const waitForInflight = async (timeoutMs: number): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (inflight.size > 0) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      await Promise.race([Promise.allSettled([...inflight]), sleep(remaining)]);
    }
  };

  return { onEvent, attachExistingTargets, waitForInflight };
}

async function fetchVersion(port: number): Promise<VersionInfo> {
  const deadline = performance.now() + VERSION_TIMEOUT_MS;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const info = (await response.json()) as VersionInfo;
        if (info.webSocketDebuggerUrl) return info;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw lastError ?? new Error(`Chrome debugging port ${port} did not return webSocketDebuggerUrl`);
}

async function connectCdp(
  wsUrl: string,
  onEvent: (message: CdpMessage) => void,
  onClose: () => void,
): Promise<{ send: CdpSender; close: () => void }> {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  let open = false;
  // biome-ignore lint/suspicious/noExplicitAny: raw CDP results.
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  const send: CdpSender = (method, params = {}, sessionId) => {
    if (!open) return Promise.reject(new Error("CDP WebSocket is closed"));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const message: Record<string, unknown> = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        pending.delete(id);
        reject(error as Error);
      }
    });
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      open = true;
      resolve();
    };
    ws.onerror = () => reject(new Error("Failed to connect to Chrome CDP WebSocket"));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (typeof message.id === "number") {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "CDP error"));
        else waiter.resolve(message.result);
        return;
      }
      onEvent(message);
    };
  });

  ws.onclose = () => {
    open = false;
    for (const waiter of pending.values()) waiter.reject(new Error("CDP WebSocket closed"));
    pending.clear();
    onClose();
  };

  return {
    send,
    close: () => {
      open = false;
      try {
        ws.close();
      } catch {
        // Ignore close errors during shutdown.
      }
    },
  };
}

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
