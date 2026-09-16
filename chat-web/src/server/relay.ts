import "server-only";

import { randomUUID } from "node:crypto";
import { verifyEvent } from "nostr-tools";

import { getServerConfig } from "@/server/env";
import type { NostrEvent } from "@/server/types";

export type RelayFilter = Record<string, unknown>;

type RelayFrame = unknown[];
type FrameListener = (frame: RelayFrame) => void;

const OPEN_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_QUERY_EVENTS = 5_000;

function parseFrame(data: unknown): RelayFrame | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asEvent(value: unknown): NostrEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as NostrEvent;
  if (
    typeof event.id !== "string" ||
    typeof event.pubkey !== "string" ||
    typeof event.created_at !== "number" ||
    typeof event.kind !== "number" ||
    !Array.isArray(event.tags) ||
    typeof event.content !== "string" ||
    typeof event.sig !== "string"
  ) {
    return null;
  }
  return event;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Relay WebSocket open timed out")),
      OPEN_TIMEOUT_MS,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("Relay WebSocket failed to open"));
    const onClose = () => finish(new Error("Relay WebSocket closed"));
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

export class RelayConnection {
  readonly challenge: string;
  readonly relayUrl: string;
  private readonly socket: WebSocket;
  private readonly listeners = new Set<FrameListener>();
  private closed = false;
  private authenticated = false;
  private onClosed: (() => void) | null = null;

  private constructor(socket: WebSocket, challenge: string, relayUrl: string) {
    this.socket = socket;
    this.challenge = challenge;
    this.relayUrl = relayUrl;
    socket.addEventListener("message", (message) => {
      const frame = parseFrame(message.data);
      if (!frame) return;
      for (const listener of this.listeners) listener(frame);
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      this.onClosed?.();
    });
  }

