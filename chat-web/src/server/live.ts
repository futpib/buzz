import "server-only";

import { setTimeout as delay } from "node:timers/promises";

import { getServerConfig } from "@/server/env";
import { makeNip42AuthEvent } from "@/server/nostr";

type RelayFrame = unknown[];

function parseFrame(data: unknown): RelayFrame | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Relay WebSocket failed to open"));
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Live subscription aborted"));
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForFrame(
  socket: WebSocket,
  matches: (frame: RelayFrame) => boolean,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<RelayFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Relay response timed out")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error: Error | null, frame?: RelayFrame) => {
      cleanup();
      if (error) reject(error);
      else resolve(frame as RelayFrame);
    };
    const onMessage = (message: MessageEvent) => {
      const frame = parseFrame(message.data);
      if (frame && matches(frame)) finish(null, frame);
    };
    const onClose = () => finish(new Error("Relay WebSocket closed"));
    const onError = () => finish(new Error("Relay WebSocket failed"));
    const onAbort = () =>
      finish(signal.reason ?? new Error("Live subscription aborted"));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runSubscription(
  channelId: string,
  onDirty: () => void,
  signal: AbortSignal,
): Promise<void> {
  const socket = new WebSocket(getServerConfig().relayWsUrl);
  const challengePromise = waitForFrame(
    socket,
    (frame) => frame[0] === "AUTH" && typeof frame[1] === "string",
    signal,
  );
  const [, challenge] = await Promise.all([
    waitForOpen(socket, signal),
    challengePromise,
  ]);
  const authEvent = makeNip42AuthEvent(challenge[1] as string);
  const okPromise = waitForFrame(
    socket,
    (frame) => frame[0] === "OK" && frame[1] === authEvent.id,
    signal,
  );
  socket.send(JSON.stringify(["AUTH", authEvent]));
  const ok = await okPromise;
  if (ok[2] !== true) {
    socket.close();
    throw new Error(
      `Relay authentication failed: ${String(ok[3] ?? "rejected")}`,
    );
  }

  const subscriptionId = `chat-web-${crypto.randomUUID()}`;
  socket.send(
    JSON.stringify([
      "REQ",
      subscriptionId,
      {
        kinds: [5, 7, 9, 9005, 39005, 40002, 40003, 40008, 45001, 45003],
        "#h": [channelId],
        since: Math.floor(Date.now() / 1000) - 5,
      },
    ]),
  );

  await new Promise<void>((resolve, reject) => {
    let sawEose = false;
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      cleanup();
      try {
        socket.close();
      } catch {
        // The socket may already be closed.
      }
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: MessageEvent) => {
      const frame = parseFrame(message.data);
      if (!frame) return;
      if (frame[0] === "EOSE" && frame[1] === subscriptionId) {
        sawEose = true;
        onDirty();
      } else if (
        frame[0] === "EVENT" &&
        frame[1] === subscriptionId &&
        sawEose
      ) {
        onDirty();
      } else if (frame[0] === "CLOSED" && frame[1] === subscriptionId) {
        finish(
          new Error(`Relay closed subscription: ${String(frame[2] ?? "")}`),
        );
      }
    };
    const onClose = () => finish(new Error("Relay WebSocket closed"));
    const onError = () => finish(new Error("Relay WebSocket failed"));
    const onAbort = () => finish();
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function listenForChannelChanges(
  channelId: string,
  onDirty: () => void,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await runSubscription(channelId, onDirty, signal);
      attempt = 0;
    } catch (error) {
      if (signal.aborted) return;
      attempt += 1;
      console.error("Buzz live subscription failed", error);
      await delay(
        Math.min(10_000, 250 * 2 ** Math.min(attempt, 5)),
        undefined,
        {
          signal,
        },
      ).catch(() => undefined);
    }
  }
}
