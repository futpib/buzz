//! Deterministically re-mention the sole agent in an owner/agent Buzz thread.

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use buzz_acp::persistent_session::PersistentAcpSession;
use buzz_sdk::{MemberRole, ThreadRef};
use buzz_ws_client::{NostrWsConnection, RelayMessage, WsClientError};
use nostr::{
    Alphabet, Event, EventBuilder, EventId, Filter, Keys, Kind, PublicKey, SingleLetterTag, Tag,
    Timestamp, ToBech32,
};
use serde_json::json;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

const DEFAULT_RELAY_URL: &str = "ws://localhost:3000";
const LIVE_SUBSCRIPTION_ID: &str = "thread-mention-live";
const THREAD_SUBSCRIPTION_ID: &str = "thread-mention-query";
const ROUTE_SUBSCRIPTION_ID: &str = "thread-mention-routes";
const REACTION_SUBSCRIPTION_ID: &str = "thread-mention-reaction";
const CHANNEL_SUBSCRIPTION_ID: &str = "thread-mention-channels";
const PROFILE_SUBSCRIPTION_ID: &str = "thread-mention-profile";
const ROUTED_SOURCE_TAG: &str = "thread-mention-for";
const JUDGED_SOURCE_TAG: &str = "message-judge-for";
const JUDGE_RESULT_TAG: &str = "message-judge-result";
const COMPLETE_MESSAGE_RULE: &str = "complete_message";
const BOT_NAME: &str = "thread-mention-bot";
const BOT_DISPLAY_NAME: &str = "Thread Mention Bot";
const BOT_ABOUT: &str = "Routes two-party thread replies and applies ACP message-quality verdicts.";
const RECONNECT_DELAY: Duration = Duration::from_secs(3);
const REACTION_POLL_INTERVAL: Duration = Duration::from_secs(2);
const CHANNEL_REFRESH_INTERVAL: Duration = Duration::from_secs(300);
const LIVE_REPLAY_WINDOW_SECS: u64 = 300;
const ROUTE_ACK_WINDOW_SECS: u64 = 3_600;
const RECEIVE_TIMEOUT: Duration = Duration::from_secs(60);
const THREAD_QUERY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_THREAD_EVENTS: usize = 1_000;
const MAX_CHANNELS: usize = 500;
const JUDGE_QUEUE_SIZE: usize = 256;
const JUDGE_RETRY_LIMIT: usize = 2;

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();

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
        "owners: {}; channels: {channels}",
        config
            .owner_pubkeys
            .iter()
            .map(PublicKey::to_hex)
            .collect::<Vec<_>>()
            .join(",")
    );
    eprintln!(
        "message judge: {}",
        if config.judge.is_some() {
            "enabled"
        } else {
            "disabled"
        }
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

    let judge_tracker = Arc::new(Mutex::new(JudgeTracker::default()));
    let judge_tx = config.judge.as_ref().map(|_| {
        let (tx, rx) = mpsc::channel(JUDGE_QUEUE_SIZE);
        drop(tokio::spawn(run_judge_worker(
            config.clone(),
            Arc::clone(&judge_tracker),
            rx,
        )));
        tx
    });

    loop {
        let result = tokio::select! {
            _ = &mut shutdown => return Ok(()),
            result = listen_once(&config, judge_tx.as_ref(), Arc::clone(&judge_tracker)) => result,
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

#[derive(Clone)]
struct Config {
    relay_url: String,
    channel_ids: Vec<Uuid>,
    bot_keys: Keys,
    owner_auth_tag: Option<Tag>,
    owner_pubkeys: Vec<PublicKey>,
    picture_url: Option<String>,
    judge: Option<JudgeConfig>,
}

#[derive(Clone)]
struct JudgeConfig {
    command: String,
    args: Vec<String>,
    cwd: String,
    idle_timeout: Duration,
    max_duration: Duration,
}

#[derive(Clone, Copy)]
struct PendingRoute {
    channel_id: Uuid,
    agent: PublicKey,
    source_event_id: EventId,
    created_at: u64,
}

#[derive(Default)]
struct RouteState {
    pending: HashMap<EventId, PendingRoute>,
    handled_sources: HashSet<EventId>,
    judge_deliveries: HashMap<EventId, JudgeDelivery>,
}

#[derive(Clone, Default)]
struct JudgeDelivery {
    verdict: Option<JudgeVerdict>,
    reacted: bool,
    critiqued: bool,
}

impl JudgeDelivery {
    fn complete(&self) -> bool {
        self.verdict
            .as_ref()
            .is_some_and(|verdict| self.reacted && (verdict.pass || self.critiqued))
    }
}

#[derive(Default)]
struct JudgeTracker {
    deliveries: HashMap<EventId, JudgeDelivery>,
    queued: HashSet<EventId>,
}

#[derive(Clone)]
struct JudgeJob {
    event: Event,
    channel_id: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct JudgeVerdict {
    pass: bool,
    failures: Vec<JudgeFailure>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct JudgeFailure {
    rule: String,
    issue: String,
}

impl Config {
    fn from_env() -> Result<Self> {
        let relay_url = std::env::var("BUZZ_RELAY_WS_URL")
            .or_else(|_| std::env::var("BUZZ_RELAY_URL"))
            .unwrap_or_else(|_| DEFAULT_RELAY_URL.to_string());
        let bot_keys = Keys::parse(&required_env("BUZZ_BOT_PRIVATE_KEY")?)
            .context("BUZZ_BOT_PRIVATE_KEY must be an nsec or hex private key")?;
        let (attested_owner, owner_auth_tag) = match std::env::var("BUZZ_AUTH_TAG") {
            Ok(auth_tag_json) if !auth_tag_json.trim().is_empty() => {
                let owner_pubkey =
                    buzz_sdk::nip_oa::verify_auth_tag(&auth_tag_json, &bot_keys.public_key())
                        .context("BUZZ_AUTH_TAG is not valid for BUZZ_BOT_PRIVATE_KEY")?;
                let owner_auth_tag = buzz_sdk::nip_oa::parse_auth_tag(&auth_tag_json)?;
                (Some(owner_pubkey), Some(owner_auth_tag))
            }
            _ => (None, None),
        };
        let owner_pubkeys = parse_owner_pubkeys(attested_owner)?;

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
        let judge = JudgeConfig::from_env()?;
        Ok(Self {
            relay_url,
            channel_ids,
            bot_keys,
            owner_auth_tag,
            owner_pubkeys,
            picture_url: std::env::var("BUZZ_BOT_PICTURE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            judge,
        })
    }

    fn bot_pubkey_hex(&self) -> String {
        self.bot_keys.public_key().to_hex()
    }

    fn sign(&self, builder: EventBuilder) -> Result<Event> {
        let builder = match &self.owner_auth_tag {
            Some(tag) => builder.tag(tag.clone()),
            None => builder,
        };
        Ok(builder.sign_with_keys(&self.bot_keys)?)
    }
}

impl JudgeConfig {
    fn from_env() -> Result<Option<Self>> {
        if !env_bool("BUZZ_JUDGE_ENABLED", false)? {
            return Ok(None);
        }
        let command = required_env("BUZZ_JUDGE_AGENT_COMMAND")?;
        let args = std::env::var("BUZZ_JUDGE_AGENT_ARGS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|arg| !arg.is_empty())
            .map(str::to_string)
            .collect();
        let cwd = std::env::var("BUZZ_JUDGE_CWD")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        Ok(Some(Self {
            command,
            args,
            cwd,
            idle_timeout: Duration::from_secs(env_u64("BUZZ_JUDGE_IDLE_TIMEOUT", 120)?),
            max_duration: Duration::from_secs(env_u64("BUZZ_JUDGE_MAX_DURATION", 600)?),
        }))
    }
}

fn parse_owner_pubkeys(attested_owner: Option<PublicKey>) -> Result<Vec<PublicKey>> {
    let mut owners = attested_owner.into_iter().collect::<Vec<_>>();
    let mut seen = owners.iter().copied().collect::<HashSet<_>>();
    for name in ["BUZZ_OWNER_PUBKEY", "BUZZ_OWNER_PUBKEYS"] {
        let Ok(value) = std::env::var(name) else {
            continue;
        };
        for raw in value
            .split(',')
            .map(str::trim)
            .filter(|raw| !raw.is_empty())
        {
            let owner = PublicKey::parse(raw)
                .with_context(|| format!("{name} contains an invalid public key"))?;
            if seen.insert(owner) {
                owners.push(owner);
            }
        }
    }
    if owners.is_empty() {
        bail!("BUZZ_OWNER_PUBKEY or BUZZ_OWNER_PUBKEYS is required");
    }
    Ok(owners)
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
        config.owner_auth_tag.as_ref(),
    )
    .await?;

    let profile = config.sign(buzz_sdk::build_profile(
        Some(BOT_DISPLAY_NAME),
        Some(BOT_NAME),
        config.picture_url.as_deref(),
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

async fn listen_once(
    config: &Config,
    judge_tx: Option<&mpsc::Sender<JudgeJob>>,
    judge_tracker: Arc<Mutex<JudgeTracker>>,
) -> Result<()> {
    let channel_ids = discover_channels(config).await?;
    let mut routes = load_route_state(config, &channel_ids).await?;
    if config.judge.is_some() {
        let mut tracker = judge_tracker.lock().await;
        for (source, delivery) in routes.judge_deliveries.drain() {
            tracker.deliveries.entry(source).or_insert(delivery);
        }
    }
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        config.owner_auth_tag.as_ref(),
    )
    .await?;
    let now = Timestamp::now().as_secs();
    for channel_id in &channel_ids {
        let channel = channel_id.to_string();
        let messages = Filter::new()
            .kind(Kind::Custom(9))
            .since(Timestamp::from_secs(
                now.saturating_sub(LIVE_REPLAY_WINDOW_SECS),
            ))
            .custom_tags(SingleLetterTag::lowercase(Alphabet::H), [channel.as_str()]);
        connection
            .send_raw(&json!([
                "REQ",
                format!("{LIVE_SUBSCRIPTION_ID}:{channel_id}"),
                messages
            ]))
            .await?;
    }
    eprintln!(
        "listening in {} channel(s); tracking {} pending route(s), {} handled source(s)",
        channel_ids.len(),
        routes.pending.len(),
        routes.handled_sources.len()
    );

    let refresh = tokio::time::sleep(CHANNEL_REFRESH_INTERVAL);
    tokio::pin!(refresh);
    let mut reaction_poll = tokio::time::interval(REACTION_POLL_INTERVAL);
    reaction_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = &mut refresh => bail!("refreshing channel subscriptions"),
            _ = reaction_poll.tick(), if !routes.pending.is_empty() => {
                if let Err(error) = poll_acknowledged_routes(
                    config,
                    &mut connection,
                    &mut routes.pending,
                ).await {
                    eprintln!("failed to poll routed mentions: {error:#}");
                }
            }
            message = connection.next_event(RECEIVE_TIMEOUT) => match message {
                Ok(RelayMessage::Event {
                    subscription_id,
                    event,
                }) if subscription_id.starts_with(LIVE_SUBSCRIPTION_ID) => {
                    if let Some(judge_tx) = judge_tx {
                        if let Err(error) = maybe_enqueue_judge(
                            config,
                            judge_tx,
                            &judge_tracker,
                            &event,
                        ).await {
                            eprintln!("failed to enqueue judge job for {}: {error:#}", event.id.to_hex());
                        }
                    }
                    let result = maybe_route(
                        config,
                        &mut connection,
                        &event,
                        &mut routes,
                    ).await;
                    if let Err(error) = result {
                        eprintln!("failed to evaluate {}: {error:#}", event.id.to_hex());
                    }
                }
                Ok(RelayMessage::Closed {
                    subscription_id,
                    message,
                }) if subscription_id.starts_with(LIVE_SUBSCRIPTION_ID) => {
                    bail!("relay closed live subscription: {message}");
                }
                Ok(RelayMessage::Notice { message }) => eprintln!("relay notice: {message}"),
                Ok(_) | Err(WsClientError::Timeout) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
}

async fn discover_channels(config: &Config) -> Result<Vec<Uuid>> {
    if !config.channel_ids.is_empty() {
        return Ok(config.channel_ids.clone());
    }
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        config.owner_auth_tag.as_ref(),
    )
    .await?;
    connection
        .send_raw(&json!([
            "REQ",
            CHANNEL_SUBSCRIPTION_ID,
            Filter::new().kind(Kind::Custom(39000)).limit(MAX_CHANNELS)
        ]))
        .await?;
    let mut channels = HashSet::new();
    loop {
        match connection.next_event(THREAD_QUERY_TIMEOUT).await? {
            RelayMessage::Event {
                subscription_id,
                event,
            } if subscription_id == CHANNEL_SUBSCRIPTION_ID => {
                event
                    .verify()
                    .context("invalid channel metadata signature")?;
                if let Some(channel) =
                    event_tag_value(&event, "d").and_then(|value| Uuid::parse_str(value).ok())
                {
                    channels.insert(channel);
                }
            }
            RelayMessage::Eose { subscription_id }
                if subscription_id == CHANNEL_SUBSCRIPTION_ID =>
            {
                break;
            }
            RelayMessage::Closed {
                subscription_id,
                message,
            } if subscription_id == CHANNEL_SUBSCRIPTION_ID => {
                bail!("relay closed channel query: {message}");
            }
            _ => {}
        }
    }
    let _ = connection.disconnect().await;
    let mut channels = channels.into_iter().collect::<Vec<_>>();
    channels.sort_unstable();
    if channels.is_empty() {
        bail!("relay returned no accessible channels");
    }
    Ok(channels)
}

async fn maybe_route(
    config: &Config,
    live_connection: &mut NostrWsConnection,
    candidate: &Event,
    routes: &mut RouteState,
) -> Result<()> {
    if candidate.kind != Kind::Custom(9) || !config.owner_pubkeys.contains(&candidate.pubkey) {
        return Ok(());
    }
    let Some(relation) = parse_thread_relation(candidate) else {
        return Ok(());
    };
    if routes.handled_sources.contains(&candidate.id) {
        return Ok(());
    }
    let channel_id = event_channel(candidate)
        .and_then(|value| Uuid::parse_str(value).ok())
        .filter(|channel| config.channel_ids.is_empty() || config.channel_ids.contains(channel))
        .ok_or_else(|| anyhow!("candidate has no eligible channel tag"))?;
    let thread = load_thread(config, channel_id, relation.root_event_id).await?;
    let Some(agent) = route_target(
        &thread,
        candidate,
        &config.owner_pubkeys,
        &config.bot_keys.public_key(),
    ) else {
        return Ok(());
    };

    let agent_hex = agent.to_hex();
    let label = load_agent_label(config, &agent)
        .await
        .unwrap_or_else(|error| {
            eprintln!("could not resolve agent profile {agent_hex}: {error:#}");
            "agent".to_string()
        });
    let event = config.sign(build_routed_message(
        channel_id,
        relation.root_event_id,
        candidate,
        &agent_hex,
        &label,
    )?)?;
    let event_id = event.id;
    let created_at = event.created_at.as_secs();
    let response = live_connection.send_event(event).await?;
    if !response.accepted {
        bail!("relay rejected routed mention: {}", response.message);
    }
    eprintln!(
        "tagged agent {} for owner message {}",
        agent_hex,
        candidate.id.to_hex()
    );
    routes.handled_sources.insert(candidate.id);
    routes.pending.insert(
        event_id,
        PendingRoute {
            channel_id,
            agent,
            source_event_id: candidate.id,
            created_at,
        },
    );
    Ok(())
}

async fn maybe_enqueue_judge(
    config: &Config,
    judge_tx: &mpsc::Sender<JudgeJob>,
    tracker: &Arc<Mutex<JudgeTracker>>,
    candidate: &Event,
) -> Result<()> {
    if candidate.kind != Kind::Custom(9)
        || candidate.pubkey == config.bot_keys.public_key()
        || !config
            .owner_pubkeys
            .iter()
            .any(|owner| is_same_owner_agent(candidate, owner))
    {
        return Ok(());
    }
    candidate.verify().context("invalid candidate signature")?;
    let channel_id = event_channel(candidate)
        .and_then(|value| Uuid::parse_str(value).ok())
        .filter(|channel| config.channel_ids.is_empty() || config.channel_ids.contains(channel))
        .ok_or_else(|| anyhow!("candidate has no eligible channel tag"))?;
    {
        let mut tracker = tracker.lock().await;
        if tracker
            .deliveries
            .get(&candidate.id)
            .is_some_and(JudgeDelivery::complete)
            || !tracker.queued.insert(candidate.id)
        {
            return Ok(());
        }
    }
    if let Err(error) = judge_tx
        .send(JudgeJob {
            event: candidate.clone(),
            channel_id,
        })
        .await
    {
        tracker.lock().await.queued.remove(&candidate.id);
        return Err(anyhow!("judge worker stopped: {error}"));
    }
    Ok(())
}

async fn run_judge_worker(
    config: Config,
    tracker: Arc<Mutex<JudgeTracker>>,
    mut jobs: mpsc::Receiver<JudgeJob>,
) {
    let Some(judge_config) = config.judge.clone() else {
        return;
    };
    let mut session = None;
    while let Some(job) = jobs.recv().await {
        let result = process_judge_job(&config, &judge_config, &tracker, &mut session, &job).await;
        tracker.lock().await.queued.remove(&job.event.id);
        match result {
            Ok(verdict) => eprintln!(
                "judged {}: {}",
                job.event.id.to_hex(),
                if verdict.pass { "pass" } else { "fail" }
            ),
            Err(error) => eprintln!("failed to judge {}: {error:#}", job.event.id.to_hex()),
        }
    }
    if let Some(mut session) = session {
        session.shutdown().await;
    }
}

async fn process_judge_job(
    config: &Config,
    judge_config: &JudgeConfig,
    tracker: &Arc<Mutex<JudgeTracker>>,
    session: &mut Option<PersistentAcpSession>,
    job: &JudgeJob,
) -> Result<JudgeVerdict> {
    let delivery = tracker
        .lock()
        .await
        .deliveries
        .get(&job.event.id)
        .cloned()
        .unwrap_or_default();
    let verdict = match delivery.verdict {
        Some(verdict) => verdict,
        None => request_judge_verdict(judge_config, session, &job.event).await?,
    };
    apply_judge_verdict(config, tracker, job, &verdict).await?;
    Ok(verdict)
}

async fn request_judge_verdict(
    config: &JudgeConfig,
    session: &mut Option<PersistentAcpSession>,
    event: &Event,
) -> Result<JudgeVerdict> {
    let base_prompt = judge_prompt(event);
    let mut invalid_output = None;
    for attempt in 0..JUDGE_RETRY_LIMIT {
        if session.is_none() {
            let spawned = tokio::time::timeout(
                Duration::from_secs(60),
                PersistentAcpSession::spawn(
                    &config.command,
                    &config.args,
                    &config.cwd,
                    Some("Buzz message judge"),
                ),
            )
            .await
            .context("judge ACP startup timed out")??;
            *session = Some(spawned);
        }
        let prompt = match invalid_output.as_deref() {
            Some(output) => format!(
                "{base_prompt}\n\nYour previous output was invalid: {}\nReturn only the required JSON object.",
                compact_text(output, 500)
            ),
            None => base_prompt.clone(),
        };
        let Some(active_session) = session.as_mut() else {
            bail!("judge ACP session was not initialized");
        };
        let response = active_session
            .prompt(&prompt, config.idle_timeout, config.max_duration)
            .await;
        match response {
            Ok(text) => match parse_judge_verdict(&text) {
                Ok(verdict) => return Ok(verdict),
                Err(error) if attempt + 1 < JUDGE_RETRY_LIMIT => {
                    invalid_output = Some(format!("{error}; output={text:?}"));
                }
                Err(error) => return Err(error),
            },
            Err(error) => {
                if let Some(mut failed) = session.take() {
                    failed.shutdown().await;
                }
                if attempt + 1 == JUDGE_RETRY_LIMIT {
                    return Err(error.into());
                }
            }
        }
    }
    bail!("judge produced no verdict")
}

async fn apply_judge_verdict(
    config: &Config,
    tracker: &Arc<Mutex<JudgeTracker>>,
    job: &JudgeJob,
    verdict: &JudgeVerdict,
) -> Result<()> {
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        config.owner_auth_tag.as_ref(),
    )
    .await?;
    let current = tracker
        .lock()
        .await
        .deliveries
        .get(&job.event.id)
        .cloned()
        .unwrap_or_default();
    if !current.reacted {
        let reaction = config.sign(build_judge_reaction(job.channel_id, &job.event, verdict)?)?;
        publish_required(&mut connection, reaction, "judge reaction").await?;
        let mut tracker = tracker.lock().await;
        let delivery = tracker.deliveries.entry(job.event.id).or_default();
        delivery.verdict = Some(verdict.clone());
        delivery.reacted = true;
    }
    if !verdict.pass {
        let critiqued = tracker
            .lock()
            .await
            .deliveries
            .get(&job.event.id)
            .is_some_and(|delivery| delivery.critiqued);
        if !critiqued {
            let agent_hex = job.event.pubkey.to_hex();
            let label = load_agent_label(config, &job.event.pubkey)
                .await
                .unwrap_or_else(|_| format!("agent-{}", &agent_hex[..8]));
            let critique = config.sign(build_judge_critique(
                job.channel_id,
                &job.event,
                verdict,
                &agent_hex,
                &label,
            )?)?;
            publish_required(&mut connection, critique, "judge critique").await?;
            let mut tracker = tracker.lock().await;
            let delivery = tracker.deliveries.entry(job.event.id).or_default();
            delivery.verdict = Some(verdict.clone());
            delivery.critiqued = true;
        }
    }
    let _ = connection.disconnect().await;
    Ok(())
}

fn judge_prompt(event: &Event) -> String {
    let content = serde_json::to_string(&event.content).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "You are a delivery-completeness judge. Evaluate only whether the message appears fully delivered. Do not judge correctness, usefulness, task completion, style, or brevity. Fail rule `{COMPLETE_MESSAGE_RULE}` only for evidence of truncation, such as an abrupt mid-sentence or mid-token ending, a dangling colon that clearly introduces missing content, an unfinished list item, or an unmatched code fence or delimiter. Questions, intentional fragments, terse progress updates, and references to prior context may pass. Return exactly one JSON object and no prose: {{\"pass\":true,\"failures\":[]}} or {{\"pass\":false,\"failures\":[{{\"rule\":\"{COMPLETE_MESSAGE_RULE}\",\"issue\":\"concise concrete reason\"}}]}}.\n\nMessage event id: {}\nMessage content: {content}",
        event.id.to_hex()
    )
}

fn parse_judge_verdict(text: &str) -> Result<JudgeVerdict> {
    let value: serde_json::Value =
        serde_json::from_str(text.trim()).context("judge response is not a JSON object")?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("judge response is not a JSON object"))?;
    let pass = object
        .get("pass")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| anyhow!("judge response has no boolean pass field"))?;
    let failures = object
        .get("failures")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| anyhow!("judge response has no failures array"))?
        .iter()
        .map(|failure| {
            let rule = failure
                .get("rule")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("judge failure has no rule"))?;
            let issue = failure
                .get("issue")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("judge failure has no issue"))?;
            Ok(JudgeFailure {
                rule: compact_text(rule, 80),
                issue: compact_text(issue, 500),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if pass == failures.is_empty() {
        Ok(JudgeVerdict { pass, failures })
    } else {
        bail!("judge pass and failures fields disagree")
    }
}

fn build_judge_reaction(
    channel_id: Uuid,
    source: &Event,
    verdict: &JudgeVerdict,
) -> Result<EventBuilder> {
    Ok(
        buzz_sdk::build_reaction(source.id, if verdict.pass { "👍" } else { "👎" })?
            .tag(Tag::parse(["h", channel_id.to_string().as_str()])?)
            .tag(Tag::parse([
                JUDGED_SOURCE_TAG,
                source.id.to_hex().as_str(),
            ])?)
            .tag(Tag::parse([
                JUDGE_RESULT_TAG,
                judge_verdict_json(verdict).as_str(),
            ])?),
    )
}

fn build_judge_critique(
    channel_id: Uuid,
    source: &Event,
    verdict: &JudgeVerdict,
    agent_hex: &str,
    agent_label: &str,
) -> Result<EventBuilder> {
    let relation = parse_thread_relation(source);
    let thread_ref = ThreadRef {
        root_event_id: relation
            .map(|relation| relation.root_event_id)
            .unwrap_or(source.id),
        parent_event_id: source.id,
    };
    let issues = verdict
        .failures
        .iter()
        .map(|failure| format!("{}: {}", failure.rule, failure.issue))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(buzz_sdk::build_message(
        channel_id,
        &format!("@{agent_label}\n\n👎 {issues}"),
        Some(&thread_ref),
        &[agent_hex],
        false,
        &[],
    )?
    .tag(Tag::parse([
        JUDGED_SOURCE_TAG,
        source.id.to_hex().as_str(),
    ])?)
    .tag(Tag::parse([
        JUDGE_RESULT_TAG,
        judge_verdict_json(verdict).as_str(),
    ])?))
}

fn judge_verdict_json(verdict: &JudgeVerdict) -> String {
    json!({
        "pass": verdict.pass,
        "failures": verdict
            .failures
            .iter()
            .map(|failure| json!({ "rule": failure.rule, "issue": failure.issue }))
            .collect::<Vec<_>>()
    })
    .to_string()
}

fn record_judge_event(
    deliveries: &mut HashMap<EventId, JudgeDelivery>,
    event: &Event,
    bot: &PublicKey,
) {
    if event.pubkey != *bot || (event.kind != Kind::Reaction && event.kind != Kind::Custom(9)) {
        return;
    }
    let Some(source) = unique_event_tag_value(event, JUDGED_SOURCE_TAG)
        .and_then(|value| EventId::from_hex(value).ok())
    else {
        return;
    };
    let Some(result) = unique_event_tag_value(event, JUDGE_RESULT_TAG) else {
        return;
    };
    let Ok(verdict) = parse_judge_verdict(result) else {
        return;
    };
    let expected_reaction = if verdict.pass { "👍" } else { "👎" };
    let delivery = deliveries.entry(source).or_default();
    if delivery
        .verdict
        .as_ref()
        .is_some_and(|existing| existing != &verdict)
    {
        return;
    }
    delivery.verdict = Some(verdict);
    if event.kind == Kind::Reaction && event.content == expected_reaction {
        delivery.reacted = true;
    } else if event.kind == Kind::Custom(9) {
        delivery.critiqued = true;
    }
}

fn compact_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

async fn poll_acknowledged_routes(
    config: &Config,
    live_connection: &mut NostrWsConnection,
    pending_routes: &mut HashMap<EventId, PendingRoute>,
) -> Result<()> {
    let cutoff = Timestamp::now()
        .as_secs()
        .saturating_sub(ROUTE_ACK_WINDOW_SECS);
    pending_routes.retain(|_, route| route.created_at >= cutoff);
    let routes = pending_routes
        .iter()
        .map(|(event_id, route)| (*event_id, *route))
        .collect::<Vec<_>>();
    for (event_id, route) in routes {
        let Some(reaction) = load_reaction(config, event_id, route).await? else {
            continue;
        };
        let deletion = config.sign(build_routed_deletion(
            route.channel_id,
            event_id,
            route.source_event_id,
        )?)?;
        let response = live_connection.send_event(deletion).await?;
        if !response.accepted {
            bail!(
                "relay rejected acknowledged route deletion: {}",
                response.message
            );
        }
        eprintln!(
            "deleted routed mention {} after agent reaction {} (poll fallback)",
            event_id.to_hex(),
            reaction.id.to_hex()
        );
        pending_routes.remove(&event_id);
    }
    Ok(())
}

fn reaction_target(event: &Event) -> Option<EventId> {
    (event.kind == Kind::Reaction)
        .then(|| unique_event_tag_value(event, "e"))
        .flatten()
        .and_then(|value| EventId::from_hex(value).ok())
}

fn route_acknowledged_by(reaction: &Event, target_id: EventId, route: PendingRoute) -> bool {
    reaction_target(reaction) == Some(target_id) && reaction.pubkey == route.agent
}

fn routed_message_agent(routed: &Event, bot: &PublicKey) -> Option<PublicKey> {
    (routed.kind == Kind::Custom(9) && routed.pubkey == *bot).then_some(())?;
    routed_source_event_id(routed, bot)?;
    unique_event_tag_value(routed, "p").and_then(|value| PublicKey::parse(value).ok())
}

fn routed_source_event_id(event: &Event, bot: &PublicKey) -> Option<EventId> {
    (event.pubkey == *bot
        && (event.kind == Kind::Custom(9)
            || event.kind == Kind::EventDeletion
            || event.kind == Kind::Custom(9005)))
    .then_some(())?;
    unique_event_tag_value(event, ROUTED_SOURCE_TAG).and_then(|value| EventId::from_hex(value).ok())
}

fn build_routed_message(
    channel_id: Uuid,
    root_event_id: EventId,
    candidate: &Event,
    agent_hex: &str,
    agent_label: &str,
) -> Result<EventBuilder> {
    let thread_ref = ThreadRef {
        root_event_id,
        parent_event_id: root_event_id,
    };
    let content = format!(
        "@{}\n\n{}",
        agent_label.trim().trim_start_matches('@'),
        candidate.content
    );
    Ok(buzz_sdk::build_message(
        channel_id,
        &content,
        Some(&thread_ref),
        &[agent_hex],
        false,
        &[],
    )?
    .tag(Tag::parse([
        ROUTED_SOURCE_TAG,
        candidate.id.to_hex().as_str(),
    ])?))
}

fn build_routed_deletion(
    channel_id: Uuid,
    routed_event_id: EventId,
    source_event_id: EventId,
) -> Result<EventBuilder> {
    Ok(
        buzz_sdk::build_delete_compat(channel_id, routed_event_id)?.tag(Tag::parse([
            ROUTED_SOURCE_TAG,
            source_event_id.to_hex().as_str(),
        ])?),
    )
}

async fn load_agent_label(config: &Config, agent: &PublicKey) -> Result<String> {
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        config.owner_auth_tag.as_ref(),
    )
    .await?;
    connection
        .send_raw(&json!([
            "REQ",
            PROFILE_SUBSCRIPTION_ID,
            Filter::new().kind(Kind::Custom(0)).author(*agent).limit(1)
        ]))
        .await?;
    let mut label = None;
    loop {
        match connection.next_event(THREAD_QUERY_TIMEOUT).await? {
            RelayMessage::Event {
                subscription_id,
                event,
            } if subscription_id == PROFILE_SUBSCRIPTION_ID => {
                event.verify().context("invalid agent profile signature")?;
                let profile: serde_json::Value = serde_json::from_str(&event.content)
                    .context("agent profile is not valid JSON")?;
                label = ["display_name", "name"].into_iter().find_map(|key| {
                    profile
                        .get(key)
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                });
            }
            RelayMessage::Eose { subscription_id }
                if subscription_id == PROFILE_SUBSCRIPTION_ID =>
            {
                break;
            }
            RelayMessage::Closed {
                subscription_id,
                message,
            } if subscription_id == PROFILE_SUBSCRIPTION_ID => {
                bail!("relay closed profile query: {message}");
            }
            _ => {}
        }
    }
    let _ = connection.disconnect().await;
    label.ok_or_else(|| anyhow!("agent has no display_name or name"))
}

async fn load_route_state(config: &Config, channel_ids: &[Uuid]) -> Result<RouteState> {
    let mut state = RouteState::default();
    for channel_id in channel_ids {
        let channel_state = load_channel_route_state(config, *channel_id).await?;
        state.pending.extend(channel_state.pending);
        state.handled_sources.extend(channel_state.handled_sources);
        state
            .judge_deliveries
            .extend(channel_state.judge_deliveries);
    }
    Ok(state)
}

async fn load_channel_route_state(config: &Config, channel_id: Uuid) -> Result<RouteState> {
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        config.owner_auth_tag.as_ref(),
    )
    .await?;
    let channel = channel_id.to_string();
    let since = Timestamp::from_secs(
        Timestamp::now()
            .as_secs()
            .saturating_sub(ROUTE_ACK_WINDOW_SECS),
    );
    connection
        .send_raw(&json!([
            "REQ",
            ROUTE_SUBSCRIPTION_ID,
            Filter::new()
                .kinds([
                    Kind::Custom(9),
                    Kind::Reaction,
                    Kind::EventDeletion,
                    Kind::Custom(9005),
                ])
                .author(config.bot_keys.public_key())
                .since(since)
                .custom_tags(SingleLetterTag::lowercase(Alphabet::H), [channel.as_str()])
                .limit(MAX_THREAD_EVENTS)
        ]))
        .await?;
    let mut state = RouteState::default();
    loop {
        match connection.next_event(THREAD_QUERY_TIMEOUT).await? {
            RelayMessage::Event {
                subscription_id,
                event,
            } if subscription_id == ROUTE_SUBSCRIPTION_ID => {
                event.verify().context("invalid routed message signature")?;
                if event_channel(&event) == Some(channel.as_str()) {
                    record_route_event(
                        &mut state,
                        channel_id,
                        &event,
                        &config.bot_keys.public_key(),
                    );
                }
            }
            RelayMessage::Eose { subscription_id } if subscription_id == ROUTE_SUBSCRIPTION_ID => {
                break;
            }
            RelayMessage::Closed {
                subscription_id,
                message,
            } if subscription_id == ROUTE_SUBSCRIPTION_ID => {
                bail!("relay closed routed message query: {message}");
            }
            _ => {}
        }
    }
    let _ = connection.disconnect().await;
    Ok(state)
}

fn record_route_event(state: &mut RouteState, channel_id: Uuid, event: &Event, bot: &PublicKey) {
    record_judge_event(&mut state.judge_deliveries, event, bot);
    let Some(source_event_id) = routed_source_event_id(event, bot) else {
        return;
    };
    state.handled_sources.insert(source_event_id);
    if let Some(agent) = routed_message_agent(event, bot) {
        state.pending.insert(
            event.id,
            PendingRoute {
                channel_id,
                agent,
                source_event_id,
                created_at: event.created_at.as_secs(),
            },
        );
    }
}

async fn load_reaction(
    config: &Config,
    target_id: EventId,
    route: PendingRoute,
) -> Result<Option<Event>> {
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        config.owner_auth_tag.as_ref(),
    )
    .await?;
    let target = target_id.to_hex();
    connection
        .send_raw(&json!([
            "REQ",
            REACTION_SUBSCRIPTION_ID,
            Filter::new()
                .kind(Kind::Reaction)
                .author(route.agent)
                .since(Timestamp::from_secs(route.created_at))
                .custom_tags(SingleLetterTag::lowercase(Alphabet::E), [target.as_str()])
                .limit(1)
        ]))
        .await?;
    let mut found = None;
    loop {
        match connection.next_event(THREAD_QUERY_TIMEOUT).await? {
            RelayMessage::Event {
                subscription_id,
                event,
            } if subscription_id == REACTION_SUBSCRIPTION_ID => {
                event.verify().context("invalid reaction signature")?;
                if route_acknowledged_by(&event, target_id, route) {
                    found = Some(*event);
                }
            }
            RelayMessage::Eose { subscription_id }
                if subscription_id == REACTION_SUBSCRIPTION_ID =>
            {
                break;
            }
            RelayMessage::Closed {
                subscription_id,
                message,
            } if subscription_id == REACTION_SUBSCRIPTION_ID => {
                bail!("relay closed reaction query: {message}");
            }
            _ => {}
        }
    }
    let _ = connection.disconnect().await;
    Ok(found)
}

async fn load_thread(config: &Config, channel_id: Uuid, root_id: EventId) -> Result<Vec<Event>> {
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        config.owner_auth_tag.as_ref(),
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
    owners: &[PublicKey],
    bot: &PublicKey,
) -> Option<PublicKey> {
    if !owners.contains(&candidate.pubkey) || parse_thread_relation(candidate).is_none() {
        return None;
    }

    let mut agents = HashSet::new();
    for event in thread {
        if event.kind != Kind::Custom(9) || owners.contains(&event.pubkey) || event.pubkey == *bot {
            continue;
        }
        if !owners.iter().any(|owner| is_same_owner_agent(event, owner)) {
            return None;
        }
        agents.insert(event.pubkey);
    }
    let agent = match agents.len() {
        0 => {
            let root_id = parse_thread_relation(candidate)?.root_event_id;
            let root = thread.iter().find(|event| {
                event.id == root_id
                    && event.kind == Kind::Custom(9)
                    && owners.contains(&event.pubkey)
            })?;
            let target = PublicKey::parse(unique_event_tag_value(root, "p")?).ok()?;
            if owners.contains(&target) || target == *bot {
                return None;
            }
            target
        }
        1 => agents.into_iter().next()?,
        _ => return None,
    };
    if event_has_mention(candidate) {
        return None;
    }
    if thread.iter().any(|event| {
        event.pubkey == *bot
            && event_mentions(event, &agent)
            && (event_tag_value(event, ROUTED_SOURCE_TAG) == Some(candidate.id.to_hex().as_str())
                || parse_thread_relation(event)
                    .is_some_and(|relation| relation.parent_event_id == candidate.id))
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

fn event_has_mention(event: &Event) -> bool {
    event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().map(String::as_str) == Some("p"))
}

fn event_channel(event: &Event) -> Option<&str> {
    event_tag_value(event, "h")
}

fn event_tag_value<'a>(event: &'a Event, name: &str) -> Option<&'a str> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.first().map(String::as_str) == Some(name))
            .then(|| parts.get(1).map(String::as_str))
            .flatten()
    })
}

