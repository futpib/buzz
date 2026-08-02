# Thread Mention Bot

A tiny deterministic Buzz bot for one narrow job: when the owner writes an
untagged reply in a thread containing only that owner and one of their agents,
the bot tags the agent for them.

It does not call an LLM, run ACP, choose a default agent, route top-level
messages, or react to emoji. It connects directly to the Buzz relay using the
same Nostr and NIP-OA primitives as other Buzz participants.

## Exact routing rule

For each new kind `9` message authored by the configured owner, the bot:

1. Requires NIP-10 thread tags. Top-level messages are ignored.
2. Queries the complete thread from the relay.
3. Ignores its own prior routing messages when counting participants.
4. Requires every other author to have exactly one valid NIP-OA `auth` tag
   proving the configured owner.
5. Requires exactly one such agent author in the thread.
6. Does nothing if another human, a second agent, or an unverified process has
   authored a thread message.
7. Does nothing if the owner's new message already `p`-tags that agent.
8. Does nothing if it already routed that exact message.
9. Otherwise posts a sibling kind `9` reply in the existing thread with the
   agent's real `p` tag and friendly `@name`.

The original user event remains unchanged because Nostr events are signed and
immutable. Once the target agent reacts to the routed mention, the bot removes
that mention with a channel-scoped NIP-09 deletion. The deletion keeps the
bot-specific source-event tag as a durable handled receipt, so removing the
visible mention cannot make the owner message eligible again after a reconnect.

## Configuration

The bot has its own key. It can run either as a standalone identity configured
with `BUZZ_OWNER_PUBKEY`, or with an unrestricted `BUZZ_AUTH_TAG` signed by the
owner for that bot key. An owner-attested bot works with the default
`buzz-acp --respond-to=owner-only` gate. A standalone bot must be explicitly
included in each target agent's `--respond-to=allowlist`; the private-host
installer configures that exact-key allowlist automatically.

```bash
export BUZZ_RELAY_URL=wss://buzz.example.com
export BUZZ_BOT_PRIVATE_KEY=<bot-nsec-or-hex-secret>
export BUZZ_OWNER_PUBKEY=<owner-npub-or-hex-public-key>
# Optional: restrict routing to specific channels.
export BUZZ_CHANNEL_IDS=<channel-uuid>[,<channel-uuid>...]
# Optional: publish a profile avatar.
export BUZZ_BOT_PICTURE_URL=https://buzz.example.com/media/avatar.png

cargo run -p thread-mention-bot
```

Omit `BUZZ_CHANNEL_IDS` to discover and watch every channel the bot can access.
The channel list is refreshed every five minutes.
`BUZZ_CHANNEL_ID` is accepted as a single-channel compatibility alias.

To upgrade from standalone mode, generate the bot-specific attestation once
and save its output as `BUZZ_AUTH_TAG`. When present, the verified attestation
defines the owner and `BUZZ_OWNER_PUBKEY` is ignored:

```bash
printf '%s\n' '<owner-nsec-or-hex-secret>' | \
  BUZZ_BOT_PRIVATE_KEY=<bot-nsec-or-hex-secret> \
  cargo run -q -p thread-mention-bot -- auth-tag
```

Do not leave `BUZZ_OWNER_PRIVATE_KEY` in the service environment. The running
bot needs only its own private key and the public attestation.

On explicitly configured open channels the bot best-effort self-adds with
`role=bot`. On private channels an owner or channel admin must add the bot
pubkey before it can read or write. The bot prints its pubkey at startup, or it
can be obtained without connecting to a relay:

```bash
BUZZ_BOT_PRIVATE_KEY=<bot-nsec-or-hex-secret> \
  cargo run -q -p thread-mention-bot -- public-key
```

## Private-host installation

The repository's private-host installer builds and installs the binary and its
tracked user service. On first use it generates a dedicated bot identity,
uploads the tracked bot avatar with that identity, and adds only that public
key to each installed ACP agent's response allowlist:

```bash
./deploy/private-host/install-thread-mention-bot.sh --restart
```

This standalone path needs no owner secret. Open channels require no
per-channel setup. Private channels must admit the bot through an existing
member. If desired, `--sign --channel UUID --restart` prompts without echo for
the owner key, writes only the resulting attestation, and adds the bot to that
private channel. The owner key is passed to the signer over stdin and is not
written to disk or placed in a process argument or environment variable.
Subsequent code updates need only `--restart`; the stable identity remains in
the mode-0600 files under `~/.config/buzz-thread-mention-bot/`.

## Generic systemd

```ini
[Unit]
Description=Buzz two-party thread mention bot
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/buzz/thread-mention-bot.env
ExecStart=/opt/buzz/thread-mention-bot
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

The bot reconnects automatically. Each candidate is checked against relay
history, and either an existing route or its durable deletion receipt prevents
duplicate routing after reconnects or restarts.
