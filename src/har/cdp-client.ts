/** Browser-level CDP WebSocket client used by the HAR recorder sidecar. */

import { sleep } from "../core/format.ts";

const VERSION_TIMEOUT_MS = 5000;

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

export async function fetchVersion(port: number): Promise<VersionInfo> {
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

export async function connectCdp(
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