  static async open(): Promise<RelayConnection> {
    const relayUrl = getServerConfig().relayWsUrl;
    const socket = new WebSocket(relayUrl);
    let resolveChallenge: ((challenge: string) => void) | null = null;
    let rejectChallenge: ((error: Error) => void) | null = null;
    const challengePromise = new Promise<string>((resolve, reject) => {
      resolveChallenge = resolve;
      rejectChallenge = reject;
    });
    const timeout = setTimeout(
      () =>
        rejectChallenge?.(
          new Error("Relay authentication challenge timed out"),
        ),
      OPEN_TIMEOUT_MS,
    );
    const onMessage = (message: MessageEvent) => {
      const frame = parseFrame(message.data);
      if (frame?.[0] === "AUTH" && typeof frame[1] === "string") {
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        resolveChallenge?.(frame[1]);
      }
    };
    const onClose = () => {
      clearTimeout(timeout);
      rejectChallenge?.(
        new Error("Relay WebSocket closed before authentication"),
      );
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    try {
      const [, challenge] = await Promise.all([
        waitForOpen(socket),
        challengePromise,
      ]);
      socket.removeEventListener("close", onClose);
      return new RelayConnection(socket, challenge, relayUrl);
    } catch (error) {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.close();
      throw error;
    }
  }

  isOpen(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  setCloseHandler(handler: () => void): void {
    this.onClosed = handler;
  }

  async authenticate(event: NostrEvent): Promise<void> {
    if (this.closed || this.authenticated) {
      throw new Error("Relay login attempt is no longer available");
    }
    const framePromise = this.waitForFrame(
      (frame) => frame[0] === "OK" && frame[1] === event.id,
      REQUEST_TIMEOUT_MS,
    );
    this.socket.send(JSON.stringify(["AUTH", event]));
    const frame = await framePromise;
    if (frame[2] !== true) {
      throw new Error(String(frame[3] ?? "Relay rejected the login"));
    }
    this.authenticated = true;
  }

  async query(filters: RelayFilter[]): Promise<NostrEvent[]> {
    this.assertReady();
    if (filters.length === 0 || filters.length > 10) {
      throw new Error("Relay queries require between one and ten filters");
    }
    const subscriptionId = `web-query-${randomUUID()}`;
    const events = new Map<string, NostrEvent>();
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("Relay query timed out")),
        REQUEST_TIMEOUT_MS,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        this.listeners.delete(onFrame);
        if (this.isOpen()) {
          this.socket.send(JSON.stringify(["CLOSE", subscriptionId]));
        }
      };
      const finish = (error?: Error) => {
        cleanup();
        if (error) reject(error);
        else resolve([...events.values()]);
      };
      const onFrame = (frame: RelayFrame) => {
        if (frame[1] !== subscriptionId) return;
        if (frame[0] === "EVENT") {
          const event = asEvent(frame[2]);
          if (event && verifyEvent(event)) events.set(event.id, event);
          if (events.size > MAX_QUERY_EVENTS) {
            finish(new Error("Relay query exceeded the event limit"));
          }
        } else if (frame[0] === "EOSE") {
          finish();
        } else if (frame[0] === "CLOSED") {
          finish(new Error(String(frame[2] ?? "Relay closed the query")));
        }
      };
      this.listeners.add(onFrame);
      this.socket.send(JSON.stringify(["REQ", subscriptionId, ...filters]));
    });
  }

  async publish(event: NostrEvent): Promise<void> {
    this.assertReady();
    const response = this.waitForFrame(
      (frame) => frame[0] === "OK" && frame[1] === event.id,
      REQUEST_TIMEOUT_MS,
    );
    this.socket.send(JSON.stringify(["EVENT", event]));
    const frame = await response;
    if (frame[2] !== true) {
      throw new Error(String(frame[3] ?? "Buzz relay rejected the message"));
    }
  }

  subscribe(
    filter: RelayFilter,
    onDirty: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertReady();
    const subscriptionId = `web-live-${randomUUID()}`;
    return new Promise<void>((resolve, reject) => {
      let sawEose = false;
      const cleanup = () => {
        this.listeners.delete(onFrame);
        signal.removeEventListener("abort", onAbort);
        this.socket.removeEventListener("close", onClose);
        if (this.isOpen()) {
          this.socket.send(JSON.stringify(["CLOSE", subscriptionId]));
        }
      };
      const finish = (error?: Error) => {
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onFrame = (frame: RelayFrame) => {
        if (frame[1] !== subscriptionId) return;
        if (frame[0] === "EOSE") {
          sawEose = true;
          onDirty();
        } else if (frame[0] === "EVENT" && sawEose) {
          onDirty();
        } else if (frame[0] === "CLOSED") {
          finish(
            new Error(String(frame[2] ?? "Relay closed the subscription")),
          );
        }
      };
      const onAbort = () => finish();
      const onClose = () => finish(new Error("Relay WebSocket closed"));
      this.listeners.add(onFrame);
      signal.addEventListener("abort", onAbort, { once: true });
      this.socket.addEventListener("close", onClose, { once: true });
      this.socket.send(JSON.stringify(["REQ", subscriptionId, filter]));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }

  private assertReady(): void {
    if (!this.authenticated || !this.isOpen()) {
      throw new Error("Login session is no longer connected to the relay");
    }
  }

  private waitForFrame(
    matches: (frame: RelayFrame) => boolean,
    timeoutMs: number,
  ): Promise<RelayFrame> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("Relay response timed out")),
        timeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        this.listeners.delete(onFrame);
        this.socket.removeEventListener("close", onClose);
      };
      const finish = (error?: Error, frame?: RelayFrame) => {
        cleanup();
        if (error) reject(error);
        else resolve(frame as RelayFrame);
      };
      const onFrame = (frame: RelayFrame) => {
        if (matches(frame)) finish(undefined, frame);
      };
      const onClose = () => finish(new Error("Relay WebSocket closed"));
      this.listeners.add(onFrame);
      this.socket.addEventListener("close", onClose, { once: true });
    });
  }
}