fn unique_event_tag_value<'a>(event: &'a Event, name: &str) -> Option<&'a str> {
    let mut tags = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(name));
    let value = tags.next()?.as_slice().get(1).map(String::as_str);
    (tags.next().is_none()).then_some(value).flatten()
}

fn required_env(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    if value.trim().is_empty() {
        bail!("{name} must not be empty");
    }
    Ok(value)
}

fn env_bool(name: &str, default: bool) -> Result<bool> {
    let Ok(value) = std::env::var(name) else {
        return Ok(default);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("{name} must be true or false"),
    }
}

fn env_u64(name: &str, default: u64) -> Result<u64> {
    let value = match std::env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .with_context(|| format!("{name} must be an integer"))?,
        Err(std::env::VarError::NotPresent) => default,
        Err(error) => return Err(error).with_context(|| format!("{name} is invalid")),
    };
    if value == 0 {
        bail!("{name} must be greater than zero");
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

    fn reaction(keys: &Keys, target: EventId) -> Event {
        buzz_sdk::build_reaction(target, "👀")
            .unwrap()
            .sign_with_keys(keys)
            .unwrap()
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
                &[fixture.owner.public_key()],
                &fixture.bot.public_key(),
            ),
            Some(fixture.agent.public_key())
        );
    }

    #[test]
    fn routes_for_either_configured_owner() {
        let fixture = Fixture::new();
        let other_owner = Keys::generate();
        let candidate = message(
            &other_owner,
            None,
            fixture.channel,
            Some(&ThreadRef {
                root_event_id: fixture.root.id,
                parent_event_id: fixture.agent_reply.id,
            }),
            &[],
        );
        assert_eq!(
            route_target(
                &[fixture.root, fixture.agent_reply, candidate.clone()],
                &candidate,
                &[fixture.owner.public_key(), other_owner.public_key()],
                &fixture.bot.public_key(),
            ),
            Some(fixture.agent.public_key())
        );
    }

    #[test]
    fn routes_untagged_first_reply_from_root_mention() {
        let fixture = Fixture::new();
        let agent_hex = fixture.agent.public_key().to_hex();
        let root = message(&fixture.owner, None, fixture.channel, None, &[&agent_hex]);
        let candidate = message(
            &fixture.owner,
            None,
            fixture.channel,
            Some(&ThreadRef {
                root_event_id: root.id,
                parent_event_id: root.id,
            }),
            &[],
        );

        assert_eq!(
            route_target(
                &[root, candidate.clone()],
                &candidate,
                &[fixture.owner.public_key()],
                &fixture.bot.public_key(),
            ),
            Some(fixture.agent.public_key())
        );
    }

    #[test]
    fn skips_untagged_first_reply_without_unique_root_mention() {
        let fixture = Fixture::new();
        let other = Keys::generate().public_key().to_hex();
        let agent_hex = fixture.agent.public_key().to_hex();
        let root = message(
            &fixture.owner,
            None,
            fixture.channel,
            None,
            &[&agent_hex, &other],
        );
        let candidate = message(
            &fixture.owner,
            None,
            fixture.channel,
            Some(&ThreadRef {
                root_event_id: root.id,
                parent_event_id: root.id,
            }),
            &[],
        );

        assert!(route_target(
            &[root, candidate.clone()],
            &candidate,
            &[fixture.owner.public_key()],
            &fixture.bot.public_key(),
        )
        .is_none());
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
    fn standalone_signing_keeps_message_tags_without_auth() {
        let fixture = Fixture::new();
        let config = Config {
            relay_url: DEFAULT_RELAY_URL.to_string(),
            channel_ids: Vec::new(),
            bot_keys: fixture.bot,
            owner_auth_tag: None,
            owner_pubkeys: vec![fixture.owner.public_key()],
            picture_url: None,
            judge: None,
        };
        let event = config
            .sign(
                buzz_sdk::build_message(fixture.channel, "message", None, &[], false, &[]).unwrap(),
            )
            .unwrap();
        assert_eq!(
            event_channel(&event),
            Some(fixture.channel.to_string()).as_deref()
        );
        assert!(!event
            .tags
            .iter()
            .any(|tag| tag.as_slice().first().map(String::as_str) == Some("auth")));
    }

    #[test]
    fn skips_when_owner_already_tagged_agent() {
        let fixture = Fixture::new();
        let agent_hex = fixture.agent.public_key().to_hex();
        let candidate = fixture.candidate(&[&agent_hex]);
        assert!(route_target(
            &fixture.base_thread(&candidate),
            &candidate,
            &[fixture.owner.public_key()],
            &fixture.bot.public_key(),
        )
        .is_none());
    }

    #[test]
    fn skips_when_owner_tags_a_different_recipient() {
        let fixture = Fixture::new();
        let other = Keys::generate().public_key().to_hex();
        let candidate = fixture.candidate(&[&other]);
        assert!(route_target(
            &fixture.base_thread(&candidate),
            &candidate,
            &[fixture.owner.public_key()],
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
            &[fixture.owner.public_key()],
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
            &[fixture.owner.public_key()],
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
            &[fixture.owner.public_key()],
            &fixture.bot.public_key(),
        )
        .is_none());
    }

    #[test]
    fn routed_message_forwards_source_content_with_label_and_marker() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate(&[]);
        let agent_hex = fixture.agent.public_key().to_hex();
        let routed = build_routed_message(
            fixture.channel,
            fixture.root.id,
            &candidate,
            &agent_hex,
            "slopd-codex",
        )
        .unwrap()
        .sign_with_keys(&fixture.bot)
        .unwrap();
        let relation = parse_thread_relation(&routed).unwrap();
        assert_eq!(relation.root_event_id, fixture.root.id);
        assert_eq!(relation.parent_event_id, fixture.root.id);
        assert_eq!(routed.content, "@slopd-codex\n\nmessage");
        assert_eq!(
            event_tag_value(&routed, ROUTED_SOURCE_TAG),
            Some(candidate.id.to_hex().as_str())
        );
        assert!(event_mentions(&routed, &fixture.agent.public_key()));

        let mut thread = fixture.base_thread(&candidate);
        thread.push(routed);
        assert!(route_target(
            &thread,
            &candidate,
            &[fixture.owner.public_key()],
            &fixture.bot.public_key(),
        )
        .is_none());
    }

    #[test]
    fn deleted_route_keeps_its_source_handled_after_reconnect() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate(&[]);
        let routed = build_routed_message(
            fixture.channel,
            fixture.root.id,
            &candidate,
            &fixture.agent.public_key().to_hex(),
            "agent",
        )
        .unwrap()
        .sign_with_keys(&fixture.bot)
        .unwrap();
        let deletion = build_routed_deletion(fixture.channel, routed.id, candidate.id)
            .unwrap()
            .sign_with_keys(&fixture.bot)
            .unwrap();

        assert_eq!(deletion.kind, Kind::EventDeletion);
        assert_eq!(
            routed_source_event_id(&deletion, &fixture.bot.public_key()),
            Some(candidate.id)
        );

        let mut rebuilt = RouteState::default();
        record_route_event(
            &mut rebuilt,
            fixture.channel,
            &deletion,
            &fixture.bot.public_key(),
        );
        assert!(rebuilt.handled_sources.contains(&candidate.id));
        assert!(rebuilt.pending.is_empty());
    }

    #[test]
    fn target_agent_reaction_acknowledges_routed_message() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate(&[]);
        let routed = build_routed_message(
            fixture.channel,
            fixture.root.id,
            &candidate,
            &fixture.agent.public_key().to_hex(),
            "agent",
        )
        .unwrap()
        .sign_with_keys(&fixture.bot)
        .unwrap();
        let ack = reaction(&fixture.agent, routed.id);
        let route = PendingRoute {
            channel_id: fixture.channel,
            agent: fixture.agent.public_key(),
            source_event_id: candidate.id,
            created_at: routed.created_at.as_secs(),
        };

        assert_eq!(reaction_target(&ack), Some(routed.id));
        assert!(route_acknowledged_by(&ack, routed.id, route));
    }

    #[test]
    fn unrelated_reaction_does_not_acknowledge_routed_message() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate(&[]);
        let routed = build_routed_message(
            fixture.channel,
            fixture.root.id,
            &candidate,
            &fixture.agent.public_key().to_hex(),
            "agent",
        )
        .unwrap()
        .sign_with_keys(&fixture.bot)
        .unwrap();
        let route = PendingRoute {
            channel_id: fixture.channel,
            agent: fixture.agent.public_key(),
            source_event_id: candidate.id,
            created_at: routed.created_at.as_secs(),
        };

        assert!(!route_acknowledged_by(
            &reaction(&fixture.owner, routed.id),
            routed.id,
            route
        ));
        assert!(!route_acknowledged_by(
            &reaction(&fixture.agent, candidate.id),
            routed.id,
            route
        ));
    }

    #[test]
    fn reaction_with_ambiguous_targets_is_ignored() {
        let fixture = Fixture::new();
        let event = EventBuilder::new(Kind::Reaction, "👀")
            .tags([
                Tag::event(fixture.root.id),
                Tag::event(fixture.agent_reply.id),
            ])
            .sign_with_keys(&fixture.agent)
            .unwrap();

        assert_eq!(reaction_target(&event), None);
    }

    #[test]
    fn skips_top_level_owner_message() {
        let fixture = Fixture::new();
        let candidate = message(&fixture.owner, None, fixture.channel, None, &[]);
        assert!(route_target(
            &[candidate.clone(), fixture.agent_reply],
            &candidate,
            &[fixture.owner.public_key()],
            &fixture.bot.public_key(),
        )
        .is_none());
    }

    #[test]
    fn judge_verdict_parser_accepts_consistent_pass_and_fail_results() {
        assert_eq!(
            parse_judge_verdict(r#"{"pass":true,"failures":[]}"#).unwrap(),
            JudgeVerdict {
                pass: true,
                failures: vec![],
            }
        );
        assert_eq!(
            parse_judge_verdict(
                r#"{"pass":false,"failures":[{"rule":"complete_message","issue":"ends after a colon"}]}"#,
            )
            .unwrap(),
            JudgeVerdict {
                pass: false,
                failures: vec![JudgeFailure {
                    rule: COMPLETE_MESSAGE_RULE.to_string(),
                    issue: "ends after a colon".to_string(),
                }],
            }
        );
    }

    #[test]
    fn judge_verdict_parser_rejects_prose_and_inconsistent_results() {
        assert!(parse_judge_verdict("Looks good").is_err());
        assert!(parse_judge_verdict(
            r#"{"pass":true,"failures":[{"rule":"complete_message","issue":"cut off"}]}"#,
        )
        .is_err());
        assert!(parse_judge_verdict(r#"{"pass":false,"failures":[]}"#).is_err());
    }

    #[test]
    fn fail_delivery_is_complete_only_after_reaction_and_critique() {
        let fixture = Fixture::new();
        let verdict = JudgeVerdict {
            pass: false,
            failures: vec![JudgeFailure {
                rule: COMPLETE_MESSAGE_RULE.to_string(),
                issue: "ends abruptly".to_string(),
            }],
        };
        let reaction = build_judge_reaction(fixture.channel, &fixture.agent_reply, &verdict)
            .unwrap()
            .sign_with_keys(&fixture.bot)
            .unwrap();
        let critique = build_judge_critique(
            fixture.channel,
            &fixture.agent_reply,
            &verdict,
            &fixture.agent.public_key().to_hex(),
            "slopd-codex",
        )
        .unwrap()
        .sign_with_keys(&fixture.bot)
        .unwrap();
        let mut deliveries = HashMap::new();

        assert_eq!(reaction.kind, Kind::Reaction);
        assert_eq!(
            unique_event_tag_value(&reaction, JUDGED_SOURCE_TAG),
            Some(fixture.agent_reply.id.to_hex().as_str())
        );
        assert!(unique_event_tag_value(&reaction, JUDGE_RESULT_TAG)
            .and_then(|value| parse_judge_verdict(value).ok())
            .is_some());
        record_judge_event(&mut deliveries, &reaction, &fixture.bot.public_key());
        assert!(!deliveries[&fixture.agent_reply.id].complete());
        record_judge_event(&mut deliveries, &critique, &fixture.bot.public_key());
        assert!(deliveries[&fixture.agent_reply.id].complete());
        assert_eq!(reaction.content, "👎");
        assert!(event_mentions(&critique, &fixture.agent.public_key()));
        let relation = parse_thread_relation(&critique).unwrap();
        assert_eq!(relation.parent_event_id, fixture.agent_reply.id);
    }

    #[test]
    fn pass_delivery_needs_only_the_thumbs_up_reaction() {
        let fixture = Fixture::new();
        let verdict = JudgeVerdict {
            pass: true,
            failures: vec![],
        };
        let reaction = build_judge_reaction(fixture.channel, &fixture.agent_reply, &verdict)
            .unwrap()
            .sign_with_keys(&fixture.bot)
            .unwrap();
        let mut deliveries = HashMap::new();

        assert_eq!(reaction.kind, Kind::Reaction);
        assert_eq!(reaction.pubkey, fixture.bot.public_key());
        assert_eq!(
            unique_event_tag_value(&reaction, JUDGED_SOURCE_TAG)
                .and_then(|value| EventId::from_hex(value).ok()),
            Some(fixture.agent_reply.id)
        );
        assert!(unique_event_tag_value(&reaction, JUDGE_RESULT_TAG)
            .and_then(|value| parse_judge_verdict(value).ok())
            .is_some());
        record_judge_event(&mut deliveries, &reaction, &fixture.bot.public_key());
        assert!(deliveries[&fixture.agent_reply.id].complete());
        assert_eq!(reaction.content, "👍");
    }
}
