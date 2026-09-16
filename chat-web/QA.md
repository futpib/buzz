# Live web-client QA contract

Run `pnpm check` and `pnpm build`, then exercise the production build through
the browser. A pass is not complete until it covers the checks below.

## Independent baseline

- Resolve the login pubkey before opening the web client.
- Build the authorized-channel set from relay rosters, independently of the
  web client, and require the rendered channel IDs to match it exactly.
- Page every authorized channel through the relay's authoritative top-level
  channel-window projection and require the workspace Threads IDs to match the
  complete root set exactly. Do not use a recent-event sample, a fixed raw-event
  cap, or traversal of the rows the client happened to render as evidence of
  completeness.
- Retrieve profile metadata independently. When a baseline profile has a
  picture, require a decoded, painted avatar image rather than initials alone.

## Enabled controls

- Inventory every visible enabled button and link on each tested screen.
  Exercise every distinct action with trusted browser input and verify its
  destination or state change. Placeholder controls must be visibly disabled;
  an enabled inert control anywhere in the product surface is a failure.
- Require immediate pending feedback after a trusted navigation click and a
  responsive, system-themed skeleton while server view data is loading.
- Measure a cold route transition and a revisit to the same route. Require the
  cold transition to paint the navigation skeleton, the revisit to reuse the
  client route cache without another blocking relay projection, and a stale
  server entry to render immediately while one coalesced refresh runs. Inspect
  the production `data-cache-state` seam and network requests; the mere
  presence of cache code or a spinner is not evidence.
- Exercise every navigation surface: sidebar channels, Threads, timeline
  thread summaries, nested branches, search results, and thread close. Large
  result sets may warm on pointer/focus/touch intent; the bounded sidebar set
  must be eagerly prefetched.
- Exercise channel navigation, opening and closing a real thread, search,
  mobile drawer navigation, sending, a direct reply, a reply to that reply,
  and deletion propagation. Inspect the signed nested reply for distinct
  NIP-10 `root` and `reply` markers.
- Match Android's nested-thread model: the outer branch renders only direct
  children, a reply with children gets a visible tappable summary, and opening
  that summary renders the child branch. Do not accept flattened descendants
  or an author-only "Replying to" label as equivalent coverage.
- Require a real thread to open at its latest reply after media has painted,
  at both desktop and phone sizes.

## Session and security

- Clear only the server session cookie, open a fresh tab, and verify that the
  browser-persisted identity re-establishes the session without entering the
  nsec again.
- Separately keep the server cookie, clear only sessionStorage, reload a
  protected page, and send a browser-signed temporary message. This proves the
  signing path itself hydrates IndexedDB instead of depending on the login
  screen having run first.
- Verify the nsec is absent from HTML, cookies, localStorage, and HTTP/WebSocket
  traffic. Persistent identity data may exist only in browser IndexedDB and
  active-tab sessionStorage.
- Verify logged-out pages redirect to login and all protected APIs return 401.

## Rendering

- Check desktop and phone viewports in light and dark system schemes.
- Require zero horizontal overflow, page exceptions, console errors, failed
  requests, and HTTP errors.
- Capture painted framebuffer evidence for real avatars and protected message
  attachments; DOM presence or image dimensions alone are insufficient.
- Open a real protected attachment with trusted input, exercise zoom and pan,
  close it with Escape, and repeat at phone size without page overflow.

Temporary messages created by QA must be deleted, and their disappearance must
be observed in both the live timeline and search before the pass is reported.
