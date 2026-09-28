use super::*;

mod live;

fn key(f: &Fixture) -> ThreadKey {
    ThreadKey {
        channel_id: f.channel,
        root_event_id: f.root.id,
    }
}

fn working(f: &Fixture, revision: u64) -> AgentTurnRecord {
    AgentTurnRecord {
        state: AgentThreadState::Agent,
        revision,
        event_id: f.agent_reply.id,
        turn_id: "turn".into(),
        expires_at: Some(150),
        authoritative: true,
        created_at: 100,
        stale: false,
    }
}

fn handoff(f: &Fixture, created_at: u64) -> Event {
    buzz_sdk::build_message(
        f.channel,
        "@owner reply",
        Some(&ThreadRef {
            root_event_id: f.root.id,
            parent_event_id: f.root.id,
        }),
        &[&f.owner.public_key().to_hex()],
        false,
        &[],
        &[],
    )
    .unwrap()
    .tag(auth_tag(&f.owner, &f.agent))
    .custom_created_at(Timestamp::from_secs(created_at))
    .sign_with_keys(&f.agent)
    .unwrap()
}

fn replay_handoff(f: &Fixture, state: &mut RouteState, created_at: u64) {
    assert_eq!(
        record_agent_handoff(
            state,
            &handoff(f, created_at),
            &[f.owner.public_key()],
            &f.bot.public_key()
        ),
        Some(key(f))
    );
}

fn roundtrip(f: &Fixture, state: &RouteState) -> RouteState {
    let (status, expiry) = aggregate_thread_status(state, key(f)).unwrap();
    let records = state.agent_turns[&key(f)]
        .iter()
        .map(|(k, v)| (*k, v.clone()))
        .collect::<Vec<_>>();
    let event = build_thread_status_reaction(key(f), status, expiry, &records)
        .unwrap()
        .sign_with_keys(&f.bot)
        .unwrap();
    let mut recovered = RouteState::default();
    recover_status_projections(&mut recovered, f.channel, &[event], &f.bot.public_key());
    recovered
}

#[test]
fn replayed_handoff_cannot_poison_a_publisher_revision() {
    let f = Fixture::new();
    for first in [true, false] {
        let mut state = RouteState::default();
        if first {
            replay_handoff(&f, &mut state, 90);
        }
        record_agent_turn(&mut state, key(&f), f.agent.public_key(), working(&f, 1));
        replay_handoff(&f, &mut state, 90);
        // Even a new owner-directed progress message is not a lifecycle terminal.
        replay_handoff(&f, &mut state, 110);
        assert_eq!(
            aggregate_thread_status(&state, key(&f)),
            Some((AgentThreadState::Agent, Some(150)))
        );
        assert_eq!(
            state.agent_turns[&key(&f)][&f.agent.public_key()].revision,
            1
        );
    }
}

#[test]
fn inference_uses_message_time_not_replay_time() {
    let f = Fixture::new();
    let mut state = RouteState::default();
    let mut route = working(&f, u64::MAX);
    route.authoritative = false;
    record_agent_turn(&mut state, key(&f), f.agent.public_key(), route);
    replay_handoff(&f, &mut state, 90);
    assert_eq!(
        aggregate_thread_status(&state, key(&f)),
        Some((AgentThreadState::Agent, Some(150)))
    );
    replay_handoff(&f, &mut state, 110);
    assert_eq!(
        aggregate_thread_status(&state, key(&f)),
        Some((AgentThreadState::Human, None))
    );
    replay_handoff(&f, &mut state, 90);
    assert_eq!(
        state.agent_turns[&key(&f)][&f.agent.public_key()].created_at,
        110
    );
}

