"use client";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  verifyEvent,
} from "nostr-tools";

import type { NostrEvent } from "@/server/types";
import {
  bytesToHex,
  constantTimeEqual,
  deriveSas,
  deriveSessionId,
  deriveTranscriptHash,
  ecdhSharedSecret,
  hexToBytes,
} from "@/client/pairing-crypto";

const PAIRING_KIND = 24_134;
const SESSION_TIMEOUT_MS = 120_000;
const AUTH_CHALLENGE_GRACE_MS = 3_000;
const AUTH_TIMEOUT_MS = 8_000;
const EOSE_TIMEOUT_MS = 10_000;
const MAX_CONTENT_LENGTH = 87_472;

export type PairingStep =
  | "connecting"
  | "waiting"
  | "confirming"
  | "receiving"
  | "complete"
  | "error";

export type PairingSnapshot = {
  step: PairingStep;
  qrUri: string;
  appUri: string;
  sasCode: string | null;
  error: string | null;
};

type PairingCallbacks = {
  onChange(snapshot: PairingSnapshot): void;
  onNsec(nsec: string): Promise<boolean>;
};

function validNsec(value: string): boolean {
  try {
    const decoded = nip19.decode(value);
    return decoded.type === "nsec" && decoded.data.length === 32;
  } catch {
    return false;
  }
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isNostrEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<NostrEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.created_at === "number" &&
    typeof event.kind === "number" &&
    Array.isArray(event.tags) &&
    typeof event.content === "string" &&
    typeof event.sig === "string"
  );
}

function makePairingUris(
  sourcePubkey: string,
  sessionSecret: Uint8Array,
  relayUrl: string,
): { qrUri: string; appUri: string } {
  const query = new URLSearchParams({
    secret: bytesToHex(sessionSecret),
    relay: relayUrl,
    v: "1",
    mode: "recover",
  });
  const qrUri = `nostrpair://${sourcePubkey}?${query}`;
  const appUri = `buzz://pair?${new URLSearchParams({ code: qrUri })}`;
  return { qrUri, appUri };
}

export class BrowserPairingSession {
  private readonly relayUrl: string;
  private readonly callbacks: PairingCallbacks;
  private readonly ephemeralSecret = generateSecretKey();
  private readonly sourcePubkey = getPublicKey(this.ephemeralSecret);
  private readonly sessionSecret = crypto.getRandomValues(new Uint8Array(32));
  private readonly sessionId = deriveSessionId(this.sessionSecret);
  private readonly processedIds = new Set<string>();
  private readonly qrUri: string;
  private readonly appUri: string;
  private socket: WebSocket | null = null;
  private peerPubkey: string | null = null;
  private conversationKey: Uint8Array | null = null;
  private sasInput: Uint8Array | null = null;
  private snapshot: PairingSnapshot;
  private authEventId: string | null = null;
  private subscribed = false;
  private payloadReceived = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private authGraceTimer: number | null = null;
  private authTimeoutTimer: number | null = null;
  private eoseTimer: number | null = null;
  private sessionTimer: number | null = null;
  private closed = false;

