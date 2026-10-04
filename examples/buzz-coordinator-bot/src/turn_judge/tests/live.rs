//! Opt-in live relay test. All data lives in a temporary private buzz-machine
//! channel, which is deleted even when an assertion fails.
use super::*;
use std::process::Command;

fn cli(args: &[&str]) -> serde_json::Value {
    let output = Command::new("buzz-machine").args(args).output().unwrap();
    assert!(
        output.status.success(),
        "buzz-machine: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

struct Channel(String);

#[tokio::test]
#[ignore = "read-only inspection of BUZZ_TEST_CHANNEL/ROOT/SELECTED/OLD with coordinator env"]
async fn live_existing_thread_routes_to_explicit_selection() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let config = Config::from_env().unwrap();
    let key = ThreadKey {
        channel_id: Uuid::parse_str(&std::env::var("BUZZ_TEST_CHANNEL").unwrap()).unwrap(),
        root_event_id: EventId::from_hex(&std::env::var("BUZZ_TEST_ROOT").unwrap()).unwrap(),
    };
    let selected = PublicKey::parse(&std::env::var("BUZZ_TEST_SELECTED").unwrap()).unwrap();
    let old = PublicKey::parse(&std::env::var("BUZZ_TEST_OLD").unwrap()).unwrap();
    let events = load_thread(&config, key.channel_id, key.root_event_id)
        .await
        .unwrap();
    assert_eq!(
        selection::latest(
            &events,
            &config.owner_pubkeys,
            &config.bot_keys.public_key()
        ),
        Some(selected)
    );
    assert!(selection::current(&config, key, selected).await.unwrap());
    assert!(!selection::current(&config, key, old).await.unwrap());
    let members = load_channel_members(&config, key.channel_id).await.unwrap();
    assert!(members.contains(&selected));
    // Synthetic untagged follow-up, never signed or sent. Existing routed
    // messages must not make the route guard suppress this fresh probe.
    let mut followup = events
        .iter()
        .find(|e| {
            config.owner_pubkeys.contains(&e.pubkey)
                && parse_thread_relation(e).is_some()
                && !event_has_mention(e)
        })
        .unwrap()
        .clone();
    followup.id = EventId::from_byte_array([123; 32]);
    assert_eq!(
        route_target_with_assignment(
            &events,
            &followup,
            &config.owner_pubkeys,
            &config.bot_keys.public_key(),
            Some(old)
        ),
        Some(selected)
    );
    eprintln!("existing thread selects {selected}; stale agent {old} cannot route or retry");
}

#[tokio::test]
#[ignore = "requires live coordinator env and buzz-machine; creates/deletes a private channel, no model calls"]
async fn live_passed_turn_receipts_survive_other_agents_and_restart() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut f = Fixture::new();
    let mut config = Config::from_env().unwrap();
    let output = Command::new("openssl")
        .args([
            "pkey",
            "-in",
            &std::env::var("BUZZ_TEST_MACHINE_IDENTITY").unwrap(),
            "-text",
            "-noout",
        ])
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
    f.owner = Keys::parse(&private).unwrap();
    config.owner_pubkeys = vec![f.owner.public_key()];
    config.bot_keys = Keys::generate();
    config.owner_auth_tag = Some(
        buzz_sdk::nip_oa::parse_auth_tag(
            &buzz_sdk::nip_oa::compute_auth_tag(&f.owner, &config.bot_keys.public_key(), "")
                .unwrap(),
        )
        .unwrap(),
    );
    let created = cli(&[
        "channels",
        "create",
        "--name",
        &format!("judge-pass-test-{}", Uuid::new_v4()),
        "--type",
        "stream",
        "--visibility",
        "private",
    ]);
    let channel = Channel(created["channel_id"].as_str().unwrap().to_string());
    f.channel = Uuid::parse_str(&channel.0).unwrap();
    config.channel_ids = vec![f.channel];
    cli(&[
        "channels",
        "add-member",
        "--channel",
        &channel.0,
        "--pubkey",
        &config.bot_keys.public_key().to_hex(),
        "--role",
        "bot",
    ]);
    let sent = cli(&[
        "messages",
        "send",
        "--channel",
        &channel.0,
        "--content",
        "Receipt regression test only.",
    ]);
    f.root = load_judge_target(
        &config,
        f.channel,
        EventId::from_hex(sent["event_id"].as_str().unwrap()).unwrap(),
    )
    .await
    .unwrap();
    f.config = config.clone();
    let tracker = Arc::new(Mutex::new(JudgeTracker::default()));
    let mut events = Vec::new();
    let mut session = None;
    for revision in 1..=5 {
        f.agent = Keys::generate();
        let event = f.lifecycle(AgentThreadState::Human, "completed", revision);
        {
            let mut state = tracker.lock().await;
            state
                .turns
                .insert(coordinates(&event).unwrap(), event.clone());
            state.deliveries.insert(
                event.id,
                JudgeDelivery {
                    verdict: Some(JudgeVerdict {
                        pass: true,
                        failures: vec![],
                    }),
                    ..JudgeDelivery::default()
                },
            );
        }
        process(
            &config,
            config.judge.as_ref().unwrap(),
            &tracker,
            &mut session,
            &event,
        )
        .await
        .unwrap();
        events.push(event);
    }
    assert!(
        session.is_none(),
        "precomputed verdicts must not call a model"
    );
    // Real relay reads into a completely fresh tracker: no in-memory escape hatch.
    let key = coordinates(&events[0]).unwrap().0;
    let receipts = context::receipts(&config, key).await.unwrap();
    let restarted = Arc::new(Mutex::new(JudgeTracker::default()));
    recover_judge_deliveries(
        &mut restarted.lock().await.deliveries,
        &receipts,
        &config.bot_keys.public_key(),
    );
    for event in &events {
        assert!(restarted
            .lock()
            .await
            .deliveries
            .get(&event.id)
            .is_some_and(JudgeDelivery::complete));
        restarted
            .lock()
            .await
            .turns
            .insert(coordinates(event).unwrap(), event.clone());
        process(
            &config,
            config.judge.as_ref().unwrap(),
            &restarted,
            &mut session,
            event,
        )
        .await
        .unwrap();
    }
    assert!(session.is_none(), "restart must not rejudge passed turns");
    assert_eq!(context::receipts(&config, key).await.unwrap().len(), 5);

    // A switch arriving while an old-agent judgment is pending must fence both
    // message corrections and completion recovery, even with a fresh tracker.
    let selected = Keys::generate().public_key();
    cli(&[
        "channels",
        "add-member",
        "--channel",
        &channel.0,
        "--pubkey",
        &selected.to_hex(),
        "--role",
        "bot",
    ]);
    cli(&[
        "messages",
        "send",
        "--channel",
        &channel.0,
        "--reply-to",
        &f.root.id.to_hex(),
        "--mention",
        &selected.to_hex(),
        "--content",
        "Selected agent, please take over.",
    ]);
    let old_reply = f.message(&f.agent, "timed out; please resend", unix_seconds());
    let job = JudgeJob {
        event: old_reply.clone(),
        target: old_reply,
        channel_id: f.channel,
    };
    let fresh = Arc::new(Mutex::new(JudgeTracker::default()));
    assert!(process_judge_job(
        &config,
        config.judge.as_ref().unwrap(),
        &fresh,
        &mut session,
        &job
    )
    .await
    .unwrap()
    .is_none());
    apply_judge_verdict(
        &config,
        &fresh,
        &job,
        &JudgeVerdict {
            pass: false,
            failures: vec![JudgeFailure {
                rule: "avoidable_handoff".into(),
                issue: "retry".into(),
            }],
        },
    )
    .await
    .unwrap();
    let late = f.lifecycle(AgentThreadState::Human, "completed", 99);
    fresh
        .lock()
        .await
        .turns
        .insert(coordinates(&late).unwrap(), late.clone());
    process(
        &config,
        config.judge.as_ref().unwrap(),
        &fresh,
        &mut session,
        &late,
    )
    .await
    .unwrap();
    assert!(
        session.is_none(),
        "old worker must not call a model after selection changed"
    );
    assert!(
        fresh.lock().await.deliveries.is_empty(),
        "old worker must not publish a judgment"
    );
    let thread = load_thread(&config, f.channel, f.root.id).await.unwrap();
    let followup = f.message(&f.owner, "coverage?", unix_seconds());
    assert_eq!(
        route_target_with_assignment(
            &thread,
            &followup,
            &config.owner_pubkeys,
            &config.bot_keys.public_key(),
            Some(f.agent.public_key())
        ),
        Some(selected)
    );
    assert_eq!(
        thread.len(),
        2,
        "no corrective mentions should have been published"
    );
    eprintln!(
        "explicit handoff survives fresh tracker; stale message and completion checks suppressed"
    );
}

