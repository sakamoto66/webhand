/**
 * Routes CDP Target.* and Network.* events into HarCollector via a handler table,
 * tracking in-flight body/postData fetches so shutdown can flush them before writing the HAR.
 */

import { sleep } from "../core/format.ts";
import type { CdpMessage, CdpSender } from "./cdp-client.ts";
import type { HarCollector } from "./collector.ts";
import type {
  CdpLoadingFailed,
  CdpLoadingFinished,
  CdpRequestExtraInfo,
  CdpRequestWillBeSent,
  CdpResponseExtraInfo,
  CdpResponseReceived,
} from "./types.ts";

const BODY_TIMEOUT_MS = 2000;
const MAX_POST_DATA_SIZE = 2 * 1024 * 1024;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise.catch(() => null), sleep(ms).then(() => null)]);
}

// biome-ignore lint/suspicious/noExplicitAny: raw CDP event params.
type EventHandler = (sessionId: string, params: any) => void;

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

  const handlers: Record<string, EventHandler> = {
    "Target.attachedToTarget": (_sessionId, params) => {
      const targetId = params.targetInfo?.targetId as string | undefined;
      const type = params.targetInfo?.type as string | undefined;
      const childSessionId = params.sessionId as string | undefined;
      const waiting = Boolean(params.waitingForDebugger);
      const alreadyAttached = Boolean(targetId && attachedTargets.has(targetId));
      if (targetId && !alreadyAttached) attachedTargets.add(targetId);
      if (!childSessionId) return;
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
    },
    "Network.requestWillBeSent": (sessionId, params) => {
      const { entry, needsPostData } = collector.onRequestWillBeSent(sessionId, params as CdpRequestWillBeSent);
      if (!entry || !needsPostData) return;
      track(
        withTimeout(
          send("Network.getRequestPostData", { requestId: params.requestId }, sessionId).then((res) => {
            if (typeof res?.postData === "string") collector.setPostData(entry, res.postData);
          }),
          bodyTimeoutMs,
        ),
      );
    },
    "Network.requestWillBeSentExtraInfo": (sessionId, params) => {
      collector.onRequestWillBeSentExtraInfo(sessionId, params as CdpRequestExtraInfo);
    },
    "Network.responseReceived": (sessionId, params) => {
      collector.onResponseReceived(sessionId, params as CdpResponseReceived);
    },
    "Network.responseReceivedExtraInfo": (sessionId, params) => {
      collector.onResponseReceivedExtraInfo(sessionId, params as CdpResponseExtraInfo);
    },
    "Network.loadingFinished": (sessionId, params) => {
      const { entry, shouldFetchBody } = collector.onLoadingFinished(sessionId, params as CdpLoadingFinished);
      if (!entry || !shouldFetchBody) return;
      track(
        withTimeout(
          send("Network.getResponseBody", { requestId: params.requestId }, sessionId).then((res) => {
            if (typeof res?.body === "string") collector.setResponseBody(entry, res.body, Boolean(res.base64Encoded));
          }),
          bodyTimeoutMs,
        ),
      );
    },
    "Network.loadingFailed": (sessionId, params) => {
      collector.onLoadingFailed(sessionId, params as CdpLoadingFailed);
    },
  };

  const onEvent = (message: CdpMessage): void => {
    if (!message.method || !message.params) return;
    const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : null;
    handler?.(message.sessionId ?? "", message.params);
  };

  const attachExistingTargets = async (): Promise<void> => {
    // Pause newly created targets until Network.enable finishes, then release via Runtime.runIfWaitingForDebugger.
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
