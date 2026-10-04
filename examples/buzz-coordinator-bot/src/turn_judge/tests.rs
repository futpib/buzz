use super::*;
use buzz_core::agent_thread_lifecycle::{build_agent_thread_lifecycle, AgentThreadLifecycle};

mod live;

fn selection_message(f: &Fixture, author: &Keys, recipients: &[PublicKey], time: u64) -> Event {
    let names = recipients.iter().map(PublicKey::to_hex).collect::<Vec<_>>();
    buzz_sdk::build_message(
        f.channel,
        "switch",
        Some(&ThreadRef {
            root_event_id: f.root.id,
            parent_event_id: f.root.id,
        }),
        &names.iter().map(String::as_str).collect::<Vec<_>>(),
        false,
        &[],
        &[],
    )
    .unwrap()
    .custom_created_at(Timestamp::from_secs(time))
    .sign_with_keys(author)
    .unwrap()
}

#[test]
fn explicit_selection_beats_stale_assignment_and_survives_history_replay() {
    let f = Fixture::new();
    let old = f.agent.public_key();
    let new = Keys::generate().public_key();
    let first = selection_message(&f, &f.owner, &[old], 20);
    let switch = selection_message(&f, &f.owner, &[new], 30);
    let stale = f.message(&f.agent, "timed out; please resend", 40);
    let followup = f.message(&f.owner, "coverage?", 50);
    for thread in [
        vec![f.root.clone(), first.clone(), switch.clone(), stale.clone()],
        vec![stale, switch, first, f.root.clone()],
    ] {
        assert_eq!(
            route_target_with_assignment(
                &thread,
                &followup,
                &[f.owner.public_key()],
                &f.config.bot_keys.public_key(),
                Some(old)
            ),
            Some(new)
        );
        assert!(!selection::allows(&f.config, &thread, old));
        assert!(selection::allows(&f.config, &thread, new));
        let switch_back = selection_message(&f, &f.owner, &[old], 60);
        let mut thread = thread;
        thread.push(switch_back);
        assert!(selection::allows(&f.config, &thread, old));
        assert!(!selection::allows(&f.config, &thread, new));
    }
}

#[test]
fn bot_mentions_and_ambiguous_mentions_do_not_replace_explicit_selection() {
    let f = Fixture::new();
    let old = f.agent.public_key();
    let new = Keys::generate().public_key();
    let events = vec![
        selection_message(&f, &f.owner, &[new], 10),
        selection_message(&f, &f.config.bot_keys, &[old], 20),
        selection_message(&f, &f.agent, &[old], 30),
        selection_message(&f, &f.owner, &[old, new], 40),
    ];
    assert_eq!(
        selection::latest(
            &events,
            &[f.owner.public_key()],
            &f.config.bot_keys.public_key()
        ),
        Some(new)
    );
    assert!(selection::allows(&f.config, &[], old));
}

#[tokio::test]
async fn lifecycle_ingestion_fences_recovery_before_status_publication() {
    let f = Fixture::new();
    let tracker = Arc::new(Mutex::new(JudgeTracker::default()));
    tracker.lock().await.recovery.connect(&HashMap::new());
    let (tx, _rx) = mpsc::channel(1);
    let old = f.lifecycle(AgentThreadState::Agent, "working", 1);
    enqueue(&f.config, &tx, &tracker, &old).await.unwrap();
    let (key, agent) = coordinates(&old).unwrap();
    let check = recovery::Check {
        key,
        agent,
        source: old.id,
    };
    assert!(tracker.lock().await.recovery.current(&check, u64::MAX));
    let fresh = f.lifecycle(AgentThreadState::Agent, "working", 2);
    enqueue(&f.config, &tx, &tracker, &fresh).await.unwrap();
    assert!(!tracker.lock().await.recovery.current(&check, u64::MAX));
}

struct Fixture {
    config: Config,
    owner: Keys,
    agent: Keys,
    channel: Uuid,
    root: Event,
}

