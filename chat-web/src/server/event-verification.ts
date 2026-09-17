import { getEventHash, verifyEvent } from "nostr-tools";

import type { NostrEvent } from "@/server/types";

/**
 * Bounded process-wide memoization for immutable signed events. Cached events
 * still have their content hash recomputed on every receipt; only the much
 * more expensive Schnorr verification is reused.
 */
export class EventVerificationCache {
  private readonly verified = new Map<string, string>();

  constructor(private readonly maxEntries: number) {
    if (maxEntries < 1) throw new Error("Verification cache must be bounded");
  }

  accepts(event: NostrEvent): boolean {
    try {
      if (getEventHash(event) !== event.id) return false;
    } catch {
      return false;
    }
    const signatureIdentity = `${event.pubkey}:${event.sig}`;
    const cached = this.verified.get(event.id);
    if (cached !== undefined) {
      if (cached !== signatureIdentity) return false;
      this.verified.delete(event.id);
      this.verified.set(event.id, cached);
      return true;
    }
    if (!verifyEvent(event)) return false;
    this.verified.set(event.id, signatureIdentity);
    while (this.verified.size > this.maxEntries) {
      const oldest = this.verified.keys().next().value;
      if (oldest === undefined) break;
      this.verified.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.verified.size;
  }
}
