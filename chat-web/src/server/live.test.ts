import assert from "node:assert/strict";
import test from "node:test";
import type { AuthSession } from "@/server/auth";
import { listenForChannelChanges } from "@/server/live";
import type { NostrEvent } from "@/server/types";

test("catch-up always requests an authoritative snapshot, including empty replay and reconnect", async () => {
  let dirty = 0;
  const abort = new AbortController();
  const session = {
    relay: {
      subscribe: async (
        _filter: unknown,
        handlers: {
          onEose: () => void;
          onEvent: (event: NostrEvent, live: boolean) => void;
        },
      ) => {
        handlers.onEose();
        assert.equal(
          dirty,
          1,
          "a quiet channel must reconcile an old SSR snapshot",
        );
        handlers.onEvent({ kind: 9 } as NostrEvent, false);
        assert.equal(dirty, 1, "history coalesces at EOSE");
        handlers.onEose();
        assert.equal(dirty, 2, "reconnect catches up again");
        handlers.onEvent({ kind: 40004 } as NostrEvent, true);
        assert.equal(dirty, 3, "live pins also refresh the snapshot");
      },
    },
  } as unknown as AuthSession;
  await listenForChannelChanges(
    session,
    "channel",
    () => dirty++,
    () => {},
    abort.signal,
  );
});
