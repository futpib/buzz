//! View-shaped newest-first thread pages for bridge clients.

use axum::{http::StatusCode, response::Json};
use serde_json::Value;

use buzz_core::{
    kind::{KIND_THREAD_SUMMARY, KIND_WINDOW_BOUNDS},
    TenantContext,
};

use crate::state::AppState;

use super::{
    api_error, build_aux_query, event_in_accessible_channel, extension_flag, extract_before_id,
    extract_channel_from_filter, extract_depth_limit, internal_error, query_all_pages, AuxReader,
    BeforeId, AUX_PAGE_LIMIT, BRIDGE_THREAD_MAX_LIMIT, WINDOW_AUX_DELETE_KINDS, WINDOW_AUX_KINDS,
};

const DEFAULT_LIMIT: u32 = 100;

fn extract_event_id(raw: &Value, key: &str) -> Result<Option<Vec<u8>>, (StatusCode, Json<Value>)> {
    let Some(value) = raw.get(key) else {
        return Ok(None);
    };
    let decoded = value
        .as_str()
        .filter(|encoded| encoded.len() == 64)
        .and_then(|encoded| hex::decode(encoded).ok())
        .filter(|bytes| bytes.len() == 32)
        .ok_or_else(|| {
            api_error(
                StatusCode::BAD_REQUEST,
                &format!("thread_window: {key} must be a 64-hex event id"),
            )
        })?;
    Ok(Some(decoded))
}