#[test]
fn expiry_preserves_revision_and_retries_projection_until_refreshed() {
    let f = Fixture::new();
    let mut state = RouteState::default();
    record_agent_turn(&mut state, key(&f), f.agent.public_key(), working(&f, 1));
    for _ in 0..2 {
        assert!(expire_agent_turns(&mut state, 151).contains(&key(&f)));
        assert_eq!(
            aggregate_thread_status(&state, key(&f)),
            Some((AgentThreadState::Failed, None))
        );
        assert_eq!(
            state.agent_turns[&key(&f)][&f.agent.public_key()].revision,
            1
        );
        assert_eq!(
            state.agent_turns[&key(&f)][&f.agent.public_key()].turn_id,
            "turn"
        );
    }
    state = roundtrip(&f, &state);
    replay_handoff(&f, &mut state, 110);
    assert_eq!(
        aggregate_thread_status(&state, key(&f)),
        Some((AgentThreadState::Failed, None))
    );
    let mut refresh = working(&f, 2);
    refresh.created_at = 151;
    refresh.expires_at = Some(196);
    record_agent_turn(&mut state, key(&f), f.agent.public_key(), refresh);
    assert_eq!(
        aggregate_thread_status(&state, key(&f)),
        Some((AgentThreadState::Agent, Some(196)))
    );
}

#[test]
fn reconnect_preserves_terminal_fences_but_allows_new_turns() {
    let f = Fixture::new();
    for terminal in [AgentThreadState::Human, AgentThreadState::Failed] {
        let mut state = RouteState::default();
        let mut finished = working(&f, 2);
        finished.state = terminal;
        finished.expires_at = None;
        record_agent_turn(&mut state, key(&f), f.agent.public_key(), finished);
        state = roundtrip(&f, &state);
        record_agent_turn(&mut state, key(&f), f.agent.public_key(), working(&f, 3));
        replay_handoff(&f, &mut state, 110);
        assert_eq!(
            aggregate_thread_status(&state, key(&f)),
            Some((terminal, None))
        );
        let mut next = working(&f, 4);
        next.turn_id = "next-turn".into();
        record_agent_turn(&mut state, key(&f), f.agent.public_key(), next);
        assert_eq!(
            aggregate_thread_status(&state, key(&f)),
            Some((AgentThreadState::Agent, Some(150)))
        );
    }
}

#[test]
fn old_terminal_cannot_overwrite_a_newer_route() {
    let f = Fixture::new();
    let mut state = RouteState::default();
    let mut route = working(&f, 999);
    route.authoritative = false;
    record_agent_turn(&mut state, key(&f), f.agent.public_key(), route);
    let mut old = working(&f, 1);
    old.created_at = 90;
    old.state = AgentThreadState::Human;
    old.expires_at = None;
    record_agent_turn(&mut state, key(&f), f.agent.public_key(), old);
    assert_eq!(
        aggregate_thread_status(&state, key(&f)),
        Some((AgentThreadState::Agent, Some(150)))
    );
}

#[test]
fn legacy_status_receipts_allow_new_lifecycle_despite_large_local_revision() {
    let f = Fixture::new();
    let event = build_thread_status_reaction(key(&f), AgentThreadState::Agent, Some(150), &[])
        .unwrap()
        .tag(
            Tag::parse([
                STATUS_AGENT_TAG,
                &f.agent.public_key().to_hex(),
                "legacy",
                &u64::MAX.to_string(),
                "150",
                &f.agent_reply.id.to_hex(),
            ])
            .unwrap(),
        )
        .custom_created_at(Timestamp::from_secs(90))
        .sign_with_keys(&f.bot)
        .unwrap();
    let mut state = RouteState::default();
    recover_status_projections(&mut state, f.channel, &[event], &f.bot.public_key());
    expire_agent_turns(&mut state, 151);
    record_agent_turn(&mut state, key(&f), f.agent.public_key(), working(&f, 1));
    assert!(!state.agent_turns[&key(&f)][&f.agent.public_key()].stale);
    assert_eq!(
        state.agent_turns[&key(&f)][&f.agent.public_key()].revision,
        1
    );
}
