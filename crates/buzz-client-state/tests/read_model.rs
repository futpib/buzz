use buzz_client_state::{ActivityCategory, ClientState, PageCursor, ProjectionScope, ReadMarker};
use buzz_core::{Event, Keys, Kind};
use nostr::{EventBuilder, Tag, Timestamp};

fn signed_event(keys: &Keys, kind: u16, content: &str, tags: Vec<Tag>, created_at: u64) -> Event {
    EventBuilder::new(Kind::Custom(kind), content)
        .tags(tags)
        .custom_created_at(Timestamp::from(created_at))
        .sign_with_keys(keys)
        .expect("sign test event")
}

fn tag(parts: &[&str]) -> Tag {
    Tag::parse(parts.iter().copied()).expect("parse test tag")
}

fn scope(keys: &Keys) -> ProjectionScope {
    ProjectionScope::new("wss://buzz.test/", keys.public_key().to_hex())
}

#[tokio::test]
async fn projects_the_android_hot_path_and_persists_it() {
    let directory = tempfile::tempdir().expect("create temp directory");
    let path = directory.path().join("state.db");
    let viewer = Keys::generate();
    let author = Keys::generate();
    let relay = Keys::generate();
    let channel_id = "11111111-1111-4111-8111-111111111111";
    let viewer_hex = viewer.public_key().to_hex();
    let author_hex = author.public_key().to_hex();

    let metadata = signed_event(
        &relay,
        39000,
        "",
        vec![
            tag(&["d", channel_id]),
            tag(&["name", "Fast lane"]),
            tag(&["t", "stream"]),
            tag(&["public"]),
            tag(&["about", "Client projections"]),
        ],
        100,
    );
    let membership = signed_event(
        &relay,
        39002,
        "",
        vec![
            tag(&["d", channel_id]),
            tag(&["p", &viewer_hex, "", "member"]),
            tag(&["p", &author_hex, "", "owner"]),
        ],
        101,
    );
    let root = signed_event(
        &author,
        9,
        "alpha launch",
        vec![tag(&["h", channel_id]), tag(&["p", &viewer_hex])],
        200,
    );
    let root_id = root.id.to_hex();
    let reply = signed_event(
        &author,
        9,
        "reply from the future",
        vec![
            tag(&["h", channel_id]),
            tag(&["e", &root_id, "", "reply"]),
            tag(&["p", &viewer_hex]),
        ],
        201,
    );
    let reaction = signed_event(&viewer, 7, "👍", vec![tag(&["e", &root_id])], 202);
    let reaction_id = reaction.id.to_hex();
    let edit = signed_event(
        &author,
        40003,
        "beta launch",
        vec![tag(&["h", channel_id]), tag(&["e", &root_id])],
        203,
    );

    let state = ClientState::open(&path, scope(&viewer))
        .await
        .expect("open state");
    // A reply arriving before its root is a normal eventually-consistent sync.
    let stats = state
        .apply(vec![
            reply.clone(),
            metadata,
            membership,
            root,
            reaction,
            edit,
        ])
        .await
        .expect("apply events");
    assert_eq!(stats.inserted, 6);
    assert_eq!(stats.duplicates, 0);
    assert_eq!(stats.revision, 1);

    let channels = state.channels(true).await.expect("query channels");
    assert_eq!(channels.len(), 1);
    assert_eq!(channels[0].name, "Fast lane");
    assert_eq!(channels[0].member_count, 2);
    assert!(channels[0].is_member);
    assert_eq!(channels[0].unread_count, 2);
    assert_eq!(channels[0].last_event_at, Some(201));

    let messages = state
        .channel_messages(channel_id, None, 50)
        .await
        .expect("query messages");
    assert_eq!(messages.len(), 1, "non-broadcast reply stays in thread");
    assert_eq!(messages[0].content, "beta launch");
    assert!(messages[0].edited);
    assert_eq!(messages[0].reactions[0].emoji, "👍");
    assert_eq!(
        messages[0].reactions[0].current_user_reaction_id.as_deref(),
        Some(reaction_id.as_str())
    );

    let thread = state.thread(&root_id, 50).await.expect("query thread");
    assert_eq!(thread.reply_count, 1);
    assert_eq!(thread.replies, vec![thread.replies[0].clone()]);
    assert_eq!(thread.replies[0].event_id, reply.id.to_hex());
    assert_eq!(thread.participant_pubkeys, vec![author_hex.clone()]);

    let activity = state.activity(50).await.expect("query activity");
    assert_eq!(activity.len(), 1, "thread mentions group by root");
    assert_eq!(activity[0].conversation_id, root_id);
    assert_eq!(activity[0].category, ActivityCategory::Mention);
    assert!(!activity[0].read);

    let search = state.search("beta lau", 20).await.expect("search");
    assert_eq!(search.len(), 1);
    assert_eq!(search[0].message.content, "beta launch");

    state
        .apply_read_markers(vec![ReadMarker {
            context_id: channel_id.to_string(),
            read_at: 200,
        }])
        .await
        .expect("advance channel marker");
    assert_eq!(
        state.channels(true).await.expect("channels")[0].unread_count,
        1
    );
    state
        .apply_read_markers(vec![ReadMarker {
            context_id: format!("thread:{root_id}"),
            read_at: 201,
        }])
        .await
        .expect("advance thread marker");
    assert_eq!(
        state.channels(true).await.expect("channels")[0].unread_count,
        0
    );
    assert!(state.activity(50).await.expect("activity")[0].read);

    drop(state);
    let reopened = ClientState::open(&path, scope(&viewer))
        .await
        .expect("reopen state");
    assert_eq!(
        reopened.channels(true).await.expect("persisted channels")[0].name,
        "Fast lane"
    );
}

