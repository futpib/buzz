//! Deterministically re-mention the sole agent in an owner/agent Buzz thread.

use std::collections::{HashMap, HashSet};
use std::io;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use buzz_sdk::{MemberRole, ThreadRef};
use buzz_ws_client::{NostrWsConnection, RelayMessage, WsClientError};
use nostr::{
    Alphabet, Event, EventBuilder, EventId, Filter, Keys, Kind, PublicKey, SingleLetterTag, Tag,
    Timestamp, ToBech32,
};
use serde_json::json;
use uuid::Uuid;

const DEFAULT_RELAY_URL: &str = "ws://localhost:3000";
const LIVE_SUBSCRIPTION_ID: &str = "thread-mention-live";
const THREAD_SUBSCRIPTION_ID: &str = "thread-mention-query";
const BOT_NAME: &str = "thread-mention-bot";
const BOT_DISPLAY_NAME: &str = "Thread Mention Bot";
const BOT_ABOUT: &str =
    "Deterministically tags the sole same-owner agent in an otherwise two-party thread.";
const RECONNECT_DELAY: Duration = Duration::from_secs(3);
const LIVE_REPLAY_WINDOW_SECS: u64 = 300;
const RECEIVE_TIMEOUT: Duration = Duration::from_secs(60);
const THREAD_QUERY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_THREAD_EVENTS: usize = 1_000;

#[tokio::main]
async fn main() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("auth-tag") => return print_auth_tag(),
        Some("generate-key") => return print_generated_key(),
        Some("public-key") => return print_public_key(),
        Some(command) => bail!("unknown command {command:?}"),
        None => {}
    }

    let config = Config::from_env()?;
    eprintln!("thread-mention-bot pubkey: {}", config.bot_pubkey_hex());
    let channels = if config.channel_ids.is_empty() {
        "all accessible channels".to_string()
    } else {
        config
            .channel_ids
            .iter()
            .map(Uuid::to_string)
            .collect::<Vec<_>>()
            .join(",")
    };
    eprintln!(
        "owner: {}; channels: {channels}",
        config.owner_pubkey.to_hex()
    );

    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);

    loop {
        let result = tokio::select! {
            _ = &mut shutdown => return Ok(()),
            result = bootstrap(&config) => result,
        };
        match result {
            Ok(()) => break,
            Err(error) => eprintln!("bootstrap failed: {error:#}; retrying"),
        }
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            _ = tokio::time::sleep(RECONNECT_DELAY) => {}
        }
    }

    loop {
        let result = tokio::select! {
            _ = &mut shutdown => return Ok(()),
            result = listen_once(&config) => result,
        };
        if let Err(error) = result {
            eprintln!("relay listener stopped: {error:#}; reconnecting");
        }
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            _ = tokio::time::sleep(RECONNECT_DELAY) => {}
        }
    }
}

struct Config {
    relay_url: String,
    channel_ids: Vec<Uuid>,
    bot_keys: Keys,
    owner_auth_tag: Tag,
    owner_pubkey: PublicKey,
}

impl Config {
    fn from_env() -> Result<Self> {
        let relay_url = std::env::var("BUZZ_RELAY_URL")
            .or_else(|_| std::env::var("BUZZ_RELAY_WS_URL"))
            .unwrap_or_else(|_| DEFAULT_RELAY_URL.to_string());
        let bot_keys = Keys::parse(&required_env("BUZZ_BOT_PRIVATE_KEY")?)
            .context("BUZZ_BOT_PRIVATE_KEY must be an nsec or hex private key")?;
        let auth_tag_json = required_env("BUZZ_AUTH_TAG")?;
        let owner_pubkey =
            buzz_sdk::nip_oa::verify_auth_tag(&auth_tag_json, &bot_keys.public_key())
                .context("BUZZ_AUTH_TAG is not valid for BUZZ_BOT_PRIVATE_KEY")?;
        let owner_auth_tag = buzz_sdk::nip_oa::parse_auth_tag(&auth_tag_json)?;

        let channel_ids_raw = std::env::var("BUZZ_CHANNEL_IDS")
            .or_else(|_| std::env::var("BUZZ_CHANNEL_ID"))
            .unwrap_or_default();
        let mut seen = HashSet::new();
        let mut channel_ids = Vec::new();
        for value in channel_ids_raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let channel_id = Uuid::parse_str(value)
                .with_context(|| format!("invalid channel UUID {value:?}"))?;
            if seen.insert(channel_id) {
                channel_ids.push(channel_id);
            }
        }
        Ok(Self {
            relay_url,
            channel_ids,
            bot_keys,
            owner_auth_tag,
            owner_pubkey,
        })
    }

    fn bot_pubkey_hex(&self) -> String {
        self.bot_keys.public_key().to_hex()
    }

    fn sign(&self, builder: EventBuilder) -> Result<Event> {
        Ok(builder
            .tag(self.owner_auth_tag.clone())
            .sign_with_keys(&self.bot_keys)?)
    }
}

