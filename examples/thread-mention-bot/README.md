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
9. Otherwise posts a nested kind `9` reply with the agent's real `p` tag.

The original user event remains unchanged because Nostr events are signed and
immutable. The routing reply uses the original message as its immediate NIP-10
parent, so the agent receives the real conversation as thread context.

## Configuration

The bot has its own key. `BUZZ_AUTH_TAG` must be an unrestricted NIP-OA
attestation signed by the owner for that bot key. The bot publishes the
attestation on its kind `0` profile and routed messages, allowing a default
`buzz-acp --respond-to=owner-only` agent to verify it as a same-owner sibling.

```bash
export BUZZ_RELAY_URL=wss://buzz.example.com
export BUZZ_BOT_PRIVATE_KEY=<bot-nsec-or-hex-secret>
export BUZZ_AUTH_TAG='["auth","<owner-pubkey>","","<signature>"]'
# Optional: restrict routing to specific channels.
export BUZZ_CHANNEL_IDS=<channel-uuid>[,<channel-uuid>...]

cargo run -p thread-mention-bot
```

Omit `BUZZ_CHANNEL_IDS` to watch every channel the bot can access.
`BUZZ_CHANNEL_ID` is accepted as a single-channel compatibility alias.

To generate the bot-specific attestation once, provide the owner key only to
the short-lived helper invocation and save its output as `BUZZ_AUTH_TAG`:

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
tracked user service. On first use it generates a dedicated bot identity, then
prompts without echo for the owner key to create the one-time attestation:

```bash
./deploy/private-host/install-thread-mention-bot.sh --sign --restart
```

The owner key is passed to the signer over stdin and is not written to disk or
placed in a process argument or environment variable. Add `--channel UUID` to
the same command for each private channel that should admit the bot. Open
channels need no per-channel setup. Subsequent code updates need only
`--restart`; the identity and attestation remain in the mode-0600 files under
`~/.config/buzz-thread-mention-bot/`.

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
history, and an existing bot reply to the same source event prevents duplicate
routing after reconnects or restarts.