  constructor(relayUrl: string, callbacks: PairingCallbacks) {
    const parsed = new URL(relayUrl);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
      throw new Error("Pairing relay must use WebSocket transport");
    }
    this.relayUrl = parsed.toString();
    this.callbacks = callbacks;
    const uris = makePairingUris(
      this.sourcePubkey,
      this.sessionSecret,
      this.relayUrl,
    );
    this.qrUri = uris.qrUri;
    this.appUri = uris.appUri;
    this.snapshot = {
      step: "connecting",
      qrUri: this.qrUri,
      appUri: this.appUri,
      sasCode: null,
      error: null,
    };
  }

  async start(): Promise<void> {
    if (this.socket) return;
    this.emit({ step: "connecting", error: null });
    await new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const socket = new WebSocket(this.relayUrl);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.authGraceTimer = window.setTimeout(
          () => this.subscribe(),
          AUTH_CHALLENGE_GRACE_MS,
        );
      });
      socket.addEventListener("message", (event) => this.onMessage(event.data));
      socket.addEventListener("error", () => {
        this.fail("Could not reach the pairing relay.");
      });
      socket.addEventListener("close", () => {
        if (!this.closed && this.snapshot.step !== "complete") {
          this.fail("The pairing connection closed. Try again.");
        }
      });
    });
  }

  confirmSas(): void {
    if (
      this.snapshot.step !== "confirming" ||
      !this.peerPubkey ||
      !this.sasInput
    ) {
      return;
    }
    const transcriptHash = deriveTranscriptHash(
      this.sessionId,
      this.sourcePubkey,
      this.peerPubkey,
      this.sasInput,
      this.sessionSecret,
    );
    this.publishEncrypted({
      type: "sas-confirm",
      transcript_hash: bytesToHex(transcriptHash),
    });
    this.emit({ step: "receiving" });
  }

  denySas(): void {
    this.abort("sas_mismatch");
    this.fail("The codes did not match. Pairing was canceled.");
  }

  dispose(sendAbort = true): void {
    if (this.closed) return;
    if (
      sendAbort &&
      this.peerPubkey &&
      this.snapshot.step !== "complete" &&
      this.snapshot.step !== "error"
    ) {
      this.abort("user_denied");
    }
    this.closed = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.ephemeralSecret.fill(0);
    this.sessionSecret.fill(0);
    this.sessionId.fill(0);
    this.conversationKey?.fill(0);
    this.sasInput?.fill(0);
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== "string" || this.closed) return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== "string") return;

    switch (message[0]) {
      case "AUTH":
        this.handleAuth(message);
        break;
      case "OK":
        this.handleOk(message);
        break;
      case "EOSE":
        if (message[1] === "pair") this.markReady();
        break;
      case "EVENT":
        if (message[1] === "pair") this.handleEvent(message[2]);
        break;
      case "CLOSED":
        if (message[1] === "pair") {
          this.fail(
            typeof message[2] === "string"
              ? `Pairing relay refused the session: ${message[2]}`
              : "Pairing relay refused the session.",
          );
        }
        break;
      case "NOTICE":
        if (typeof message[1] === "string") {
          this.fail(`Pairing relay error: ${message[1]}`);
        }
        break;
    }
  }

  private handleAuth(message: unknown[]): void {
    const challenge = message[1];
    if (typeof challenge !== "string" || !challenge) return;
    if (this.authGraceTimer !== null) {
      window.clearTimeout(this.authGraceTimer);
      this.authGraceTimer = null;
    }
    const event = finalizeEvent(
      {
        kind: 22_242,
        created_at: Math.floor(Date.now() / 1_000),
        tags: [
          ["relay", this.relayUrl],
          ["challenge", challenge],
        ],
        content: "",
      },
      this.ephemeralSecret,
    );
    this.authEventId = event.id;
    this.send(["AUTH", event]);
    if (this.authTimeoutTimer !== null) {
      window.clearTimeout(this.authTimeoutTimer);
    }
    this.authTimeoutTimer = window.setTimeout(
      () => this.fail("The pairing relay did not confirm authentication."),
      AUTH_TIMEOUT_MS,
    );
  }

  private handleOk(message: unknown[]): void {
    const eventId = message[1];
    const accepted = message[2];
    if (typeof eventId !== "string" || typeof accepted !== "boolean") return;
    if (eventId === this.authEventId) {
      if (this.authTimeoutTimer !== null) {
        window.clearTimeout(this.authTimeoutTimer);
        this.authTimeoutTimer = null;
      }
      this.authEventId = null;
      if (accepted) this.subscribe();
      else this.fail("The pairing relay rejected authentication.");
      return;
    }
    if (!accepted && this.processedIds.has(eventId)) {
      this.fail(
        typeof message[3] === "string"
          ? `Pairing relay rejected a message: ${message[3]}`
          : "Pairing relay rejected a message.",
      );
    }
  }

  private subscribe(): void {
    if (this.closed || this.subscribed) return;
    this.subscribed = true;
    this.send([
      "REQ",
      "pair",
      { kinds: [PAIRING_KIND], "#p": [this.sourcePubkey] },
    ]);
    this.eoseTimer = window.setTimeout(
      () => this.fail("The pairing relay did not open the session."),
      EOSE_TIMEOUT_MS,
    );
  }

  private markReady(): void {
    if (this.snapshot.step !== "connecting") return;
    if (this.eoseTimer !== null) {
      window.clearTimeout(this.eoseTimer);
      this.eoseTimer = null;
    }
    this.emit({ step: "waiting" });
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
    this.sessionTimer = window.setTimeout(
      () => this.fail("This pairing code expired. Create a new one."),
      SESSION_TIMEOUT_MS,
    );
  }

  private handleEvent(value: unknown): void {
    if (!isNostrEvent(value)) return;
    const event = value;
    if (
      event.kind !== PAIRING_KIND ||
      !verifyEvent(event) ||
      this.processedIds.has(event.id) ||
      event.content.length < 132 ||
      event.content.length > MAX_CONTENT_LENGTH ||
      !event.tags.some(
        (tag) => tag[0] === "p" && tag[1] === this.sourcePubkey,
      ) ||
      (this.peerPubkey !== null && event.pubkey !== this.peerPubkey)
    ) {
      return;
    }

    try {
      const conversationKey = nip44.getConversationKey(
        this.ephemeralSecret,
        event.pubkey,
      );
      const plaintext = nip44.decrypt(event.content, conversationKey);
      if (new TextEncoder().encode(plaintext).length > 65_535) return;
      const message = parseObject(plaintext);
      if (!message) return;

      if (this.snapshot.step === "waiting" && message.type === "offer") {
        this.handleOffer(event, message, conversationKey);
        return;
      }
      if (this.snapshot.step === "receiving" && message.type === "payload") {
        this.handlePayload(event, message);
        return;
      }
      if (message.type === "abort" && this.peerPubkey === event.pubkey) {
        this.processedIds.add(event.id);
        this.fail("Buzz Android canceled pairing.");
      }
    } catch {
      // NIP-AB requires invalid and out-of-order events to be discarded.
    }
  }

  private handleOffer(
    event: NostrEvent,
    message: Record<string, unknown>,
    conversationKey: Uint8Array,
  ): void {
    if (
      message.version !== 1 ||
      typeof message.session_id !== "string" ||
      !/^[0-9a-f]{64}$/.test(message.session_id) ||
      !constantTimeEqual(hexToBytes(message.session_id), this.sessionId)
    ) {
      return;
    }
    const shared = ecdhSharedSecret(this.ephemeralSecret, event.pubkey);
    const sas = deriveSas(shared, this.sessionSecret);
    shared.fill(0);
    this.peerPubkey = event.pubkey;
    this.conversationKey = conversationKey;
    this.sasInput = sas.input;
    this.processedIds.add(event.id);
    this.emit({ step: "confirming", sasCode: sas.code });
  }

  private handlePayload(
    event: NostrEvent,
    message: Record<string, unknown>,
  ): void {
    if (
      this.payloadReceived ||
      message.payload_type !== "nsec" ||
      typeof message.payload !== "string" ||
      !validNsec(message.payload)
    ) {
      return;
    }
    this.payloadReceived = true;
    this.processedIds.add(event.id);
    void this.finishImport(message.payload);
  }

  private async finishImport(nsec: string): Promise<void> {
    const success = await this.callbacks.onNsec(nsec).catch(() => false);
    if (this.snapshot.step === "error" || this.closed) return;
    try {
      this.publishEncrypted({ type: "complete", success });
    } catch {
      this.fail("Identity was received, but completion could not be sent.");
      return;
    }
    if (!success) {
      this.fail("The transferred identity could not log in to this relay.");
      return;
    }
    this.emit({ step: "complete" });
    window.setTimeout(() => this.dispose(false), 400);
  }

  private publishEncrypted(message: Record<string, unknown>): void {
    if (!this.peerPubkey || !this.conversationKey) {
      throw new Error("Pairing peer is not established");
    }
    const content = nip44.encrypt(
      JSON.stringify(message),
      this.conversationKey,
    );
    const event = finalizeEvent(
      {
        kind: PAIRING_KIND,
        created_at: Math.floor(Date.now() / 1_000),
        tags: [["p", this.peerPubkey]],
        content,
      },
      this.ephemeralSecret,
    );
    this.processedIds.add(event.id);
    this.send(["EVENT", event]);
  }

  private abort(reason: string): void {
    try {
      this.publishEncrypted({ type: "abort", reason });
    } catch {
      // Abort is best-effort.
    }
  }

  private send(message: unknown[]): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Pairing connection is not open");
    }
    this.socket.send(JSON.stringify(message));
  }

  private emit(change: Partial<PairingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.callbacks.onChange(this.snapshot);
  }

  private fail(message: string): void {
    if (this.snapshot.step === "complete" || this.closed) return;
    this.emit({ step: "error", error: message });
    this.readyReject?.(new Error(message));
    this.readyResolve = null;
    this.readyReject = null;
    this.clearTimers();
    this.dispose(false);
  }

  private clearTimers(): void {
    for (const timer of [
      this.authGraceTimer,
      this.authTimeoutTimer,
      this.eoseTimer,
      this.sessionTimer,
    ]) {
      if (timer !== null) window.clearTimeout(timer);
    }
    this.authGraceTimer = null;
    this.authTimeoutTimer = null;
    this.eoseTimer = null;
    this.sessionTimer = null;
  }
}