fn print_auth_tag() -> Result<()> {
    let owner_secret = match std::env::var("BUZZ_OWNER_PRIVATE_KEY") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => {
            let mut value = String::new();
            io::stdin()
                .read_line(&mut value)
                .context("failed to read owner key from stdin")?;
            value.trim().to_string()
        }
        Err(error) => return Err(error).context("BUZZ_OWNER_PRIVATE_KEY is not valid Unicode"),
    };
    if owner_secret.is_empty() {
        bail!("BUZZ_OWNER_PRIVATE_KEY or an owner key on stdin is required");
    }
    let owner_keys = Keys::parse(&owner_secret)
        .context("BUZZ_OWNER_PRIVATE_KEY must be an nsec or hex private key")?;
    let bot_keys = Keys::parse(&required_env("BUZZ_BOT_PRIVATE_KEY")?)
        .context("BUZZ_BOT_PRIVATE_KEY must be an nsec or hex private key")?;
    println!(
        "{}",
        buzz_sdk::nip_oa::compute_auth_tag(&owner_keys, &bot_keys.public_key(), "")?
    );
    Ok(())
}

fn print_generated_key() -> Result<()> {
    println!("{}", Keys::generate().secret_key().to_bech32()?);
    Ok(())
}

fn print_public_key() -> Result<()> {
    let keys = Keys::parse(&required_env("BUZZ_BOT_PRIVATE_KEY")?)
        .context("BUZZ_BOT_PRIVATE_KEY must be an nsec or hex private key")?;
    println!("{}", keys.public_key().to_hex());
    Ok(())
}

async fn bootstrap(config: &Config) -> Result<()> {
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        Some(&config.owner_auth_tag),
    )
    .await?;

    let profile = config.sign(buzz_sdk::build_profile(
        Some(BOT_DISPLAY_NAME),
        Some(BOT_NAME),
        None,
        Some(BOT_ABOUT),
        None,
    )?)?;
    publish_required(&mut connection, profile, "bot profile").await?;

    for channel_id in &config.channel_ids {
        let membership = config.sign(
            buzz_sdk::build_add_member(
                *channel_id,
                &config.bot_pubkey_hex(),
                Some(MemberRole::Bot),
            )?
            .allow_self_tagging(),
        )?;
        let response = connection.send_event(membership).await?;
        if !response.accepted {
            eprintln!(
                "could not self-add in channel {channel_id}: {} (private channels require an owner/admin add)",
                response.message
            );
        }
    }

    let _ = connection.disconnect().await;
    Ok(())
}

async fn publish_required(
    connection: &mut NostrWsConnection,
    event: Event,
    label: &str,
) -> Result<()> {
    let response = connection.send_event(event).await?;
    if !response.accepted {
        bail!("relay rejected {label}: {}", response.message);
    }
    Ok(())
}

async fn listen_once(config: &Config) -> Result<()> {
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        Some(&config.owner_auth_tag),
    )
    .await?;
    let now = Timestamp::now().as_secs();
    let channel_values = config
        .channel_ids
        .iter()
        .map(Uuid::to_string)
        .collect::<Vec<_>>();
    let mut filter = Filter::new()
        .kind(Kind::Custom(9))
        .author(config.owner_pubkey)
        .since(Timestamp::from_secs(
            now.saturating_sub(LIVE_REPLAY_WINDOW_SECS),
        ));
    if !channel_values.is_empty() {
        filter = filter.custom_tags(
            SingleLetterTag::lowercase(Alphabet::H),
            channel_values.iter().map(String::as_str),
        );
    }
    connection
        .send_raw(&json!(["REQ", LIVE_SUBSCRIPTION_ID, filter]))
        .await?;
    eprintln!("listening for owner-authored thread replies");

    loop {
        match connection.next_event(RECEIVE_TIMEOUT).await {
            Ok(RelayMessage::Event {
                subscription_id,
                event,
            }) if subscription_id == LIVE_SUBSCRIPTION_ID => {
                if let Err(error) = maybe_route(config, &mut connection, &event).await {
                    eprintln!("failed to evaluate {}: {error:#}", event.id.to_hex());
                }
            }
            Ok(RelayMessage::Closed {
                subscription_id,
                message,
            }) if subscription_id == LIVE_SUBSCRIPTION_ID => {
                bail!("relay closed live subscription: {message}");
            }
            Ok(RelayMessage::Notice { message }) => eprintln!("relay notice: {message}"),
            Ok(_) | Err(WsClientError::Timeout) => {}
            Err(error) => return Err(error.into()),
        }
    }
}

