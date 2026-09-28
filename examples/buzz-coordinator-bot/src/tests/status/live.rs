//! Opt-in real relay regression for lifecycle ordering and reconnect recovery.
use super::*;
use buzz_core::agent_thread_lifecycle::{build_agent_thread_lifecycle, AgentThreadLifecycle};
use std::process::Command;

fn cli(args: &[&str]) -> serde_json::Value {
    let output = Command::new("buzz-machine").args(args).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

struct Channel(String);
impl Drop for Channel {
    fn drop(&mut self) {
        cli(&["channels", "delete", "--channel", &self.0]);
        assert!(!cli(&["channels", "list"]).to_string().contains(&self.0));
        eprintln!(
            "deleted temporary status channel {} and verified absence",
            self.0
        );
    }
}

struct Listener(tokio::task::JoinHandle<Result<()>>);
impl Drop for Listener {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn listen(config: &Config) -> Listener {
    let config = config.clone();
    Listener(tokio::spawn(async move {
        listen_once(
            &config,
            None,
            Arc::new(Mutex::new(JudgeTracker::default())),
            None,
            Arc::new(Mutex::new(EmojiTracker::default())),
        )
        .await
    }))
}

async fn await_status(config: &Config, key: ThreadKey, expected: AgentThreadState) {
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let recovered = load_route_state(config, &[key.channel_id]).await.unwrap();
            if recovered
                .status
                .get(&key)
                .is_some_and(|p| p.state == expected)
            {
                assert!(
                    recovered.agent_turns.contains_key(&key),
                    "channel recovery dropped ordering evidence"
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    })
    .await
    .expect("relay status did not converge");
    eprintln!("relay status: {}", expected.as_str());
}

fn lifecycle(
    agent: &Keys,
    auth: &Tag,
    key: ThreadKey,
    state: AgentThreadState,
    turn: &str,
    revision: u64,
    expiry: Option<u64>,
) -> Event {
    build_agent_thread_lifecycle(
        key.channel_id,
        key.root_event_id,
        &AgentThreadLifecycle {
            version: 1,
            turn_id: turn.into(),
            state,
            phase: if state == AgentThreadState::Agent {
                "working"
            } else {
                "completed"
            }
            .into(),
            revision,
            expires_at: expiry,
        },
    )
    .unwrap()
    .tag(auth.clone())
    .sign_with_keys(agent)
    .unwrap()
}

#[tokio::test]
#[ignore = "requires live coordinator env and machine PEM; creates and deletes a private buzz-machine channel"]
async fn live_relay_status_recovers_from_replay_expiry_and_reconnect() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let identity = std::env::var("BUZZ_TEST_MACHINE_IDENTITY").unwrap();
    let output = Command::new("openssl")
        .args(["pkey", "-in", &identity, "-text", "-noout"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    let private = text
        .split("priv:")
        .nth(1)
        .unwrap()
        .split("pub:")
        .next()
        .unwrap()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .collect::<String>();
    let owner = Keys::parse(&private).unwrap();
    let agent = Keys::generate();
    let mut config = Config::from_env().unwrap();
    config.bot_keys = Keys::generate();
    config.owner_pubkeys = vec![owner.public_key()];
    config.owner_auth_tag = Some(auth_tag(&owner, &config.bot_keys));
    config.default_agent = None;
    config.channel_default_agents.clear();
    config.judge = None;
    config.emoji_reactor = false;
    let created = cli(&[
        "channels",
        "create",
        "--name",
        &format!("status-regression-{}", Uuid::new_v4()),
        "--type",
        "stream",
        "--visibility",
        "private",
    ]);
    let channel = Channel(created["channel_id"].as_str().unwrap().into());
    let channel_id = Uuid::parse_str(&channel.0).unwrap();
    config.channel_ids = vec![channel_id];
    for member in [agent.public_key(), config.bot_keys.public_key()] {
        cli(&[
            "channels",
            "add-member",
            "--channel",
            &channel.0,
            "--pubkey",
            &member.to_hex(),
            "--role",
            "bot",
        ]);
    }
    let root = cli(&[
        "messages",
        "send",
        "--channel",
        &channel.0,
        "--content",
        "Status ordering regression",
        "--mention",
        &agent.public_key().to_hex(),
    ]);
    let key = ThreadKey {
        channel_id,
        root_event_id: EventId::from_hex(root["event_id"].as_str().unwrap()).unwrap(),
    };
    let auth = auth_tag(&owner, &agent);
    let mut agent_ws =
        NostrWsConnection::connect_authenticated(&config.relay_url, &agent, Some(&auth))
            .await
            .unwrap();
    let reply = buzz_sdk::build_message(
        channel_id,
        "@owner Previous turn finished",
        Some(&ThreadRef {
            root_event_id: key.root_event_id,
            parent_event_id: key.root_event_id,
        }),
        &[&owner.public_key().to_hex()],
        false,
        &[],
        &[],
    )
    .unwrap()
    .tag(auth.clone())
    .custom_created_at(Timestamp::from_secs(unix_seconds() - 60))
    .sign_with_keys(&agent)
    .unwrap();
    publish_required(&mut agent_ws, reply, "old handoff")
        .await
        .unwrap();

    let listener = listen(&config);
    await_status(&config, key, AgentThreadState::Human).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    // Small revisions reproduce a long-running publisher's counter versus the
    // coordinator's much larger wall-clock timestamp at replay/expiry time.
    publish_required(
        &mut agent_ws,
        lifecycle(
            &agent,
            &auth,
            key,
            AgentThreadState::Agent,
            "first",
            1,
            Some(unix_seconds() + 45),
        ),
        "working after old reply",
    )
    .await
    .unwrap();
    await_status(&config, key, AgentThreadState::Agent).await;
    drop(listener);
    let listener = listen(&config);
    tokio::time::sleep(Duration::from_secs(3)).await;
    await_status(&config, key, AgentThreadState::Agent).await;
    // Expiry is a recoverable projection, not a publisher terminal event.
    publish_required(
        &mut agent_ws,
        lifecycle(
            &agent,
            &auth,
            key,
            AgentThreadState::Agent,
            "first",
            2,
            Some(unix_seconds() + 2),
        ),
        "short working lease",
    )
    .await
    .unwrap();
    await_status(&config, key, AgentThreadState::Failed).await;
    publish_required(
        &mut agent_ws,
        lifecycle(
            &agent,
            &auth,
            key,
            AgentThreadState::Agent,
            "first",
            3,
            Some(unix_seconds() + 45),
        ),
        "refresh after expiry",
    )
    .await
    .unwrap();
    await_status(&config, key, AgentThreadState::Agent).await;
    publish_required(
        &mut agent_ws,
        lifecycle(
            &agent,
            &auth,
            key,
            AgentThreadState::Human,
            "first",
            4,
            None,
        ),
        "real completion",
    )
    .await
    .unwrap();
    await_status(&config, key, AgentThreadState::Human).await;
    drop(listener);
    let listener = listen(&config);
    tokio::time::sleep(Duration::from_secs(3)).await;
    publish_required(
        &mut agent_ws,
        lifecycle(
            &agent,
            &auth,
            key,
            AgentThreadState::Agent,
            "first",
            5,
            Some(unix_seconds() + 45),
        ),
        "late same-turn refresh",
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    await_status(&config, key, AgentThreadState::Human).await;
    publish_required(
        &mut agent_ws,
        lifecycle(
            &agent,
            &auth,
            key,
            AgentThreadState::Agent,
            "next",
            6,
            Some(unix_seconds() + 45),
        ),
        "new turn",
    )
    .await
    .unwrap();
    await_status(&config, key, AgentThreadState::Agent).await;
    publish_required(
        &mut agent_ws,
        lifecycle(&agent, &auth, key, AgentThreadState::Human, "next", 7, None),
        "next completion",
    )
    .await
    .unwrap();
    await_status(&config, key, AgentThreadState::Human).await;
    drop(listener);
    let _ = agent_ws.disconnect().await;
}