#[tokio::test]
async fn converges_under_late_events_duplicates_and_tombstones() {
    let directory = tempfile::tempdir().expect("create temp directory");
    let viewer = Keys::generate();
    let author = Keys::generate();
    let relay = Keys::generate();
    let channel_id = "22222222-2222-4222-8222-222222222222";
    let viewer_hex = viewer.public_key().to_hex();
    let state = ClientState::open(directory.path().join("state.db"), scope(&viewer))
        .await
        .expect("open state");

    let older_metadata = signed_event(
        &relay,
        39000,
        "",
        vec![
            tag(&["d", channel_id]),
            tag(&["name", "Old name"]),
            tag(&["public"]),
        ],
        10,
    );
    let newer_metadata = signed_event(
        &relay,
        39000,
        "",
        vec![
            tag(&["d", channel_id]),
            tag(&["name", "New name"]),
            tag(&["public"]),
        ],
        20,
    );
    let newer_metadata_id = newer_metadata.id.to_hex();
    let older_membership = signed_event(
        &relay,
        39002,
        "",
        vec![
            tag(&["d", channel_id]),
            tag(&["p", &author.public_key().to_hex()]),
        ],
        10,
    );
    let membership = signed_event(
        &relay,
        39002,
        "",
        vec![tag(&["d", channel_id]), tag(&["p", &viewer_hex])],
        20,
    );
    let membership_id = membership.id.to_hex();
    let latest = signed_event(
        &author,
        9,
        "latest message",
        vec![tag(&["h", channel_id])],
        100,
    );
    state
        .apply(vec![
            newer_metadata,
            older_membership,
            membership,
            latest.clone(),
        ])
        .await
        .expect("seed projection");
    state
        .apply(vec![older_metadata])
        .await
        .expect("apply late metadata");
    assert_eq!(
        state.channels(true).await.expect("channels")[0].name,
        "New name"
    );

    let duplicate = state
        .apply(vec![latest.clone()])
        .await
        .expect("apply duplicate");
    assert_eq!(duplicate.inserted, 0);
    assert_eq!(duplicate.duplicates, 1);

    let doomed = signed_event(
        &author,
        9,
        "must never flash",
        vec![tag(&["h", channel_id])],
        50,
    );
    let doomed_id = doomed.id.to_hex();
    let deletion = signed_event(
        &author,
        5,
        "",
        vec![tag(&["h", channel_id]), tag(&["e", &doomed_id])],
        70,
    );
    state.apply(vec![deletion]).await.expect("apply tombstone");
    state.apply(vec![doomed]).await.expect("apply late target");
    let page = state
        .channel_messages(channel_id, None, 50)
        .await
        .expect("query messages");
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].event_id, latest.id.to_hex());
    assert!(state
        .search("must never", 20)
        .await
        .expect("search")
        .is_empty());

    let delete_current_metadata =
        signed_event(&relay, 5, "", vec![tag(&["e", &newer_metadata_id])], 200);
    let delete_current_membership =
        signed_event(&relay, 5, "", vec![tag(&["e", &membership_id])], 201);
    state
        .apply(vec![delete_current_metadata, delete_current_membership])
        .await
        .expect("delete current replaceable heads");
    let rebuilt = state.channels(false).await.expect("rebuilt channel");
    assert_eq!(rebuilt[0].name, "Old name");
    assert!(!rebuilt[0].is_member);
}