async fn maybe_route(
    config: &Config,
    live_connection: &mut NostrWsConnection,
    candidate: &Event,
) -> Result<()> {
    if candidate.kind != Kind::Custom(9) || candidate.pubkey != config.owner_pubkey {
        return Ok(());
    }
    let Some(relation) = parse_thread_relation(candidate) else {
        return Ok(());
    };
    let channel_id = event_channel(candidate)
        .and_then(|value| Uuid::parse_str(value).ok())
        .filter(|channel| config.channel_ids.is_empty() || config.channel_ids.contains(channel))
        .ok_or_else(|| anyhow!("candidate has no eligible channel tag"))?;
    let thread = load_thread(config, channel_id, relation.root_event_id).await?;
    let Some(agent) = route_target(
        &thread,
        candidate,
        &config.owner_pubkey,
        &config.bot_keys.public_key(),
    ) else {
        return Ok(());
    };

    let agent_hex = agent.to_hex();
    let agent_npub = agent
        .to_bech32()
        .context("failed to encode target agent as npub")?;
    let thread_ref = ThreadRef {
        root_event_id: relation.root_event_id,
        parent_event_id: candidate.id,
    };
    let event = config.sign(buzz_sdk::build_message(
        channel_id,
        &format!("nostr:{agent_npub}"),
        Some(&thread_ref),
        &[&agent_hex],
        false,
        &[],
    )?)?;
    let response = live_connection.send_event(event).await?;
    if !response.accepted {
        bail!("relay rejected routed mention: {}", response.message);
    }
    eprintln!(
        "tagged agent {} for owner message {}",
        agent_hex,
        candidate.id.to_hex()
    );
    Ok(())
}

async fn load_thread(config: &Config, channel_id: Uuid, root_id: EventId) -> Result<Vec<Event>> {
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        Some(&config.owner_auth_tag),
    )
    .await?;
    let channel = channel_id.to_string();
    let root = root_id.to_hex();
    let h_tag = SingleLetterTag::lowercase(Alphabet::H);
    let root_filter = Filter::new()
        .id(root_id)
        .kind(Kind::Custom(9))
        .custom_tags(h_tag, [channel.as_str()]);
    let replies_filter = Filter::new()
        .kind(Kind::Custom(9))
        .custom_tags(SingleLetterTag::lowercase(Alphabet::E), [root.as_str()])
        .custom_tags(SingleLetterTag::lowercase(Alphabet::H), [channel.as_str()])
        .limit(MAX_THREAD_EVENTS);
    connection
        .send_raw(&json!([
            "REQ",
            THREAD_SUBSCRIPTION_ID,
            root_filter,
            replies_filter
        ]))
        .await?;

    let mut events = HashMap::new();
    loop {
        match connection.next_event(THREAD_QUERY_TIMEOUT).await? {
            RelayMessage::Event {
                subscription_id,
                event,
            } if subscription_id == THREAD_SUBSCRIPTION_ID => {
                event
                    .verify()
                    .context("relay returned an event with an invalid signature")?;
                if events.len() >= MAX_THREAD_EVENTS && !events.contains_key(&event.id.to_hex()) {
                    bail!("thread exceeds {MAX_THREAD_EVENTS} events; refusing incomplete routing");
                }
                events.insert(event.id.to_hex(), *event);
            }
            RelayMessage::Eose { subscription_id } if subscription_id == THREAD_SUBSCRIPTION_ID => {
                break;
            }
            RelayMessage::Closed {
                subscription_id,
                message,
            } if subscription_id == THREAD_SUBSCRIPTION_ID => {
                bail!("relay closed thread query: {message}");
            }
            RelayMessage::Notice { message } => eprintln!("relay notice during query: {message}"),
            _ => {}
        }
    }
    let _ = connection
        .send_raw(&json!(["CLOSE", THREAD_SUBSCRIPTION_ID]))
        .await;
    let _ = connection.disconnect().await;

    if !events.contains_key(&root) {
        bail!("thread query did not return root event {root}");
    }
    Ok(events.into_values().collect())
}

#[derive(Clone, Copy)]
struct ThreadRelation {
    root_event_id: EventId,
    parent_event_id: EventId,
}