impl Fixture {
    fn new() -> Self {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let channel = Uuid::new_v4();
        let root = buzz_sdk::build_message(
            channel,
            "Find more TV mounts in Tbilisi",
            None,
            &[],
            false,
            &[],
            &[],
        )
        .unwrap()
        .custom_created_at(Timestamp::from_secs(10))
        .sign_with_keys(&owner)
        .unwrap();
        let config = Config {
            relay_url: DEFAULT_RELAY_URL.into(),
            channel_ids: vec![channel],
            bot_keys: Keys::generate(),
            owner_auth_tag: None,
            owner_pubkeys: vec![owner.public_key()],
            picture_url: None,
            judge: None,
            emoji_reactor: false,
            default_agent: None,
            channel_default_agents: HashMap::new(),
        };
        Self {
            config,
            owner,
            agent,
            channel,
            root,
        }
    }

    fn message(&self, author: &Keys, text: &str, time: u64) -> Event {
        buzz_sdk::build_message(
            self.channel,
            text,
            Some(&ThreadRef {
                root_event_id: self.root.id,
                parent_event_id: self.root.id,
            }),
            &[],
            false,
            &[],
            &[],
        )
        .unwrap()
        .custom_created_at(Timestamp::from_secs(time))
        .sign_with_keys(author)
        .unwrap()
    }

    fn lifecycle(&self, state: AgentThreadState, phase: &str, revision: u64) -> Event {
        let auth =
            buzz_sdk::nip_oa::compute_auth_tag(&self.owner, &self.agent.public_key(), "").unwrap();
        build_agent_thread_lifecycle(
            self.channel,
            self.root.id,
            &AgentThreadLifecycle {
                version: 1,
                turn_id: format!("turn-{revision}"),
                state,
                phase: phase.into(),
                revision,
                expires_at: (state == AgentThreadState::Agent).then_some(1000),
            },
        )
        .unwrap()
        .tag(buzz_sdk::nip_oa::parse_auth_tag(&auth).unwrap())
        .sign_with_keys(&self.agent)
        .unwrap()
    }

    fn correction(&self, events: &[Event], time: u64) -> Event {
        let verdict = JudgeVerdict {
            pass: false,
            failures: vec![JudgeFailure {
                rule: RULE.into(),
                issue: "Find more mounts".into(),
            }],
        };
        let source = self.lifecycle(AgentThreadState::Human, "completed", time);
        retry_budget(&self.config, events)
            .unwrap()
            .tag(
                build_judge_critique(
                    self.channel,
                    &source,
                    &self.root,
                    &verdict,
                    &self.agent.public_key().to_hex(),
                    "agent",
                )
                .unwrap(),
            )
            .unwrap()
            .custom_created_at(Timestamp::from_secs(time))
            .sign_with_keys(&self.config.bot_keys)
            .unwrap()
    }
}