#[tokio::test]
async fn repairs_edits_reactions_and_threads_when_deletions_arrive() {
    let directory = tempfile::tempdir().expect("create temp directory");
    let viewer = Keys::generate();
    let author = Keys::generate();
    let relay = Keys::generate();
    let channel_id = "33333333-3333-4333-8333-333333333333";
    let viewer_hex = viewer.public_key().to_hex();
    let state = ClientState::open(directory.path().join("state.db"), scope(&viewer))
        .await
        .expect("open state");

    let metadata = signed_event(
        &relay,
        39000,
        "",
        vec![
            tag(&["d", channel_id]),
            tag(&["name", "Repair"]),
            tag(&["public"]),
        ],
        1,
    );
    let membership = signed_event(
        &relay,
        39002,
        "",
        vec![tag(&["d", channel_id]), tag(&["p", &viewer_hex])],
        2,
    );
    let root = signed_event(
        &author,
        9,
        "original searchable text",
        vec![tag(&["h", channel_id])],
        10,
    );
    let root_id = root.id.to_hex();
    let reply = signed_event(
        &viewer,
        9,
        "temporary reply",
        vec![tag(&["h", channel_id]), tag(&["e", &root_id, "", "reply"])],
        11,
    );
    let edit = signed_event(
        &author,
        40003,
        "edited searchable text",
        vec![tag(&["h", channel_id]), tag(&["e", &root_id])],
        12,
    );
    let reaction = signed_event(&viewer, 7, "🚀", vec![tag(&["e", &root_id])], 13);
    state
        .apply(vec![
            metadata,
            membership,
            root,
            reply.clone(),
            edit.clone(),
            reaction.clone(),
        ])
        .await
        .expect("seed state");

    let delete_reaction =
        signed_event(&viewer, 5, "", vec![tag(&["e", &reaction.id.to_hex()])], 14);
    let delete_edit = signed_event(&author, 5, "", vec![tag(&["e", &edit.id.to_hex()])], 15);
    let delete_reply = signed_event(
        &viewer,
        5,
        "",
        vec![tag(&["h", channel_id]), tag(&["e", &reply.id.to_hex()])],
        16,
    );
    state
        .apply(vec![delete_reaction, delete_edit, delete_reply])
        .await
        .expect("apply deletions");

    let messages = state
        .channel_messages(channel_id, None, 50)
        .await
        .expect("messages");
    assert_eq!(messages[0].content, "original searchable text");
    assert!(!messages[0].edited);
    assert!(messages[0].reactions.is_empty());
    let thread = state.thread(&root_id, 50).await.expect("thread");
    assert_eq!(thread.reply_count, 0);
    assert!(thread.replies.is_empty());
    assert_eq!(state.search("original", 20).await.expect("search").len(), 1);
    assert!(state.search("edited", 20).await.expect("search").is_empty());
}

#[tokio::test]
async fn keyset_pagination_preserves_same_second_messages() {
    let directory = tempfile::tempdir().expect("create temp directory");
    let viewer = Keys::generate();
    let author = Keys::generate();
    let relay = Keys::generate();
    let channel_id = "44444444-4444-4444-8444-444444444444";
    let state = ClientState::open(directory.path().join("state.db"), scope(&viewer))
        .await
        .expect("open state");
    let metadata = signed_event(
        &relay,
        39000,
        "",
        vec![
            tag(&["d", channel_id]),
            tag(&["name", "Paging"]),
            tag(&["public"]),
        ],
        1,
    );
    let mut events = vec![metadata];
    for index in 0..5 {
        events.push(signed_event(
            &author,
            9,
            &format!("message {index}"),
            vec![tag(&["h", channel_id])],
            100,
        ));
    }
    state.apply(events).await.expect("apply events");
    let first = state
        .channel_messages(channel_id, None, 2)
        .await
        .expect("first page");
    let cursor = PageCursor {
        created_at: first[1].created_at,
        event_id: first[1].event_id.clone(),
    };
    let second = state
        .channel_messages(channel_id, Some(cursor), 10)
        .await
        .expect("second page");
    let ids = first
        .iter()
        .chain(&second)
        .map(|message| message.event_id.clone())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), 5);
    assert_eq!(first.len() + second.len(), 5);
}

