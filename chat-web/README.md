# Buzz Chat Web

The server-rendered Buzz messaging client. It is deliberately a
backend-for-frontend: the Next.js server consumes an authenticated relay stream,
projects channel/thread windows, and sends view-shaped snapshots to the browser.
The browser never receives raw relay events.

Login and message signing happen in the browser. The nsec is kept in memory and
sessionStorage for the active tab, with redundant browser-only IndexedDB and
localStorage persistence for recovery on mobile browsers; it is never submitted
to Next.js or the relay. The server sees only public, signed
NIP-42 proofs and signed message events. It holds the authenticated relay
WebSocket behind an opaque, HttpOnly session cookie so React Server Components
can render authorized views without holding a private key.

Navigation preferences use a durable, per-identity browser outbox. An expired
HTTP session is renewed with the saved browser signer before retrying a write;
the private key stays in the browser. Writes are serialized per preference
coordinate so an older acknowledgement cannot discard a newer edit. Offline
writes survive reloads, retry with capped backoff, and expose the failure reason
and a Retry sync button after repeated failures.

Authenticated channel, thread, Inbox, Threads-index, and search projections use a
bounded session-scoped stale-while-revalidate cache. Next.js keeps prefetched
route payloads in its client cache; sidebar destinations warm eagerly and
large thread/search result sets warm on navigation intent. Cold misses render a
system-themed navigation skeleton, while active channel views reconcile from
the relay live stream and the Threads index refreshes in the background.
Channel timelines scan the relay with a composite cursor until they contain a
real page of top-level roots; reaching the top loads the next page without
dropping the reader's scroll position.
Every cache seed awaits the message set and its reaction/edit/deletion closure
as one server projection, so opening a prewarmed thread cannot paint first and
fill reactions in during a later refresh.
Warm stale views remain on screen with a compact updating indicator while their
fresh projection is requested. Channel and thread composers also publish and
receive short-lived, signed typing indicators using the same branch scope as
Buzz Desktop, without treating ephemeral delivery failure as a logout.
Successful and explicitly submitted searches are kept as a bounded,
browser-only recent-search list scoped to the signed-in public key. The empty
search dialog can rerun, remove, or clear those entries.

## Run

```bash
export BUZZ_RELAY_URL=https://relay.example
export BUZZ_WEB_DEFAULT_CHANNEL=<channel-uuid>           # optional
pnpm --dir chat-web build
pnpm --dir chat-web start --hostname :: --port 4180
```

Every application route, live stream, and write endpoint requires a verified
login session. Only the login handshake and framework assets are available
without one. Human keys can sign in directly; agent keys can additionally
supply their NIP-OA auth tag from the advanced login section.

The initial page is rendered by React Server Components. Live changes arrive
through `/api/live` as complete `ChannelSnapshot` projections; the browser
replaces a snapshot and never reduces relay events.

The layout uses a drawer on phone-width screens, full-screen threads on mobile,
safe-area insets, and the operating system's light/dark color scheme.

Channel headers expose a pinned-message list, including messages outside the
current timeline window. Message actions publish browser-signed kind-40004 pins;
“Remove my pin” deletes the viewer's pin events (kind 5), leaving other members'
pins intact. Pins are shared channel state, not personal bookmarks. The server
loads targets and their edit/deletion closure and resolves nested-thread links.
Live catch-up always emits a fresh snapshot, even on a quiet channel; a linked
thread row centers when it first arrives, without recentering subsequent updates.