impl Drop for Channel {
    fn drop(&mut self) {
        let result = Command::new("buzz-machine")
            .args(["channels", "delete", "--channel", &self.0])
            .output()
            .unwrap();
        assert!(result.status.success(), "test channel cleanup failed");
        let channels = cli(&["channels", "list"]);
        assert!(
            !channels.to_string().contains(&self.0),
            "deleted test channel is still visible"
        );
        eprintln!("deleted test channel {} and verified absence", self.0);
    }
}

async fn await_delivery(tracker: &Arc<Mutex<JudgeTracker>>, id: EventId) -> JudgeDelivery {
    tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            if let Some(delivery) = tracker
                .lock()
                .await
                .deliveries
                .get(&id)
                .filter(|d| d.complete())
                .cloned()
            {
                return delivery;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("live completion verdict timed out")
}

#[tokio::test]
#[ignore = "requires live coordinator env, buzz-machine and judge ACP; creates/deletes a private test channel"]
async fn live_relay_completion_retries_stop_at_three_after_tracker_restart() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut f = Fixture::new();
    let mut config = Config::from_env().unwrap();
    let identity = std::env::var("BUZZ_TEST_MACHINE_IDENTITY").expect("machine PEM path required");
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
    f.owner = Keys::parse(&private).unwrap();
    config.owner_pubkeys = vec![f.owner.public_key()];
    // Use a fresh bot identity, so the installed coordinator cannot consume or
    // alter this test's verdicts and retry receipts.
    config.bot_keys = Keys::generate();
    config.owner_auth_tag = Some(
        buzz_sdk::nip_oa::parse_auth_tag(
            &buzz_sdk::nip_oa::compute_auth_tag(&f.owner, &config.bot_keys.public_key(), "")
                .unwrap(),
        )
        .unwrap(),
    );
    config.emoji_reactor = false;
    config.default_agent = Some(f.agent.public_key());
    config.channel_default_agents.clear();
    let created = cli(&[
        "channels",
        "create",
        "--name",
        &format!("judge-turn-test-{}", Uuid::new_v4()),
        "--type",
        "stream",
        "--visibility",
        "private",
    ]);
    let channel = Channel(
        created["channel_id"]
            .as_str()
            .expect("created channel id")
            .to_string(),
    );
    f.channel = Uuid::parse_str(&channel.0).unwrap();
    config.channel_ids = vec![f.channel];
    for key in [config.bot_keys.public_key(), f.agent.public_key()] {
        cli(&[
            "channels",
            "add-member",
            "--channel",
            &channel.0,
            "--pubkey",
            &key.to_hex(),
            "--role",
            "bot",
        ]);
    }
    let sent = cli(&[
        "messages",
        "send",
        "--channel",
        &channel.0,
        "--content",
        "Find more compatible TV mounts in Tbilisi.",
    ]);
    let root_id = EventId::from_hex(sent["event_id"].as_str().unwrap()).unwrap();
    f.root = load_judge_target(&config, f.channel, root_id)
        .await
        .unwrap();
    cli(&[
        "messages",
        "send",
        "--channel",
        &channel.0,
        "--reply-to",
        &root_id.to_hex(),
        "--content",
        "What are the wall plate dimensions for the 1011?",
    ]);
    f.config = config.clone();
    let auth = buzz_sdk::nip_oa::parse_auth_tag(
        &buzz_sdk::nip_oa::compute_auth_tag(&f.owner, &f.agent.public_key(), "").unwrap(),
    )
    .unwrap();
    let mut agent_connection =
        NostrWsConnection::connect_authenticated(&config.relay_url, &f.agent, Some(&auth))
            .await
            .unwrap();
    let reply = buzz_sdk::build_message(
        f.channel,
        "The 1011 wall plate is 400 by 200 mm with 300 by 100 mm anchor spacing.",
        Some(&ThreadRef {
            root_event_id: root_id,
            parent_event_id: root_id,
        }),
        &[],
        false,
        &[],
        &[],
    )
    .unwrap()
    .tag(auth.clone())
    .sign_with_keys(&f.agent)
    .unwrap();
    publish_required(&mut agent_connection, reply, "test reply")
        .await
        .unwrap();

    // Persist a working lease, then lose every in-memory coordinator record.
    // The ephemeral lifecycle event itself is never sent to the new listener.
    let interrupted = f.lifecycle(AgentThreadState::Agent, "working", unix_revision());
    let mut prior = RouteState::default();
    let mut prior_connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        config.owner_auth_tag.as_ref(),
    )
    .await
    .unwrap();
    handle_thread_lifecycle(&config, &mut prior_connection, &interrupted, &mut prior)
        .await
        .unwrap();
    prior_connection.disconnect().await.unwrap();
    drop(prior);

    let tracker = Arc::new(Mutex::new(JudgeTracker::default()));
    let (tx, rx) = mpsc::channel(16);
    let worker = tokio::spawn(run_judge_worker(config.clone(), tracker.clone(), rx));
    let listen_config = config.clone();
    let listen_tracker = tracker.clone();
    let listener = tokio::spawn(async move {
        listen_once(
            &listen_config,
            Some(&tx),
            listen_tracker,
            None,
            Arc::new(Mutex::new(EmojiTracker::default())),
        )
        .await
    });
    let recovered = await_delivery(&tracker, interrupted.id).await;
    assert!(!recovered.verdict.unwrap().pass);
    assert!(recovered.critique_event_id.is_some());
    eprintln!(
        "fresh coordinator recovered an expired durable turn after grace; one corrective mention"
    );
    // The agent socket was idle throughout the restart grace period.
    let _ = agent_connection.disconnect().await;
    agent_connection =
        NostrWsConnection::connect_authenticated(&config.relay_url, &f.agent, Some(&auth))
            .await
            .unwrap();
    let mut last = None;
    for index in 2..=4 {
        let event = f.lifecycle(
            AgentThreadState::Human,
            "completed",
            unix_revision() + index,
        );
        publish_required(&mut agent_connection, event.clone(), "test completion")
            .await
            .unwrap();
        let delivery = await_delivery(&tracker, event.id).await;
        assert!(!delivery.verdict.as_ref().unwrap().pass);
        if index <= 3 {
            assert!(
                delivery.critique_event_id.is_some(),
                "retry {index} missing"
            );
        } else {
            assert!(delivery.retry_exhausted);
            assert!(
                delivery.critique_event_id.is_none(),
                "fourth retry must not be sent"
            );
        }
        eprintln!(
            "completion {index}: corrective mention={}, exhausted={}",
            delivery.critique_event_id.is_some(),
            delivery.retry_exhausted
        );
        // Simulate losing every in-memory counter after the third correction.
        if index == 3 {
            let recovered = load_route_state(&config, &[f.channel]).await.unwrap();
            *tracker.lock().await = JudgeTracker {
                deliveries: recovered.judge_deliveries,
                ..JudgeTracker::default()
            };
        }
        last = Some(event);
    }
    let events = load_thread(&config, f.channel, root_id).await.unwrap();
    let corrections = events
        .iter()
        .filter(|e| {
            e.pubkey == config.bot_keys.public_key()
                && unique_event_tag_value(e, RETRY_NUMBER_TAG).is_some()
        })
        .count();
    assert_eq!(corrections, 3);
    let notices = events
        .iter()
        .filter(|e| unique_event_tag_value(e, "judge-cap-user").is_some())
        .collect::<Vec<_>>();
    assert_eq!(notices.len(), 1, "exhaustion must be visible exactly once");
    assert!(
        !event_has_mention(notices[0]),
        "cap notice must not start another turn"
    );
    assert!(retry_budget(&config, &events).unwrap().exhausted());
    // The regular message judge must respect the same exhausted budget.
    let job = JudgeJob {
        event: last.unwrap(),
        target: f.root.clone(),
        channel_id: f.channel,
    };
    apply_judge_verdict(
        &config,
        &tracker,
        &job,
        &JudgeVerdict {
            pass: false,
            failures: vec![JudgeFailure {
                rule: COMPLETE_MESSAGE_RULE.into(),
                issue: "Test failure".into(),
            }],
        },
    )
    .await
    .unwrap();
    assert_eq!(
        load_thread(&config, f.channel, root_id)
            .await
            .unwrap()
            .iter()
            .filter(|e| unique_event_tag_value(e, RETRY_NUMBER_TAG).is_some())
            .count(),
        3
    );
    cli(&[
        "messages",
        "edit",
        "--event",
        &root_id.to_hex(),
        "--content",
        "Only tell me the 1011 wall plate dimensions. Do not find more mounts.",
    ]);
    let resolved = f.lifecycle(AgentThreadState::Human, "completed", unix_revision());
    publish_required(
        &mut agent_connection,
        resolved.clone(),
        "test edited resolution",
    )
    .await
    .unwrap();
    let delivery = await_delivery(&tracker, resolved.id).await;
    assert!(
        delivery.verdict.unwrap().pass,
        "edited request should now be resolved"
    );
    assert!(delivery.critique_event_id.is_none());
    eprintln!("edited supersession: pass, no corrective mention");
    let mut tiny = config.clone();
    tiny.judge.as_mut().unwrap().max_context_chars = 1;
    let mut unused_session = None;
    process(
        &tiny,
        tiny.judge.as_ref().unwrap(),
        &tracker,
        &mut unused_session,
        &resolved,
    )
    .await
    .unwrap();
    assert!(
        unused_session.is_none(),
        "a complete durable receipt must not invoke the judge again"
    );
    listener.abort();
    let _ = listener.await;
    worker.await.unwrap();
    let _ = agent_connection.disconnect().await;
}
