# Buzz Chat Web

The server-rendered Buzz messaging client. It is deliberately a
backend-for-frontend: the Next.js server authenticates to the Buzz relay,
consumes relay-projected channel/thread windows, and sends view-shaped snapshots
to the browser. The browser never receives raw Nostr events or a signing key.

## Run

```bash
export BUZZ_RELAY_URL=https://relay.example
export BUZZ_PRIVATE_KEY=<hex-or-nsec>
export BUZZ_AUTH_TAG='["auth", "...", "...", "..."]' # optional
export BUZZ_WEB_DEFAULT_CHANNEL=<channel-uuid>           # optional
pnpm --dir chat-web build
pnpm --dir chat-web start --hostname :: --port 4180
```

This is a single-identity deployment: all viewers use the configured server
identity. Bind it only to a trusted network. A future multi-user deployment
must add per-user authentication and signing sessions instead of sharing this
server signer.

The initial page is rendered by React Server Components. Live changes arrive
through `/api/live` as complete `ChannelSnapshot` projections; the browser
replaces a snapshot and never reduces relay events.
