# Buzz client state

`buzz-client-state` is a disposable, client-local read model for fast native
clients. The Buzz relay stays authoritative; this crate turns already accepted
relay events into SQLite rows shaped for immediate UI queries.

The write path is deliberately outside relay ingest:

```text
relay snapshot/live subscriptions
              |
              v
       bounded async queue ---> SQLite WAL projection
                                      |
              channel list / activity / search / messages / threads / reactions
```

SQLite and signature verification run on blocking workers rather than the Tokio
executor or Android UI thread. `enqueue` is non-waiting and reports bounded-queue
backpressure without losing ownership of the event. `apply` and `flush` provide
asynchronous durability barriers for initial snapshots and tests.

Every row is fenced by normalized relay URL plus viewer public key. This is
load-bearing: unread state and private channel metadata must never cross an
account or community switch.

## Sync contract

1. Open the local database for the current relay/viewer scope and paint its
   channel/message projections immediately.
2. Register live subscriptions before fetching snapshots.
3. Feed both snapshot and live events through `apply`/`enqueue`; event IDs make
   overlap idempotent.
4. Decode the viewer's encrypted kind-30078 NIP-RS events in the identity layer,
   merge their contexts by maximum timestamp, and pass `ReadMarker`s here.
5. Reconcile/backfill event IDs periodically. Never use the greatest
   `created_at` as the only sync cursor because late historical events are valid.

Queries can run while projection writes continue. A caller that needs
read-your-writes calls `flush` before querying.

The initial relevant-event set intentionally covers the latency-sensitive
Android surfaces: kind 39000/39002 channel state, messages and threads, kind 7
reactions, kind 5/9005 deletions, kind 40003 edits, activity-addressed events,
and local FTS5 search. Unknown kinds are counted as ignored and can be replayed
from the relay after a later projection version adds them.
