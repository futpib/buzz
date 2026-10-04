use super::*;

#[tokio::test]
async fn passed_turns_sharing_a_root_survive_supersession_and_restart() {
    let (mut routes, check) = fixture();
    let bot = Keys::generate();
    let root = buzz_sdk::build_message(check.key.channel_id, "task", None, &[], false, &[], &[])
        .unwrap()
        .sign_with_keys(&bot)
        .unwrap();
    let key = ThreadKey {
        root_event_id: root.id,
        ..check.key
    };
    let record = routes.agent_turns.remove(&check.key).unwrap()[&check.agent].clone();
    let mut receipts = Vec::new();
    for index in 1..=5 {
        let source = EventId::from_byte_array([index; 32]);
        let receipt = turn_judge::passed_receipt(
            key.channel_id,
            source,
            root.id,
            EventId::from_byte_array([index + 10; 32]),
        )
        .unwrap()
        .sign_with_keys(&bot)
        .unwrap();
        receipts.push(receipt);
        routes.agent_turns.entry(key).or_default().insert(
            Keys::generate().public_key(),
            AgentTurnRecord {
                event_id: source,
                state: AgentThreadState::Human,
                ..record.clone()
            },
        );
    }
    let tracker = Arc::new(Mutex::new(JudgeTracker::default()));
    {
        let mut state = tracker.lock().await;
        recover_judge_deliveries(&mut state.deliveries, &receipts, &bot.public_key());
        state.recovery.connected = true;
    }
    let (tx, mut rx) = mpsc::channel(10);
    for _ in 0..3 {
        enqueue(&tx, &tracker, &routes).await.unwrap();
        assert!(
            rx.try_recv().is_err(),
            "recovery must not rejudge a passed turn"
        );
    }
    let fresh = EventId::from_byte_array([6; 32]);
    routes.agent_turns.entry(key).or_default().insert(
        check.agent,
        AgentTurnRecord {
            event_id: fresh,
            state: AgentThreadState::Human,
            ..record
        },
    );
    enqueue(&tx, &tracker, &routes).await.unwrap();
    assert!(matches!(rx.try_recv(), Ok(JudgeWork::Recovery(c)) if c.source == fresh));
}

#[test]
fn ordinary_message_passes_and_failed_turns_can_still_be_superseded() {
    let source = EventId::from_byte_array([1; 32]);
    let next = EventId::from_byte_array([2; 32]);
    for (turn_receipt, pass, expected) in
        [(false, true, true), (true, false, true), (true, true, true)]
    {
        let delivery = JudgeDelivery {
            target_id: Some(source),
            reaction_event_id: Some(source),
            turn_receipt,
            verdict: Some(JudgeVerdict {
                pass,
                failures: vec![],
            }),
            ..JudgeDelivery::default()
        };
        assert_eq!(delivery.superseded_by(source, next, source), expected);
        assert!(!delivery.superseded_by(source, source, source));
        assert!(!delivery.superseded_by(source, next, next));
    }
}

fn fixture() -> (RouteState, Check) {
    let check = Check {
        key: ThreadKey {
            channel_id: Uuid::new_v4(),
            root_event_id: EventId::from_byte_array([1; 32]),
        },
        agent: Keys::generate().public_key(),
        source: EventId::from_byte_array([2; 32]),
    };
    let mut routes = RouteState::default();
    routes.agent_turns.entry(check.key).or_default().insert(
        check.agent,
        AgentTurnRecord {
            state: AgentThreadState::Agent,
            revision: 1,
            event_id: check.source,
            turn_id: "interrupted".into(),
            expires_at: Some(100),
            authoritative: true,
            created_at: 1,
            stale: true,
        },
    );
    (routes, check)
}

#[test]
fn recovery_requires_connected_expired_authoritative_work_and_grace() {
    let (routes, check) = fixture();
    let mut tracker = Tracker {
        connected: true,
        ready_at: 200,
        records: routes.agent_turns,
        ..Tracker::default()
    };
    assert!(!tracker.current(&check, 199));
    assert!(!tracker.current(&check, 219));
    assert!(tracker.current(&check, 220));
    tracker.disconnect();
    assert!(!tracker.current(&check, 1000));
    tracker.connected = true;
    tracker
        .records
        .get_mut(&check.key)
        .unwrap()
        .get_mut(&check.agent)
        .unwrap()
        .authoritative = false;
    assert!(!tracker.current(&check, 1000));
}

#[test]
fn fresh_heartbeat_or_another_active_agent_invalidates_recovery() {
    let (routes, check) = fixture();
    let mut tracker = Tracker {
        connected: true,
        records: routes.agent_turns,
        ..Tracker::default()
    };
    assert!(tracker.current(&check, 1000));
    let mut active = tracker.records[&check.key][&check.agent].clone();
    active.expires_at = Some(1100);
    active.stale = false;
    let other = Keys::generate().public_key();
    tracker
        .records
        .get_mut(&check.key)
        .unwrap()
        .insert(other, active.clone());
    assert!(!tracker.current(&check, 1000));
    tracker.records.get_mut(&check.key).unwrap().remove(&other);
    active.event_id = EventId::from_byte_array([3; 32]);
    tracker
        .records
        .get_mut(&check.key)
        .unwrap()
        .insert(check.agent, active);
    assert!(!tracker.current(&check, 2000));
}

#[test]
fn routed_but_never_started_is_recoverable_but_historical_handoff_is_not() {
    let (routes, check) = fixture();
    let mut tracker = Tracker {
        connected: true,
        records: routes.agent_turns,
        ..Tracker::default()
    };
    let record = tracker
        .records
        .get_mut(&check.key)
        .unwrap()
        .get_mut(&check.agent)
        .unwrap();
    record.authoritative = false;
    record.turn_id = format!("route:{}", check.source);
    assert!(tracker.current(&check, 1000));
    let record = tracker
        .records
        .get_mut(&check.key)
        .unwrap()
        .get_mut(&check.agent)
        .unwrap();
    record.state = AgentThreadState::Human;
    record.turn_id = format!("handoff:{}", check.source);
    assert!(!tracker.current(&check, 1000));
}

#[tokio::test]
async fn queue_is_bounded_paced_and_respects_durable_completion() {
    let (routes, check) = fixture();
    let tracker = Arc::new(Mutex::new(JudgeTracker::default()));
    tracker.lock().await.recovery = Tracker {
        connected: true,
        ..Tracker::default()
    };
    let (tx, mut rx) = mpsc::channel(1);
    enqueue(&tx, &tracker, &routes).await.unwrap();
    assert!(matches!(rx.recv().await, Some(JudgeWork::Recovery(_))));
    tracker.lock().await.queued.clear();
    enqueue(&tx, &tracker, &routes).await.unwrap();
    assert!(rx.try_recv().is_err(), "a failure must not spin");
    tracker.lock().await.recovery.attempted.clear();
    tracker.lock().await.deliveries.insert(
        check.source,
        JudgeDelivery {
            reaction_event_id: Some(check.source),
            verdict: Some(JudgeVerdict {
                pass: true,
                failures: vec![],
            }),
            ..JudgeDelivery::default()
        },
    );
    enqueue(&tx, &tracker, &routes).await.unwrap();
    assert!(
        rx.try_recv().is_err(),
        "completed receipt must suppress replay"
    );
}