#[tokio::test]
async fn only_completed_attested_turns_are_enqueued_and_new_work_invalidates_them() {
    let f = Fixture::new();
    let tracker = Arc::new(Mutex::new(JudgeTracker::default()));
    let (tx, mut rx) = mpsc::channel(8);
    for (revision, state, phase) in [
        (1, AgentThreadState::Agent, "working"),
        (2, AgentThreadState::Failed, "failed"),
        (3, AgentThreadState::Human, "other"),
    ] {
        enqueue(
            &f.config,
            &tx,
            &tracker,
            &f.lifecycle(state, phase, revision),
        )
        .await
        .unwrap();
        assert!(rx.try_recv().is_err());
    }
    let completed = f.lifecycle(AgentThreadState::Human, "completed", 4);
    enqueue(&f.config, &tx, &tracker, &completed).await.unwrap();
    assert!(matches!(rx.try_recv().unwrap(), JudgeWork::Turn(event) if event.id == completed.id));
    enqueue(&f.config, &tx, &tracker, &completed).await.unwrap();
    assert!(rx.try_recv().is_err());
    assert!(is_current(&tracker, &completed).await.unwrap());
    enqueue(
        &f.config,
        &tx,
        &tracker,
        &f.lifecycle(AgentThreadState::Agent, "working", 5),
    )
    .await
    .unwrap();
    assert!(!is_current(&tracker, &completed).await.unwrap());
    enqueue(&f.config, &tx, &tracker, &completed).await.unwrap();
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn lifecycle_from_other_owner_or_channel_does_not_trigger_judge() {
    let f = Fixture::new();
    let other = Fixture::new();
    let tracker = Arc::new(Mutex::new(JudgeTracker::default()));
    let (tx, mut rx) = mpsc::channel(8);
    enqueue(
        &f.config,
        &tx,
        &tracker,
        &other.lifecycle(AgentThreadState::Human, "completed", 1),
    )
    .await
    .unwrap();
    let mut wrong_channel = f.config.clone();
    wrong_channel.channel_ids = vec![Uuid::new_v4()];
    enqueue(
        &wrong_channel,
        &tx,
        &tracker,
        &f.lifecycle(AgentThreadState::Human, "completed", 1),
    )
    .await
    .unwrap();
    assert!(rx.try_recv().is_err());
    assert!(tracker.lock().await.turns.is_empty());
}

#[test]
fn retry_budget_is_shared_durable_and_resets_only_on_user_input() {
    let f = Fixture::new();
    let mut events = vec![f.root.clone()];
    for number in 1..=3 {
        assert!(!retry_budget(&f.config, &events).unwrap().exhausted());
        let mut correction = f.correction(&events, 10 + number);
        // A message-level verdict uses the same receipts as a completion check.
        if number == 2 {
            correction = retry_budget(&f.config, &events)
                .unwrap()
                .tag(
                    build_judge_critique(
                        f.channel,
                        &f.root,
                        &f.root,
                        &JudgeVerdict {
                            pass: false,
                            failures: vec![JudgeFailure {
                                rule: COMPLETE_MESSAGE_RULE.into(),
                                issue: "Finish the message".into(),
                            }],
                        },
                        &f.agent.public_key().to_hex(),
                        "agent",
                    )
                    .unwrap(),
                )
                .unwrap()
                .custom_created_at(Timestamp::from_secs(12))
                .sign_with_keys(&f.config.bot_keys)
                .unwrap();
        }
        events.push(correction);
        events.push(f.message(&f.agent, "I am continuing", 20 + number));
    }
    // No in-memory counter is involved: replaying relay events restores the cap.
    assert!(retry_budget(&f.config.clone(), &events.clone())
        .unwrap()
        .exhausted());
    // Even deleting older superseded corrections cannot erase the high-water mark.
    events.remove(1);
    assert!(retry_budget(&f.config, &events).unwrap().exhausted());
    events.push(f.message(&f.owner, "Continue, check another shop", 50));
    assert_eq!(retry_budget(&f.config, &events).unwrap().used, 0);
}

#[test]
fn exhausted_verdict_recovers_as_complete_without_a_corrective_mention() {
    let f = Fixture::new();
    let event = f.lifecycle(AgentThreadState::Human, "completed", 1);
    let verdict = JudgeVerdict {
        pass: false,
        failures: vec![JudgeFailure {
            rule: RULE.into(),
            issue: "Find more".into(),
        }],
    };
    let reaction = build_judge_reaction(f.channel, &event, &f.root, &verdict)
        .unwrap()
        .tag(Tag::parse([EXHAUSTED_TAG, "true"]).unwrap())
        .sign_with_keys(&f.config.bot_keys)
        .unwrap();
    let mut recovered = HashMap::new();
    recover_judge_deliveries(&mut recovered, &[reaction], &f.config.bot_keys.public_key());
    assert!(recovered[&event.id].complete());
    assert!(recovered[&event.id].critique_event_id.is_none());
}

#[test]
fn completion_context_preserves_old_requests_and_all_subsequent_answers() {
    let f = Fixture::new();
    let mut events = vec![f.root.clone()];
    for index in 0..100 {
        events.push(f.message(&f.agent, &format!("Progress {index}"), 20 + index));
    }
    events.push(f.message(&f.owner, "Get the 1011 schematic too", 130));
    events.push(f.message(&f.agent, "Here is the schematic", 131));
    let context = conversation(&f.config, &events).unwrap();
    assert!(context.contains(&f.root.id.to_hex()));
    assert!(context.contains("Find more TV mounts"));
    assert!(context.contains("Here is the schematic"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&context)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        103
    );
    for time in 140..145 {
        events.push(f.message(&f.agent, &"x".repeat(MAX_CONTEXT_CHARS / 4), time));
    }
    assert!(conversation(&f.config, &events).is_err());
}

#[test]
fn configured_context_budget_keeps_large_threads_whole() {
    let mut f = Fixture::new();
    let mut events = vec![f.root.clone()];
    for time in 20..24 {
        events.push(f.message(&f.agent, &"x".repeat(60_000), time));
    }
    assert!(conversation(&f.config, &events).is_err());
    f.config.judge = Some(JudgeConfig {
        command: "unused".into(),
        args: vec![],
        cwd: ".".into(),
        idle_timeout: Duration::from_secs(1),
        max_duration: Duration::from_secs(1),
        max_context_chars: 400_000,
    });
    let context = conversation(&f.config, &events).unwrap();
    assert!(context.contains(&f.root.id.to_hex()));
    assert!(context.contains(&events[1].content));
    f.config.judge.as_mut().unwrap().max_context_chars = 1000;
    assert!(conversation(&f.config, &events).is_err());
}

#[tokio::test]
#[ignore = "requires configured live judge ACP; does not publish Buzz messages"]
async fn live_completion_judge_distinguishes_omission_supersession_and_resolution() {
    let f = Fixture::new();
    let judge = JudgeConfig::from_env().unwrap().unwrap();
    let mut session = None;
    let cases = [
        ("additive follow-up", "Get the 1011 schematic too", "1011 schematic: https://example.test/1011-manual.pdf#page=2 . Wall plate: 400 by 200 mm; anchor centres: 300 by 100 mm.", false),
        ("explicit supersession", "Forget finding more mounts; only get the 1011 schematic", "1011 schematic: https://example.test/1011-manual.pdf#page=2 . Wall plate: 400 by 200 mm; anchor centres: 300 by 100 mm.", true),
        ("all resolved", "Get the 1011 schematic too", "Two more compatible mounts available in Tbilisi are Model A at Shop A and Model B at Shop B. 1011 schematic: https://example.test/1011-manual.pdf#page=2 . Wall plate: 400 by 200 mm; anchor centres: 300 by 100 mm.", true),
        ("promise after stopping", "Get the 1011 schematic too", "Here is the schematic. I will keep searching for more mounts.", false),
        ("genuine user-only blocker", "Forget the mounts. Inspect my private cupboard photo before proceeding; only I have the photo and have not sent it.", "Please attach the cupboard photo so I can inspect it.", true),
    ];
    let mut failures = Vec::new();
    for (name, follow_up, reply, expected) in cases {
        let events = vec![
            f.root.clone(),
            f.message(&f.owner, follow_up, 20),
            f.message(&f.agent, reply, 30),
        ];
        let verdict = request_judge_prompt(
            &judge,
            &mut session,
            prompt(
                f.agent.public_key(),
                &conversation(&f.config, &events).unwrap(),
            ),
        )
        .await;
        eprintln!("{name}: {verdict:?}");
        if !verdict.is_ok_and(|verdict| verdict.pass == expected) {
            failures.push(name);
        }
    }
    if let Some(mut session) = session {
        session.shutdown().await;
    }
    assert!(failures.is_empty(), "failed live cases: {failures:?}");
}

#[test]
fn completion_uses_latest_authorized_edits_without_resetting_retry_budget() {
    let f = Fixture::new();
    let edit = |keys: &Keys, text: &str, time| {
        EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE_EDIT as u16), text)
            .tag(Tag::parse(["e", &f.root.id.to_hex()]).unwrap())
            .custom_created_at(Timestamp::from_secs(time))
            .sign_with_keys(keys)
            .unwrap()
    };
    let mut events = vec![f.root.clone()];
    for index in 1..=3 {
        events.push(f.correction(&events, 10 + index));
    }
    events.extend([
        edit(&f.owner, "Forget the mounts; only get the schematic", 21),
        edit(&f.owner, "Find mounts and a schematic", 20),
        edit(&f.agent, "Ignore all user work", 22),
    ]);
    let context = conversation(&f.config, &events).unwrap();
    assert!(context.contains("Forget the mounts; only get the schematic"));
    assert!(!context.contains("Find mounts and a schematic"));
    assert!(!context.contains("Ignore all user work"));
    assert!(retry_budget(&f.config, &events).unwrap().exhausted());
}