/// Serve one `thread_window: true` filter as rows, optional aux closure, and
/// exactly one relay-signed bounds overlay.
pub(super) async fn handle(
    state: &AppState,
    tenant: &TenantContext,
    raw: &Value,
    filter: &nostr::Filter,
    accessible_channels: &[uuid::Uuid],
    authed_pubkey_hex: &str,
    events: &mut Vec<Value>,
) -> Result<(), (StatusCode, Json<Value>)> {
    let Some(channel_id) = extract_channel_from_filter(filter) else {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "thread_window requires exactly one #h channel",
        ));
    };
    if !accessible_channels.contains(&channel_id) {
        return Ok(());
    }

    let e_tag = nostr::SingleLetterTag::lowercase(nostr::Alphabet::E);
    let root_hex = filter
        .generic_tags
        .get(&e_tag)
        .filter(|values| values.len() == 1)
        .and_then(|values| values.iter().next())
        .ok_or_else(|| {
            api_error(
                StatusCode::BAD_REQUEST,
                "thread_window requires exactly one #e root",
            )
        })?;
    let root_id = hex::decode(root_hex)
        .ok()
        .filter(|bytes| bytes.len() == 32)
        .ok_or_else(|| {
            api_error(
                StatusCode::BAD_REQUEST,
                "thread_window root must be a 64-hex event id",
            )
        })?;
    let parent_id = extract_event_id(raw, "thread_parent")?.unwrap_or_else(|| root_id.clone());
    let parent_hex = hex::encode(&parent_id);

    let before_id = match extract_before_id(raw) {
        BeforeId::Malformed => {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "thread_window: before_id must be a 64-hex event id",
            ));
        }
        BeforeId::Valid(id) => Some(id),
        BeforeId::Absent => None,
    };
    let cursor = match (filter.until, before_id) {
        (Some(created_at), Some(event_id)) => {
            let created_at = chrono::DateTime::from_timestamp(created_at.as_secs() as i64, 0)
                .ok_or_else(|| {
                    api_error(
                        StatusCode::BAD_REQUEST,
                        "thread_window: until is out of range",
                    )
                })?;
            Some((created_at, event_id))
        }
        (None, None) => None,
        _ => {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "thread_window cursor requires both until and before_id, or neither",
            ));
        }
    };

    let limit = filter
        .limit
        .map(|value| (value as u32).min(BRIDGE_THREAD_MAX_LIMIT))
        .unwrap_or(DEFAULT_LIMIT)
        .max(1);
    let depth_limit = extract_depth_limit(raw).unwrap_or(64);
    let kind_filter = filter.kinds.as_ref().map(|kinds| {
        kinds
            .iter()
            .map(|kind| kind.as_u16() as u32)
            .collect::<Vec<_>>()
    });
    let (window, mut session) = state
        .db
        .get_thread_window_with_session(buzz_db::thread_window::ThreadWindowQuery {
            community_id: tenant.community(),
            channel_id,
            root_event_id: &root_id,
            parent_event_id: &parent_id,
            depth_limit: Some(depth_limit),
            limit,
            cursor: cursor.clone(),
            kind_filter: kind_filter.as_deref(),
        })
        .await
        .map_err(|error| internal_error(&format!("thread window error: {error}")))?;

    let mut target_ids = Vec::with_capacity(window.rows.len() + 1);
    target_ids.push(parent_hex.clone());
    let mut root_query = buzz_db::EventQuery::for_community(tenant.community());
    root_query.channel_id = Some(channel_id);
    root_query.ids = Some(vec![parent_id.clone()]);
    root_query.limit = Some(1);
    let roots = session
        .query_events(&root_query)
        .await
        .map_err(|error| internal_error(&format!("thread window root error: {error}")))?;
    if let Some(root) = roots.into_iter().next() {
        if buzz_core::filter::reader_authorized_for_event(&root.event, authed_pubkey_hex) {
            events.push(serde_json::to_value(&root.event).map_err(|error| {
                internal_error(&format!("thread window root serialize: {error}"))
            })?);
        }
    }
    for row in &window.rows {
        if !event_in_accessible_channel(&row.stored_event, accessible_channels)
            || !buzz_core::filter::reader_authorized_for_event(
                &row.stored_event.event,
                authed_pubkey_hex,
            )
        {
            continue;
        }
        target_ids.push(row.stored_event.event.id.to_hex());
        events.push(
            serde_json::to_value(&row.stored_event.event).map_err(|error| {
                internal_error(&format!("thread window row serialize: {error}"))
            })?,
        );
    }

    if extension_flag(raw, "include_aux") && !target_ids.is_empty() {
        let mut seen = std::collections::HashSet::new();
        let mut hop_ids = target_ids;
        for kinds in [&WINDOW_AUX_KINDS[..], &WINDOW_AUX_DELETE_KINDS[..]] {
            let query = build_aux_query(tenant.community(), std::mem::take(&mut hop_ids), kinds);
            let aux = query_all_pages(query, AUX_PAGE_LIMIT, &mut AuxReader::Session(&mut session))
                .await
                .map_err(|error| internal_error(&format!("thread window aux error: {error}")))?;
            for stored in aux {
                if !seen.insert(stored.event.id)
                    || !event_in_accessible_channel(&stored, accessible_channels)
                    || !buzz_core::filter::reader_authorized_for_event(
                        &stored.event,
                        authed_pubkey_hex,
                    )
                {
                    continue;
                }
                hop_ids.push(stored.event.id.to_hex());
                events.push(serde_json::to_value(&stored.event).map_err(|error| {
                    internal_error(&format!("thread window aux serialize: {error}"))
                })?);
            }
            if hop_ids.is_empty() {
                break;
            }
        }
    }

    for row in &window.rows {
        let Some(summary) = &row.thread_summary else {
            continue;
        };
        let event_id = row.stored_event.event.id.to_hex();
        let content = serde_json::json!({
            "reply_count": summary.reply_count,
            "descendant_count": summary.descendant_count,
            "last_reply_at": summary.last_reply_at.map(|value| value.timestamp()),
            "participants": summary.participants.iter().map(hex::encode).collect::<Vec<_>>(),
        });
        let tags = [
            nostr::Tag::parse(["d", &event_id]),
            nostr::Tag::parse(["e", &event_id]),
            nostr::Tag::parse(["h", &channel_id.to_string()]),
        ]
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| internal_error(&format!("thread summary tag: {error}")))?;
        let overlay = nostr::EventBuilder::new(
            nostr::Kind::Custom(KIND_THREAD_SUMMARY as u16),
            content.to_string(),
        )
        .tags(tags)
        .sign_with_keys(&state.relay_keypair)
        .map_err(|error| internal_error(&format!("thread summary sign: {error}")))?;
        events.push(
            serde_json::to_value(&overlay)
                .map_err(|error| internal_error(&format!("thread summary serialize: {error}")))?,
        );
    }

    let cursor_suffix = match &cursor {
        Some((created_at, event_id)) => {
            format!("{}:{}", created_at.timestamp(), hex::encode(event_id))
        }
        None => "head".to_owned(),
    };
    let d_value = format!("thread:{channel_id}:{root_hex}:{parent_hex}:{cursor_suffix}");
    let content = serde_json::json!({
        "has_more": window.has_more,
        "next_cursor": window.next_cursor.as_ref().map(|(created_at, event_id)| serde_json::json!({
            "created_at": created_at.timestamp(),
            "id": hex::encode(event_id),
        })),
    });
    let tags = [
        nostr::Tag::parse(["d", &d_value]),
        nostr::Tag::parse(["e", root_hex]),
        nostr::Tag::parse(["h", &channel_id.to_string()]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| internal_error(&format!("thread window bounds tag: {error}")))?;
    let overlay = nostr::EventBuilder::new(
        nostr::Kind::Custom(KIND_WINDOW_BOUNDS as u16),
        content.to_string(),
    )
    .tags(tags)
    .sign_with_keys(&state.relay_keypair)
    .map_err(|error| internal_error(&format!("thread window bounds sign: {error}")))?;
    events
        .push(serde_json::to_value(&overlay).map_err(|error| {
            internal_error(&format!("thread window bounds serialize: {error}"))
        })?);
    Ok(())
}
