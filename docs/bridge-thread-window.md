# Bridge `/query` Extension: Thread Window

The thread window is the latency-oriented sibling of the channel window. It
uses the existing authenticated `POST /query` bridge and returns signed Nostr
events; there is no new endpoint and no change to relay ingest.

The legacy `depth_limit` reader walks from the oldest reply forward. That is a
useful replay API, but a 5,000-reply thread takes 25 sequential 200-row requests
before a client can paint the active tail. `thread_window` serves a bounded
newest-first page immediately and lets the client request older pages on demand.

## Request

```json
{
  "kinds": [9, 40002, 40008],
  "#e": ["<64-hex root event id>"],
  "#h": ["<channel uuid>"],
  "limit": 100,
  "thread_window": true,
  "thread_parent": "<64-hex displayed thread-head event id>",
  "depth_limit": 64,
  "include_aux": true,
  "until": 1751500000,
  "before_id": "<64-hex event id>"
}
```

- Exactly one `#e` root and one accessible `#h` channel are required.
- `thread_parent` selects the displayed thread head. It defaults to the root
  for compatibility; each page contains that event's direct replies, so a
  deeply nested thread never has to replay unrelated branches.
- `limit` counts reply rows only and is clamped to 500.
- `until` and `before_id` are the composite cursor issued by the previous
  bounds overlay. Both or neither must be present.
- `include_aux` appends the authorized two-hop edits, reactions, deletions,
  and delete-of-reaction closure for the root and retained reply rows.

The response starts with the selected thread-head event when it is still
visible, followed by its direct reply rows ordered `(created_at DESC, id ASC)`.
Replies that head a nested thread also receive a `kind:39005` count/last-active
summary overlay. The server probes `limit + 1`
after the channel, root, depth, and deletion predicates, removes the sentinel,
and emits exactly one `kind:39006` bounds overlay:

```json
{
  "has_more": true,
  "next_cursor": {"created_at": 1751499000, "id": "<64-hex id>"}
}
```

Its tags are:

```json
[
  ["d", "thread:<channel>:<root>:<thread-parent>:<request-cursor-or-head>"],
  ["e", "<root>"],
  ["h", "<channel>"]
]
```

Clients must partition out `kind:39006`, validate all three tags against the
request, and use its `has_more` value rather than infer exhaustion from row
count. Replies and aux events may then be folded into the client read model.

Relays without this extension ignore `thread_window`; clients detect the
missing bounds overlay and may fall back to the legacy `thread_cursor` reader.