fn parse_thread_relation(event: &Event) -> Option<ThreadRelation> {
    let mut root = None;
    let mut reply = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(String::as_str) != Some("e") || parts.len() < 4 {
            continue;
        }
        let event_id = EventId::from_hex(&parts[1]).ok()?;
        match parts[3].as_str() {
            "root" => root = Some(event_id),
            "reply" => reply = Some(event_id),
            _ => {}
        }
    }
    match (root, reply) {
        (Some(root_event_id), Some(parent_event_id)) => Some(ThreadRelation {
            root_event_id,
            parent_event_id,
        }),
        (Some(root_event_id), None) => Some(ThreadRelation {
            root_event_id,
            parent_event_id: root_event_id,
        }),
        (None, Some(parent_event_id)) => Some(ThreadRelation {
            root_event_id: parent_event_id,
            parent_event_id,
        }),
        (None, None) => None,
    }
}

fn route_target(
    thread: &[Event],
    candidate: &Event,
    owner: &PublicKey,
    bot: &PublicKey,
) -> Option<PublicKey> {
    if candidate.pubkey != *owner || parse_thread_relation(candidate).is_none() {
        return None;
    }

    let mut agents = HashSet::new();
    for event in thread {
        if event.kind != Kind::Custom(9) || event.pubkey == *owner || event.pubkey == *bot {
            continue;
        }
        if !is_same_owner_agent(event, owner) {
            return None;
        }
        agents.insert(event.pubkey);
    }
    let mut agents = agents.into_iter();
    let agent = agents.next()?;
    if agents.next().is_some() || event_mentions(candidate, &agent) {
        return None;
    }
    if thread.iter().any(|event| {
        event.pubkey == *bot
            && event_mentions(event, &agent)
            && parse_thread_relation(event)
                .is_some_and(|relation| relation.parent_event_id == candidate.id)
    }) {
        return None;
    }
    Some(agent)
}

fn is_same_owner_agent(event: &Event, owner: &PublicKey) -> bool {
    let mut auth_tags = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("auth"));
    let Some(auth_tag) = auth_tags.next() else {
        return false;
    };
    if auth_tags.next().is_some() {
        return false;
    }
    let Ok(json) = serde_json::to_string(auth_tag.as_slice()) else {
        return false;
    };
    buzz_sdk::nip_oa::verify_auth_tag(&json, &event.pubkey)
        .is_ok_and(|agent_owner| agent_owner == *owner)
}

fn event_mentions(event: &Event, pubkey: &PublicKey) -> bool {
    let target = pubkey.to_hex();
    event.tags.iter().any(|tag| {
        let parts = tag.as_slice();
        parts.first().map(String::as_str) == Some("p")
            && parts.get(1).map(String::as_str) == Some(target.as_str())
    })
}

fn event_channel(event: &Event) -> Option<&str> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.first().map(String::as_str) == Some("h"))
            .then(|| parts.get(1).map(String::as_str))
            .flatten()
    })
}

