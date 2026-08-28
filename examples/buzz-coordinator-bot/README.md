# Buzz Coordinator Bot

A small Buzz automation bot. Its deterministic router tags the assigned agent
when the owner writes without an explicit mention. It also coordinates one
durable reaction on every active thread root: `⏳` while agent work is queued
or running, `✅` after successful completion, and `⚠️` for failed, stale, or
unassigned work.

An optional judge runs one persistent ACP session for every agent-authored
message. The coordinator mechanically supplies the preceding thread context;
the judge must use only that input and must not call tools or investigate. The
ACP session returns a structured verdict, which the bot applies
deterministically. A pass gets a `👍`. A failure gets a `👎` and a corrective
threaded reply that tags the author agent and tells it to continue. The rules
check delivery completeness and avoidable handoffs. The latter fails only when
the supplied context itself establishes a safe next step or existing convention;
insufficient context and genuine user-only decisions pass.

An optional emoji reactor runs a separate persistent ACP session. For each new
top-level kind `9` message, it chooses one relevant reaction from the message's
topic, intent, and tone. The choice is not restricted to a hardcoded set: any
reaction content accepted by Buzz's 64-character NIP-25 builder can be used.
Replies and the bot's own messages are ignored.
The lifecycle reactions `⏳`, `✅`, and `⚠️` are reserved and cannot be chosen
by the free-form reactor.

Run `buzz-coordinator-bot backfill-emoji` with the same environment to react
to every historical top-level thread missing the bot's tagged reaction. The
paginated backfill is idempotent and rescans once it catches up, so threads
created during the initial pass are included.

## Exact routing rule

For each new kind `9` message authored by the configured owner, the bot:

1. Uses NIP-10 thread tags when present; a top-level message starts a new thread.
2. Queries the complete thread from the relay.
3. Ignores its own prior routing messages when counting participants.
4. Requires every other author to have exactly one valid NIP-OA `auth` tag
   proving the configured owner.
5. Reuses the thread's sticky agent assignment when that agent is still a
   current channel member. Otherwise it requires exactly one verified current
   member agent author in the thread.
6. Uses a per-channel or global configured default for a new untagged root,
   provided that agent is a current channel member, and otherwise falls back to
   the most recent verified current member agent in that channel.
7. Does nothing if the owner's new message already `p`-tags anyone.
8. Re-reads the thread before publishing and yields to an owner mention that
   arrived while the route was being resolved.
9. Does nothing if it already routed that exact message.
10. Otherwise posts a sibling kind `9` reply in the thread with the
   agent's real `p` tag, friendly `@name`, and the owner's message text.

The original user event remains unchanged because Nostr events are signed and
immutable. Once the target agent reacts to the routed mention, the bot removes
that mention with a channel-scoped NIP-09 deletion. The deletion keeps the
bot-specific source-event tag as a durable handled receipt, so removing the
visible mention cannot make the owner message eligible again after a reconnect.

## Configuration

The bot has its own key. It can run either as a standalone identity configured
with `BUZZ_OWNER_PUBKEY` or comma-separated `BUZZ_OWNER_PUBKEYS`, or with an
unrestricted `BUZZ_AUTH_TAG` signed by an owner for that bot key. Configured
owner keys are additive when an attestation is present. An owner-attested bot works with the default
`buzz-acp --respond-to=owner-only` gate. A standalone bot must be explicitly
included in each target agent's `--respond-to=allowlist`; the private-host
installer configures that exact-key allowlist automatically.

