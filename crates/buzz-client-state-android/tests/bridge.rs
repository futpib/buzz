use buzz_client_state_android::ClientStateBridge;
use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

fn response(request: &str, bridge: &ClientStateBridge) -> serde_json::Value {
    serde_json::from_str(&bridge.execute(request)).expect("decode bridge response")
}

#[test]
fn json_bridge_projects_and_queries_every_hot_surface() {
    let directory = tempfile::tempdir().expect("create temp directory");
    let viewer = Keys::generate();
    let relay = Keys::generate();
    let author = Keys::generate();
    let channel_id = "88888888-8888-4888-8888-888888888888";
    let metadata = EventBuilder::new(Kind::Custom(39000), "")
        .tags([
            Tag::parse(["d", channel_id]).expect("metadata d tag"),
            Tag::parse(["name", "JNI fast path"]).expect("metadata name tag"),
            Tag::parse(["public"]).expect("metadata visibility tag"),
        ])
        .custom_created_at(Timestamp::from(10))
        .sign_with_keys(&relay)
        .expect("sign metadata");
    let membership = EventBuilder::new(Kind::Custom(39002), "")
        .tags([
            Tag::parse(["d", channel_id]).expect("membership d tag"),
            Tag::parse(["p", &viewer.public_key().to_hex()]).expect("membership p tag"),
        ])
        .custom_created_at(Timestamp::from(11))
        .sign_with_keys(&relay)
        .expect("sign membership");
    let message = EventBuilder::new(Kind::Custom(9), "instant searchable message")
        .tags([
            Tag::parse(["h", channel_id]).expect("message h tag"),
            Tag::parse(["p", &viewer.public_key().to_hex()]).expect("message p tag"),
        ])
        .custom_created_at(Timestamp::from(12))
        .sign_with_keys(&author)
        .expect("sign message");
    let message_id = message.id.to_hex();
    let reply = EventBuilder::new(Kind::Custom(9), "projected thread reply")
        .tags([
            Tag::parse(["h", channel_id]).expect("reply h tag"),
            Tag::parse(["e", &message_id, "", "reply"]).expect("reply e tag"),
        ])
        .custom_created_at(Timestamp::from(13))
        .sign_with_keys(&author)
        .expect("sign reply");
    let reaction = EventBuilder::new(Kind::Custom(7), "👍")
        .tags([Tag::parse(["e", &message_id]).expect("reaction e tag")])
        .custom_created_at(Timestamp::from(14))
        .sign_with_keys(&viewer)
        .expect("sign reaction");

    let bridge = ClientStateBridge::open(
        directory.path().join("state.db"),
        "https://buzz.test",
        viewer.public_key().to_hex(),
    )
    .expect("open bridge");
    let apply = response(
        &serde_json::json!({
            "op": "apply",
            "events": [metadata, membership, message, reply, reaction],
        })
        .to_string(),
        &bridge,
    );
    assert_eq!(apply["ok"], true);
    assert_eq!(apply["value"]["inserted"], 5);

    for (request, expected_count) in [
        (
            serde_json::json!({"op": "channels", "members_only": true}),
            1,
        ),
        (
            serde_json::json!({"op": "channel_messages", "channel_id": channel_id, "cursor": null, "limit": 20}),
            1,
        ),
        (
            serde_json::json!({"op": "channel_events", "channel_id": channel_id, "limit": 500}),
            5,
        ),
        (serde_json::json!({"op": "activity", "limit": 20}), 1),
        (
            serde_json::json!({"op": "search", "text": "instant sea", "limit": 20}),
            1,
        ),
    ] {
        let result = response(&request.to_string(), &bridge);
        assert_eq!(result["ok"], true, "request failed: {request}");
        assert_eq!(
            result["value"].as_array().map(Vec::len),
            Some(expected_count)
        );
    }

    let thread = response(
        &serde_json::json!({"op": "thread", "root_id": message_id, "limit": 20}).to_string(),
        &bridge,
    );
    assert_eq!(thread["ok"], true);
    assert_eq!(thread["value"]["replies"].as_array().map(Vec::len), Some(1));
    assert_eq!(thread["value"]["root"]["reactions"][0]["emoji"], "👍");

    let thread_events = response(
        &serde_json::json!({"op": "thread_events", "root_id": message_id, "limit": 500})
            .to_string(),
        &bridge,
    );
    assert_eq!(thread_events["ok"], true);
    assert_eq!(thread_events["value"].as_array().map(Vec::len), Some(3));
}

#[test]
fn json_bridge_returns_errors_without_panicking() {
    let directory = tempfile::tempdir().expect("create temp directory");
    let viewer = Keys::generate();
    let bridge = ClientStateBridge::open(
        directory.path().join("state.db"),
        "https://buzz.test",
        viewer.public_key().to_hex(),
    )
    .expect("open bridge");
    let result = response("{\"op\":\"not-real\"}", &bridge);
    assert_eq!(result["ok"], false);
    assert!(result["error"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
}