fn required_env(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    if value.trim().is_empty() {
        bail!("{name} must not be empty");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_tag(owner: &Keys, agent: &Keys) -> Tag {
        let json = buzz_sdk::nip_oa::compute_auth_tag(owner, &agent.public_key(), "").unwrap();
        buzz_sdk::nip_oa::parse_auth_tag(&json).unwrap()
    }

    fn message(
        keys: &Keys,
        auth: Option<&Tag>,
        channel: Uuid,
        thread: Option<&ThreadRef>,
        mentions: &[&str],
    ) -> Event {
        let builder =
            buzz_sdk::build_message(channel, "message", thread, mentions, false, &[]).unwrap();
        let builder = match auth {
            Some(tag) => builder.tag(tag.clone()),
            None => builder,
        };
        builder.sign_with_keys(keys).unwrap()
    }

    struct Fixture {
        owner: Keys,
        agent: Keys,
        bot: Keys,
        channel: Uuid,
        root: Event,
        agent_reply: Event,
    }

    impl Fixture {
        fn new() -> Self {
            let owner = Keys::generate();
            let agent = Keys::generate();
            let bot = Keys::generate();
            let channel = Uuid::new_v4();
            let root = message(&owner, None, channel, None, &[]);
            let agent_auth = auth_tag(&owner, &agent);
            let agent_reply = message(
                &agent,
                Some(&agent_auth),
                channel,
                Some(&ThreadRef {
                    root_event_id: root.id,
                    parent_event_id: root.id,
                }),
                &[],
            );
            Self {
                owner,
                agent,
                bot,
                channel,
                root,
                agent_reply,
            }
        }

        fn candidate(&self, mentions: &[&str]) -> Event {
            message(
                &self.owner,
                None,
                self.channel,
                Some(&ThreadRef {
                    root_event_id: self.root.id,
                    parent_event_id: self.agent_reply.id,
                }),
                mentions,
            )
        }

        fn base_thread(&self, candidate: &Event) -> Vec<Event> {
            vec![
                self.root.clone(),
                self.agent_reply.clone(),
                candidate.clone(),
            ]
        }
    }

    #[test]
    fn routes_untagged_owner_reply_in_two_party_thread() {
        let fixture = Fixture::new();
        assert!(parse_thread_relation(&fixture.agent_reply).is_some());
        assert_eq!(
            event_channel(&fixture.agent_reply),
            Some(fixture.channel.to_string()).as_deref()
        );
        let candidate = fixture.candidate(&[]);
        assert_eq!(
            route_target(
                &fixture.base_thread(&candidate),
                &candidate,
                &fixture.owner.public_key(),
                &fixture.bot.public_key(),
            ),
            Some(fixture.agent.public_key())
        );
    }

    #[test]
    fn self_membership_keeps_target_tag() {
        let fixture = Fixture::new();
        let bot_hex = fixture.bot.public_key().to_hex();
        let event = buzz_sdk::build_add_member(fixture.channel, &bot_hex, Some(MemberRole::Bot))
            .unwrap()
            .allow_self_tagging()
            .tag(auth_tag(&fixture.owner, &fixture.bot))
            .sign_with_keys(&fixture.bot)
            .unwrap();
        assert!(event_mentions(&event, &fixture.bot.public_key()));
    }

    #[test]
    fn skips_when_owner_already_tagged_agent() {
        let fixture = Fixture::new();
        let agent_hex = fixture.agent.public_key().to_hex();
        let candidate = fixture.candidate(&[&agent_hex]);
        assert!(route_target(
            &fixture.base_thread(&candidate),
            &candidate,
            &fixture.owner.public_key(),
            &fixture.bot.public_key(),
        )
        .is_none());
    }

    #[test]
    fn skips_thread_with_another_human() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate(&[]);
        let stranger = Keys::generate();
        let stranger_reply = message(
            &stranger,
            None,
            fixture.channel,
            Some(&ThreadRef {
                root_event_id: fixture.root.id,
                parent_event_id: fixture.root.id,
            }),
            &[],
        );
        let mut thread = fixture.base_thread(&candidate);
        thread.push(stranger_reply);
        assert!(route_target(
            &thread,
            &candidate,
            &fixture.owner.public_key(),
            &fixture.bot.public_key(),
        )
        .is_none());
    }

    #[test]
    fn skips_thread_with_second_agent() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate(&[]);
        let second_agent = Keys::generate();
        let second_auth = auth_tag(&fixture.owner, &second_agent);
        let second_reply = message(
            &second_agent,
            Some(&second_auth),
            fixture.channel,
            Some(&ThreadRef {
                root_event_id: fixture.root.id,
                parent_event_id: fixture.root.id,
            }),
            &[],
        );
        let mut thread = fixture.base_thread(&candidate);
        thread.push(second_reply);
        assert!(route_target(
            &thread,
            &candidate,
            &fixture.owner.public_key(),
            &fixture.bot.public_key(),
        )
        .is_none());
    }

    #[test]
    fn skips_a_message_already_routed_by_bot() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate(&[]);
        let bot_auth = auth_tag(&fixture.owner, &fixture.bot);
        let agent_hex = fixture.agent.public_key().to_hex();
        let routed = message(
            &fixture.bot,
            Some(&bot_auth),
            fixture.channel,
            Some(&ThreadRef {
                root_event_id: fixture.root.id,
                parent_event_id: candidate.id,
            }),
            &[&agent_hex],
        );
        let mut thread = fixture.base_thread(&candidate);
        thread.push(routed);
        assert!(route_target(
            &thread,
            &candidate,
            &fixture.owner.public_key(),
            &fixture.bot.public_key(),
        )
        .is_none());
    }

    #[test]
    fn skips_top_level_owner_message() {
        let fixture = Fixture::new();
        let candidate = message(&fixture.owner, None, fixture.channel, None, &[]);
        assert!(route_target(
            &[candidate.clone(), fixture.agent_reply],
            &candidate,
            &fixture.owner.public_key(),
            &fixture.bot.public_key(),
        )
        .is_none());
    }
}
