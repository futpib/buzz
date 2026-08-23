NIP-AT
======

Agent Thread Turn Lifecycle
---------------------------

`kind:24201` is an ephemeral, channel-scoped snapshot that lets a coordinator
project whether an agent or a human owns the next action in a Buzz thread.
The lifecycle event itself is not UI: a coordinator can turn it into a durable
reaction, badge, or other local policy without giving the harness a second
durable status writer.

## Event

The agent signs a `kind:24201` event with these tags:

- exactly one `h` tag containing the channel UUID;
- exactly one `e` tag containing the thread root event ID with marker `root`;
- exactly one valid NIP-OA `auth` tag proving the agent's owner.

Content is JSON:

```json
{
  "version": 1,
  "turnId": "harness turn or queue source identifier",
  "state": "agent",
  "phase": "working",
  "revision": 1770000000000000,
  "expiresAt": 1770000045
}
```

`state` is one of:

- `agent`: work is queued or active;
- `human`: the agent turn completed successfully;
- `failed`: the turn failed or its liveness expired.

`phase` is diagnostic and does not change ownership semantics. Publishers use
values such as `queued`, `working`, `retrying`, `completed`, `failed`, and
`panicked`. Consumers must tolerate unknown phase values.

`revision` is publisher-monotonic. A consumer rejects a snapshot older than
the latest revision from the same agent for the same thread. A terminal
snapshot also dominates a later-delivered `agent` refresh carrying the same
`turnId`, closing the completion/liveness delivery race.

`expiresAt` is required for `agent` and forbidden for terminal states. An
expired agent snapshot becomes `failed` unless a newer refresh arrives.

## Coordinator behavior

A coordinator verifies the Nostr signature, channel scope, and NIP-OA owner
attestation before accepting a snapshot. For multiple agents in one thread it
projects `agent` while any non-expired agent snapshot is active. Once none are
active, it projects `failed` if any assigned agent failed and `human` only when
all assigned agents completed successfully.

The thread-mention coordinator uses one tagged reaction on the root:

- `⏳` for `agent`;
- `✅` for `human`;
- `⚠️` for `failed`, stale, or unassigned work.

When the displayed emoji changes, it publishes the replacement before deleting
its previous tagged reaction. A metadata-only refresh with the same emoji must
delete the prior reaction first because relays reject duplicate reactions from
the same author on the same event.

## Relay behavior

Kind 24201 uses the NIP-01 ephemeral range. Relays must not persist it. Normal
channel membership and write policy apply through the `h` tag; no special
relay authorization path is required.
