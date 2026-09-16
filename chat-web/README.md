# Buzz Chat Web

The server-rendered Buzz messaging client. It is deliberately a
backend-for-frontend: the Next.js server consumes an authenticated relay stream,
projects channel/thread windows, and sends view-shaped snapshots to the browser.
The browser never receives raw relay events.

Login and message signing happen in the browser. The nsec is kept in tab-scoped
session storage and is never submitted to Next.js or the relay. The server sees
only public, signed NIP-42 proofs and signed message events. It holds the
authenticated relay WebSocket behind an opaque, HttpOnly session cookie so
React Server Components can render authorized views without holding a private
key.

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