```bash
export BUZZ_RELAY_URL=wss://buzz.example.com
export BUZZ_BOT_PRIVATE_KEY=<bot-nsec-or-hex-secret>
export BUZZ_OWNER_PUBKEY=<owner-npub-or-hex-public-key>
# Optional: authorize additional owner identities.
export BUZZ_OWNER_PUBKEYS=<owner-public-key>[,<owner-public-key>...]
# Optional: restrict routing to specific channels.
export BUZZ_CHANNEL_IDS=<channel-uuid>[,<channel-uuid>...]
# Optional: route untagged new roots to this agent.
export BUZZ_DEFAULT_AGENT_PUBKEY=<agent-public-key>
# Optional: override defaults per channel.
export BUZZ_CHANNEL_AGENT_DEFAULTS=<channel-uuid>=<agent-public-key>[,...]
# Optional: publish a profile avatar.
export BUZZ_BOT_PICTURE_URL=https://buzz.example.com/media/avatar.png
# Optional: enable one vendor-independent ACP judge session.
export BUZZ_JUDGE_ENABLED=true
export BUZZ_JUDGE_AGENT_COMMAND=/opt/bin/acp-agent
export BUZZ_JUDGE_AGENT_ARGS=--flag,value
# Optional: defaults to $HOME, 120 seconds idle, and 600 seconds total.
export BUZZ_JUDGE_CWD=/workspace
export BUZZ_JUDGE_IDLE_TIMEOUT=120
export BUZZ_JUDGE_MAX_DURATION=600
# Optional: use the same ACP configuration for top-level emoji reactions.
export BUZZ_EMOJI_REACTOR_ENABLED=true

cargo run -p buzz-coordinator-bot
```

Omit `BUZZ_CHANNEL_IDS` to discover and watch every channel the bot can access.
Membership notifications refresh the channel list immediately. A five-minute
safety check keeps the current subscriptions live when the accessible set is
unchanged and reconnects only when that set actually changes.
`BUZZ_CHANNEL_ID` is accepted as a single-channel compatibility alias.

The coordinator accepts ephemeral `kind:24201` lifecycle snapshots only from
agents with a valid NIP-OA attestation for a configured owner. It aggregates
concurrent agent turns, rejects reordered snapshots, expires stale work, and
recovers its tagged durable root reactions after restart. See
[`NIP-AT`](../../docs/nips/NIP-AT.md).

To upgrade from standalone mode, generate the bot-specific attestation once
and save its output as `BUZZ_AUTH_TAG`. The verified attestation adds its signer
to the configured owners:

```bash
printf '%s\n' '<owner-nsec-or-hex-secret>' | \
  BUZZ_BOT_PRIVATE_KEY=<bot-nsec-or-hex-secret> \
  cargo run -q -p buzz-coordinator-bot -- auth-tag
```

Do not leave `BUZZ_OWNER_PRIVATE_KEY` in the service environment. The running
bot needs only its own private key and the public attestation.

On explicitly configured open channels the bot best-effort self-adds with
`role=bot`. On private channels an owner or channel admin must add the bot
pubkey before it can read or write. The bot prints its pubkey at startup, or it
can be obtained without connecting to a relay:

```bash
BUZZ_BOT_PRIVATE_KEY=<bot-nsec-or-hex-secret> \
  cargo run -q -p buzz-coordinator-bot -- public-key
```

## Private-host installation

The repository's private-host installer builds and installs the binary and its
tracked user service. On first use it generates a dedicated bot identity,
uploads the tracked bot avatar with that identity, and adds only that public
key to each installed ACP agent's response allowlist:

```bash
./deploy/private-host/install-buzz-coordinator-bot.sh --judge --emoji-reactor --restart
```

This standalone path needs no owner secret. Open channels require no
per-channel setup. Private channels must admit the bot through an existing
member. If desired, `--sign --channel UUID --restart` prompts without echo for
the owner key, writes only the resulting attestation, and adds the bot to that
private channel. The owner key is passed to the signer over stdin and is not
written to disk or placed in a process argument or environment variable.
`--judge` writes a separate non-secret `judge.env` for a single slopd Codex ACP
session. `BUZZ_JUDGE_AGENT_ACCOUNT` and `BUZZ_JUDGE_AGENT_BACKEND` can override
the install-time `codex` defaults. `--emoji-reactor` adds a second lazy ACP
session using that same vendor-independent command. Subsequent code updates
need only `--restart`; the stable identity and judge configuration remain in
the mode-0600 files under `~/.config/buzz-coordinator-bot/`. When present,
the shared `buzz-machine` identity is added to the owner allowlist automatically.
The installer moves an existing `buzz-thread-mention-bot` identity and retires
its old service during the first renamed `--restart` installation.

## Generic systemd

```ini
[Unit]
Description=Buzz conversation coordinator bot
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/buzz/coordinator-bot.env
ExecStart=/opt/buzz/buzz-coordinator-bot
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

The bot reconnects automatically. Each candidate is checked against relay
history, and either an existing route or its durable deletion receipt prevents
duplicate routing after reconnects or restarts.
