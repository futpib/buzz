//! Read effective message text so edits can resolve or supersede requests.
use super::*;

pub(super) async fn load(config: &Config, key: ThreadKey) -> Result<Vec<Event>> {
    let mut events = load_thread(config, key.channel_id, key.root_event_id).await?;
    let ids = events
        .iter()
        .map(|event| event.id.to_hex())
        .collect::<Vec<_>>();
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        config.owner_auth_tag.as_ref(),
    )
    .await?;
    for chunk in ids.chunks(200) {
        let mut cursor: Option<ThreadPageCursor> = None;
        loop {
            let mut filter = serde_json::to_value(
                Filter::new()
                    .kind(Kind::Custom(KIND_STREAM_MESSAGE_EDIT as u16))
                    .custom_tags(
                        SingleLetterTag::lowercase(Alphabet::H),
                        [key.channel_id.to_string()],
                    )
                    .custom_tags(
                        SingleLetterTag::lowercase(Alphabet::E),
                        chunk.iter().cloned(),
                    )
                    .limit(THREAD_PAGE_SIZE),
            )?;
            if let Some(cursor) = &cursor {
                filter["until"] = json!(cursor.created_at);
                filter["before_id"] = json!(cursor.event_id);
            }
            connection
                .send_raw(&json!(["REQ", "turn-judge-edits", filter]))
                .await?;
            let mut count = 0;
            let mut next = None;
            loop {
                match connection.next_event(THREAD_QUERY_TIMEOUT).await? {
                    RelayMessage::Event {
                        subscription_id,
                        event,
                    } if subscription_id == "turn-judge-edits" => {
                        event.verify()?;
                        count += 1;
                        update_thread_page_cursor(
                            &mut next,
                            event.created_at.as_secs(),
                            event.id.to_hex(),
                        );
                        if events.len() >= MAX_THREAD_EVENTS {
                            bail!("completion thread exceeds event limit");
                        }
                        events.push(*event);
                    }
                    RelayMessage::Eose { subscription_id }
                        if subscription_id == "turn-judge-edits" =>
                    {
                        break
                    }
                    RelayMessage::Closed {
                        subscription_id,
                        message,
                    } if subscription_id == "turn-judge-edits" => {
                        bail!("edit query closed: {message}")
                    }
                    _ => {}
                }
            }
            if count < THREAD_PAGE_SIZE {
                break;
            }
            if next.is_none() || next == cursor {
                bail!("edit query cursor did not advance");
            }
            cursor = next;
        }
    }
    let _ = connection.disconnect().await;
    Ok(events)
}

// Refresh the actual root receipts before replacing a verdict. The latest
// reaction can outlive the coordinator's recent-history startup window.
pub(super) async fn receipts(config: &Config, key: ThreadKey) -> Result<Vec<Event>> {
    let mut connection = NostrWsConnection::connect_authenticated(
        &config.relay_url,
        &config.bot_keys,
        config.owner_auth_tag.as_ref(),
    )
    .await?;
    let mut events = Vec::new();
    for (kinds, target_tag) in [
        (vec![Kind::Reaction], Alphabet::E),
        (vec![Kind::EventDeletion, Kind::Custom(9005)], Alphabet::S),
    ] {
        let mut cursor: Option<ThreadPageCursor> = None;
        loop {
            let mut filter = serde_json::to_value(
                Filter::new()
                    .kinds(kinds.clone())
                    .author(config.bot_keys.public_key())
                    .custom_tags(
                        SingleLetterTag::lowercase(Alphabet::H),
                        [key.channel_id.to_string()],
                    )
                    .custom_tags(
                        SingleLetterTag::lowercase(target_tag),
                        [key.root_event_id.to_hex()],
                    )
                    .limit(THREAD_PAGE_SIZE),
            )?;
            if let Some(cursor) = &cursor {
                filter["until"] = json!(cursor.created_at);
                filter["before_id"] = json!(cursor.event_id);
            }
            connection
                .send_raw(&json!(["REQ", "turn-judge-receipts", filter]))
                .await?;
            let mut count = 0;
            let mut next = None;
            loop {
                match connection.next_event(THREAD_QUERY_TIMEOUT).await? {
                    RelayMessage::Event {
                        subscription_id,
                        event,
                    } if subscription_id == "turn-judge-receipts" => {
                        event.verify()?;
                        count += 1;
                        update_thread_page_cursor(
                            &mut next,
                            event.created_at.as_secs(),
                            event.id.to_hex(),
                        );
                        events.push(*event);
                        if events.len() >= MAX_THREAD_EVENTS {
                            bail!(
                                "turn receipts exceed query limit; refusing an incomplete recovery"
                            );
                        }
                    }
                    RelayMessage::Eose { subscription_id }
                        if subscription_id == "turn-judge-receipts" =>
                    {
                        break
                    }
                    RelayMessage::Closed {
                        subscription_id,
                        message,
                    } if subscription_id == "turn-judge-receipts" => {
                        bail!("turn receipt query closed: {message}")
                    }
                    _ => {}
                }
            }
            if count < THREAD_PAGE_SIZE {
                break;
            }
            if next.is_none() || next == cursor {
                bail!("turn receipt cursor did not advance");
            }
            cursor = next;
        }
    }
    let _ = connection.disconnect().await;
    Ok(events)
}

pub(super) fn effective_messages(events: &[Event]) -> Vec<Event> {
    let mut messages = events
        .iter()
        .filter(|event| event.kind == Kind::Custom(9))
        .map(|event| (event.id, event.clone()))
        .collect::<HashMap<_, _>>();
    let mut revisions = HashMap::new();
    for edit in events
        .iter()
        .filter(|event| event.kind == Kind::Custom(KIND_STREAM_MESSAGE_EDIT as u16))
    {
        let Some(target) =
            unique_event_tag_value(edit, "e").and_then(|id| EventId::from_hex(id).ok())
        else {
            continue;
        };
        let Some(original) = messages.get_mut(&target) else {
            continue;
        };
        if edit.pubkey != original.pubkey && !is_same_owner_agent(original, &edit.pubkey) {
            continue;
        }
        let revision = (edit.created_at, edit.id);
        if revisions
            .get(&target)
            .is_some_and(|previous| *previous >= revision)
        {
            continue;
        }
        revisions.insert(target, revision);
        // These are context projections, never republished signed events.
        original.content.clone_from(&edit.content);
        let tags = original
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) != Some("imeta"))
            .cloned()
            .chain(
                edit.tags
                    .iter()
                    .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("imeta"))
                    .cloned(),
            )
            .collect::<Vec<_>>();
        original.tags = nostr::Tags::from_list(tags);
    }
    messages.into_values().collect()
}