#[tokio::test]
async fn enqueue_barrier_tie_breaking_and_scope_fencing_are_deterministic() {
    let directory = tempfile::tempdir().expect("create temp directory");
    let path = directory.path().join("state.db");
    let viewer = Keys::generate();
    let other_viewer = Keys::generate();
    let relay = Keys::generate();
    let channel_id = "55555555-5555-4555-8555-555555555555";
    let first = signed_event(
        &relay,
        39000,
        "",
        vec![
            tag(&["d", channel_id]),
            tag(&["name", "First candidate"]),
            tag(&["public"]),
        ],
        100,
    );
    let second = signed_event(
        &relay,
        39000,
        "",
        vec![
            tag(&["d", channel_id]),
            tag(&["name", "Second candidate"]),
            tag(&["public"]),
        ],
        100,
    );
    let (winner, winner_name, loser) = if first.id.to_hex() < second.id.to_hex() {
        (first, "First candidate", second)
    } else {
        (second, "Second candidate", first)
    };

    let state = ClientState::open(&path, scope(&viewer))
        .await
        .expect("open state");
    state.enqueue(loser).expect("enqueue losing metadata");
    state.enqueue(winner).expect("enqueue winning metadata");
    let revision = state.flush().await.expect("flush queue");
    assert_eq!(revision, 2);
    assert_eq!(
        state.channels(false).await.expect("channels")[0].name,
        winner_name
    );

    let isolated = ClientState::open(&path, scope(&other_viewer))
        .await
        .expect("open isolated scope");
    assert!(isolated
        .channels(false)
        .await
        .expect("isolated channels")
        .is_empty());
}

#[tokio::test]
async fn a_bad_signature_rejects_the_whole_snapshot_batch() {
    let directory = tempfile::tempdir().expect("create temp directory");
    let viewer = Keys::generate();
    let relay = Keys::generate();
    let channel_id = "66666666-6666-4666-8666-666666666666";
    let state = ClientState::open(directory.path().join("state.db"), scope(&viewer))
        .await
        .expect("open state");
    let metadata = signed_event(
        &relay,
        39000,
        "",
        vec![
            tag(&["d", channel_id]),
            tag(&["name", "Atomic snapshot"]),
            tag(&["public"]),
        ],
        1,
    );
    let valid = signed_event(&relay, 9, "authentic", vec![tag(&["h", channel_id])], 2);
    let mut tampered_json = serde_json::to_value(valid).expect("serialize event");
    tampered_json["content"] = serde_json::Value::String("tampered".to_string());
    let tampered: Event = serde_json::from_value(tampered_json).expect("decode tampered event");

    assert!(state.apply(vec![metadata, tampered]).await.is_err());
    assert!(state
        .channels(false)
        .await
        .expect("query empty projection")
        .is_empty());
}

#[tokio::test]
async fn activity_limits_conversations_and_thread_summaries_ignore_non_messages() {
    let directory = tempfile::tempdir().expect("create temp directory");
    let viewer = Keys::generate();
    let author = Keys::generate();
    let channel_id = "77777777-7777-4777-8777-777777777777";
    let viewer_hex = viewer.public_key().to_hex();
    let state = ClientState::open(directory.path().join("state.db"), scope(&viewer))
        .await
        .expect("open state");

    let root = signed_event(
        &author,
        9,
        "first conversation",
        vec![tag(&["h", channel_id]), tag(&["p", &viewer_hex])],
        100,
    );
    let root_id = root.id.to_hex();
    let reply = signed_event(
        &author,
        9,
        "newer reply",
        vec![
            tag(&["h", channel_id]),
            tag(&["e", &root_id, "", "reply"]),
            tag(&["p", &viewer_hex]),
        ],
        102,
    );
    let approval = signed_event(
        &author,
        46010,
        "approval in thread",
        vec![
            tag(&["h", channel_id]),
            tag(&["e", &root_id, "", "reply"]),
            tag(&["p", &viewer_hex]),
        ],
        101,
    );
    let independent = signed_event(
        &author,
        9,
        "second conversation",
        vec![tag(&["h", channel_id]), tag(&["p", &viewer_hex])],
        99,
    );
    state
        .apply(vec![approval, root, reply, independent])
        .await
        .expect("project activity");

    let activity = state.activity(2).await.expect("query grouped activity");
    assert_eq!(
        activity.len(),
        2,
        "limit applies after conversation grouping"
    );
    assert_eq!(activity[0].conversation_id, root_id);
    assert_eq!(activity[0].category, ActivityCategory::NeedsAction);
    assert_eq!(
        state
            .thread(&activity[0].conversation_id, 20)
            .await
            .expect("thread")
            .reply_count,
        1,
        "workflow events are activity, not message replies"
    );
}
