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
- From a cold Threads load, open a root with existing reactions and require
  those reactions in the first painted thread snapshot. A later live refresh
  must not be needed to fill reaction state into a prewarmed cache entry.
- With stale channel, Threads, Inbox, and search projections, require the stale
  content to remain usable while a visible `Updating`/search spinner persists
  for exactly the fresh request and disappears after success or failure.
- Type trusted non-empty input in a channel and a nested thread. Require a
  signed kind-20002 event with the canonical channel/root/reply scope, throttle
  repeated sends, exclude the current identity, separate channel and branch
  indicators, clear an author when their message arrives, and expire silence.
- Open a rendered message link with trusted input and require a new tab with
  an isolated opener while the Buzz application remains on its current route.
- Select a real generic file in each composer layout, require visible
  preparation/upload progress, and send an attachment-only message. Verify the
  browser-signed event carries canonical `imeta` URL/MIME/hash/size/filename
  fields, a failed publish can retry without re-uploading the blob, and the
  rendered protected attachment opens exact bytes in an opener-isolated tab
  without replacing Buzz. Delete the temporary attachment message afterward.
- Select a JPEG carrying EXIF/comment metadata and require the browser to bake
  its visible orientation into metadata-free bytes before hashing and upload;
  the original private bytes must never reach `/api/upload`. Exercise PNG,
  GIF, and WebP structural metadata removal too, preserving animation and the
  single allowlisted Buzz snapshot payload while rejecting animated color or
  orientation metadata that cannot be removed without changing appearance.
- Exercise channel navigation, opening and closing a real thread, search,
  mobile drawer navigation, sending, a direct reply, a reply to that reply,
  and deletion propagation. Inspect the signed nested reply for distinct
  NIP-10 `root` and `reply` markers.
- Open a message's expanded reaction picker, search by shortcode, name, and
  keyword, and submit both a search result and a directly typed or pasted emoji
  with trusted input. Require the exact browser-signed reaction content and
  delete each temporary reaction afterward.
- With a media-bearing thread scrolled to the bottom and emoji search focused,
  deliver a live snapshot. Require the painted media node and thread scroll
  geometry to remain stable, and require the picker to retain its DOM node,
  value, and focus so a phone keyboard is not dismissed.
- Commit a search, reload the application, and require it to appear in the
  signed-in identity's recent-search list. Exercise one-click rerun, per-entry
  removal, and clear-all; verify another identity cannot read that history.
- On a channel with more than one timeline page, scroll to the top with trusted
  input, require older top-level messages to be prepended, and verify the
  reader's scroll anchor is preserved. Require a visible load-more fallback; a
  recent raw-event window is not historical coverage.
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
- Block or remove IndexedDB, clear sessionStorage, and verify browser-only
  localStorage restores a signer. This is the mobile/private-browser fallback.
- Verify the nsec is absent from HTML, cookies, and HTTP/WebSocket traffic.
  Persistent identity data may exist only in browser storage (IndexedDB and the
  localStorage fallback) plus active-tab memory/sessionStorage.
- Verify logged-out pages redirect to login and all protected APIs return 401.

## Rendering

- Check desktop and phone viewports in light and dark system schemes.
- With a thread open on desktop, resize its panel with both pointer drag and
  keyboard arrows. Require bounded channel/thread widths, persistence across a
  reload, and no resize handle on the full-screen phone thread.
- Require zero horizontal overflow, page exceptions, console errors, failed
  requests, and HTTP errors.
- Capture painted framebuffer evidence for real avatars and protected message
  attachments; DOM presence or image dimensions alone are insufficient.
- Open a real protected attachment with trusted input, exercise toolbar zoom
  and drag/pan, then use a trusted two-contact pinch at phone size. Require the
  image point beneath the moving gesture midpoint to remain stable even while
  the image is too close to 100% zoom for scroll to absorb the translation,
  zoom to stay within 100-400%, one-contact pan to remain usable afterward, and
  a return to 100% to reset scroll position. Close it with Escape without page
  overflow.

Temporary messages created by QA must be deleted, and their disappearance must
be observed in both the live timeline and search before the pass is reported.
