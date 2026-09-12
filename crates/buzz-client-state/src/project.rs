use std::collections::{BTreeSet, HashSet};

use buzz_core::{kind, nip10, verify_event, Event};
use rusqlite::{params, OptionalExtension, Transaction};

use crate::{
    model::{ApplyStats, ProjectionScope, ReadMarker},
    store::ClientStateError,
};

pub(crate) const MESSAGE_KINDS_SQL: &str =
    "9,40001,40002,40008,40099,43001,43002,43003,43004,43005,43006,45001,45003,48100,48103";

pub(crate) fn apply_events(
    conn: &mut rusqlite::Connection,
    scope: &ProjectionScope,
    events: Vec<Event>,
) -> Result<ApplyStats, ClientStateError> {
    let mut stats = ApplyStats::default();
    let mut relevant = Vec::with_capacity(events.len());
    for event in events {
        if is_relevant_kind(event.kind.as_u16() as u32) {
            verify_event(&event)?;
            relevant.push(event);
        } else {
            stats.ignored += 1;
        }
    }

    let tx = conn.transaction()?;
    ensure_scope(&tx, scope)?;
    for event in relevant {
        if insert_event(&tx, scope, &event)? {
            stats.inserted += 1;
        } else {
            stats.duplicates += 1;
        }
    }
    if stats.inserted > 0 {
        tx.execute(
            "UPDATE projection_meta SET revision=revision+1 WHERE scope=?1",
            [scope.key()],
        )?;
    }
    stats.revision = revision(&tx, scope)?;
    tx.commit()?;
    Ok(stats)
}

pub(crate) fn apply_read_markers(
    conn: &mut rusqlite::Connection,
    scope: &ProjectionScope,
    markers: Vec<ReadMarker>,
) -> Result<u64, ClientStateError> {
    let tx = conn.transaction()?;
    ensure_scope(&tx, scope)?;
    let mut affected_channels = BTreeSet::new();
    let mut changed = false;

    for marker in markers {
        let read_at = i64::try_from(marker.read_at)
            .map_err(|_| ClientStateError::InvalidTimestamp(marker.read_at))?;
        let rows = tx.execute(
            "INSERT INTO read_markers(scope, context_id, read_at) VALUES(?1, ?2, ?3)
             ON CONFLICT(scope, context_id) DO UPDATE SET read_at=excluded.read_at
             WHERE excluded.read_at > read_markers.read_at",
            params![scope.key(), marker.context_id, read_at],
        )?;
        if rows == 0 {
            continue;
        }
        changed = true;
        collect_marker_channels(&tx, scope, &marker.context_id, &mut affected_channels)?;
    }

    for channel_id in affected_channels {
        recompute_unread(&tx, scope, &channel_id)?;
        refresh_channel_rollup(&tx, scope, &channel_id)?;
    }
    if changed {
        tx.execute(
            "UPDATE projection_meta SET revision=revision+1 WHERE scope=?1",
            [scope.key()],
        )?;
    }
    let current = revision(&tx, scope)?;
    tx.commit()?;
    Ok(current)
}

pub(crate) fn current_revision(
    conn: &mut rusqlite::Connection,
    scope: &ProjectionScope,
) -> Result<u64, ClientStateError> {
    let tx = conn.transaction()?;
    ensure_scope(&tx, scope)?;
    let current = revision(&tx, scope)?;
    tx.commit()?;
    Ok(current)
}

fn ensure_scope(tx: &Transaction<'_>, scope: &ProjectionScope) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO projection_meta(scope, revision) VALUES(?1, 0)",
        [scope.key()],
    )?;
    Ok(())
}

fn revision(tx: &Transaction<'_>, scope: &ProjectionScope) -> rusqlite::Result<u64> {
    tx.query_row(
        "SELECT revision FROM projection_meta WHERE scope=?1",
        [scope.key()],
        |row| row.get(0),
    )
}

fn insert_event(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    event: &Event,
) -> Result<bool, ClientStateError> {
    let scope_key = scope.key();
    let kind = event.kind.as_u16() as u32;
    let event_id = event.id.to_hex();
    let pubkey = event.pubkey.to_hex().to_ascii_lowercase();
    let created_at = i64::try_from(event.created_at.as_secs())
        .map_err(|_| ClientStateError::InvalidTimestamp(event.created_at.as_secs()))?;
    let h_tag = tag_value(event, "h");
    let d_tag = tag_value(event, "d");
    let channel_id = if matches!(
        kind,
        kind::KIND_NIP29_GROUP_METADATA | kind::KIND_NIP29_GROUP_MEMBERS
    ) {
        d_tag.clone()
    } else {
        h_tag
    };
    let target_id = last_tag_value(event, "e");
    let thread = nip10::parse_thread_markers(&event.tags).resolve();
    let (root_id, parent_id) = thread
        .map(|(root, parent)| (Some(root), Some(parent)))
        .unwrap_or((None, None));
    let broadcast = has_tag_value(event, "broadcast", "1");
    let tags_json = serde_json::to_string(&event.tags)?;
    let deleted = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM deleted_events WHERE scope=?1 AND target_event_id=?2)",
        params![scope_key, event_id],
        |row| row.get::<_, bool>(0),
    )?;

    let inserted = tx.execute(
        "INSERT OR IGNORE INTO events(
           scope, event_id, pubkey, created_at, kind, channel_id, target_id,
           root_id, parent_id, broadcast, content, tags_json, sig, deleted
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            scope_key,
            event_id,
            pubkey,
            created_at,
            i64::from(kind),
            channel_id,
            target_id,
            root_id,
            parent_id,
            broadcast,
            event.content,
            tags_json,
            event.sig.to_string(),
            deleted,
        ],
    )? > 0;
    if !inserted {
        return Ok(false);
    }

    for mentioned in tag_values(event, "p") {
        tx.execute(
            "INSERT OR IGNORE INTO event_mentions(scope, event_id, pubkey) VALUES(?1, ?2, ?3)",
            params![scope.key(), event_id, mentioned.to_ascii_lowercase()],
        )?;
    }

    if deleted {
        return Ok(true);
    }

    match kind {
        kind::KIND_NIP29_GROUP_METADATA => project_channel_metadata(tx, scope, event)?,
        kind::KIND_NIP29_GROUP_MEMBERS => project_membership(tx, scope, event)?,
        kind::KIND_DELETION | kind::KIND_NIP29_DELETE_EVENT => project_deletion(tx, scope, event)?,
        kind::KIND_STREAM_MESSAGE_EDIT => project_edit(tx, scope, event)?,
        kind::KIND_REACTION => project_reaction(tx, scope, event)?,
        _ if is_message_kind(kind) => project_message(tx, scope, event)?,
        _ => {}
    }
    Ok(true)
}

fn project_channel_metadata(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    event: &Event,
) -> Result<(), ClientStateError> {
    let Some(channel_id) = tag_value(event, "d") else {
        return Ok(());
    };
    let incoming_id = event.id.to_hex();
    let incoming_at = event.created_at.as_secs() as i64;
    let existing = tx
        .query_row(
            "SELECT metadata_created_at, metadata_event_id FROM channels
             WHERE scope=?1 AND channel_id=?2",
            params![scope.key(), channel_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if existing
        .as_ref()
        .is_some_and(|(at, id)| !incoming_wins(incoming_at, &incoming_id, *at, id))
    {
        return Ok(());
    }

    let explicit_type = tag_value(event, "t");
    let channel_type = explicit_type.unwrap_or_else(|| {
        if has_tag(event, "hidden") {
            "dm".to_string()
        } else {
            "stream".to_string()
        }
    });
    let visibility = if has_tag(event, "private") {
        "private"
    } else {
        "open"
    };
    let pending = tx
        .query_row(
            "SELECT event_id, created_at, is_member, member_count FROM pending_memberships
             WHERE scope=?1 AND channel_id=?2",
            params![scope.key(), channel_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, u32>(3)?,
                ))
            },
        )
        .optional()?;
    let (membership_id, membership_at, is_member, member_count) = pending
        .map(|(id, at, member, count)| (Some(id), Some(at), member, count))
        .unwrap_or((None, None, false, 0));

    tx.execute(
        "INSERT INTO channels(
           scope, channel_id, metadata_event_id, metadata_created_at, name,
           channel_type, visibility, description, topic, archived, is_member,
           member_count, membership_event_id, membership_created_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(scope, channel_id) DO UPDATE SET
           metadata_event_id=excluded.metadata_event_id,
           metadata_created_at=excluded.metadata_created_at,
           name=excluded.name,
           channel_type=excluded.channel_type,
           visibility=excluded.visibility,
           description=excluded.description,
           topic=excluded.topic,
           archived=excluded.archived",
        params![
            scope.key(),
            channel_id,
            incoming_id,
            incoming_at,
            tag_value(event, "name").unwrap_or_default(),
            channel_type,
            visibility,
            tag_value(event, "about").unwrap_or_default(),
            tag_value(event, "topic"),
            has_tag_value(event, "archived", "true"),
            is_member,
            member_count,
            membership_id,
            membership_at,
        ],
    )?;
    refresh_channel_rollup(tx, scope, &channel_id)?;
    Ok(())
}

fn project_membership(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    event: &Event,
) -> Result<(), ClientStateError> {
    let Some(channel_id) = tag_value(event, "d") else {
        return Ok(());
    };
    let incoming_id = event.id.to_hex();
    let incoming_at = event.created_at.as_secs() as i64;
    let mut members = HashSet::new();
    for pubkey in tag_values(event, "p") {
        members.insert(pubkey.to_ascii_lowercase());
    }
    let is_member = members.contains(&scope.viewer_pubkey);
    let member_count = members.len() as u32;

    let existing = tx
        .query_row(
            "SELECT created_at, event_id FROM pending_memberships
             WHERE scope=?1 AND channel_id=?2",
            params![scope.key(), channel_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if existing
        .as_ref()
        .is_some_and(|(at, id)| !incoming_wins(incoming_at, &incoming_id, *at, id))
    {
        return Ok(());
    }

    tx.execute(
        "INSERT INTO pending_memberships(
           scope, channel_id, event_id, created_at, is_member, member_count
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(scope, channel_id) DO UPDATE SET
           event_id=excluded.event_id,
           created_at=excluded.created_at,
           is_member=excluded.is_member,
           member_count=excluded.member_count",
        params![
            scope.key(),
            channel_id,
            incoming_id,
            incoming_at,
            is_member,
            member_count
        ],
    )?;
    tx.execute(
        "UPDATE channels SET
           is_member=?3, member_count=?4, membership_event_id=?5, membership_created_at=?6
         WHERE scope=?1 AND channel_id=?2",
        params![
            scope.key(),
            channel_id,
            is_member,
            member_count,
            incoming_id,
            incoming_at
        ],
    )?;
    Ok(())
}

fn project_message(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    event: &Event,
) -> Result<(), ClientStateError> {
    let Some(channel_id) = tag_value(event, "h") else {
        return Ok(());
    };
    let event_id = event.id.to_hex();
    let root_id = nip10::parse_thread_markers(&event.tags)
        .resolve()
        .map(|(root, _)| root);
    if is_unread_kind(event.kind.as_u16() as u32) {
        let unread = event.pubkey.to_hex().to_ascii_lowercase() != scope.viewer_pubkey
            && is_unread(
                tx,
                scope,
                &channel_id,
                &event_id,
                root_id.as_deref(),
                event.created_at.as_secs() as i64,
            )?;
        tx.execute(
            "INSERT OR REPLACE INTO unread_events(
               scope, event_id, channel_id, root_id, created_at, unread
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                scope.key(),
                event_id,
                channel_id,
                root_id,
                event.created_at.as_secs() as i64,
                unread
            ],
        )?;
    }
    replace_search_row(tx, scope, &event_id)?;
    if let Some(root_id) = root_id {
        rebuild_thread_summary(tx, scope, &root_id)?;
    }
    refresh_channel_rollup(tx, scope, &channel_id)?;
    Ok(())
}

fn project_edit(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    event: &Event,
) -> Result<(), ClientStateError> {
    let Some(target_id) = last_tag_value(event, "e") else {
        return Ok(());
    };
    let incoming_id = event.id.to_hex();
    let incoming_at = event.created_at.as_secs() as i64;
    let existing = tx
        .query_row(
            "SELECT edit_created_at, edit_event_id FROM message_edits
             WHERE scope=?1 AND target_event_id=?2",
            params![scope.key(), target_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if existing
        .as_ref()
        .is_some_and(|(at, id)| !incoming_wins(incoming_at, &incoming_id, *at, id))
    {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO message_edits(
           scope, target_event_id, edit_event_id, edit_created_at, content, tags_json
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(scope, target_event_id) DO UPDATE SET
           edit_event_id=excluded.edit_event_id,
           edit_created_at=excluded.edit_created_at,
           content=excluded.content,
           tags_json=excluded.tags_json",
        params![
            scope.key(),
            target_id,
            incoming_id,
            incoming_at,
            event.content,
            serde_json::to_string(&event.tags)?
        ],
    )?;
    replace_search_row(tx, scope, &target_id)?;
    Ok(())
}

fn project_reaction(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    event: &Event,
) -> Result<(), ClientStateError> {
    let Some(target_id) = last_tag_value(event, "e") else {
        return Ok(());
    };
    let emoji = event.content.trim();
    if emoji.is_empty() {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO reactions(
           scope, reaction_event_id, target_event_id, pubkey, emoji, created_at, deleted
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, 0)",
        params![
            scope.key(),
            event.id.to_hex(),
            target_id,
            event.pubkey.to_hex().to_ascii_lowercase(),
            emoji,
            event.created_at.as_secs() as i64
        ],
    )?;
    Ok(())
}

fn project_deletion(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    event: &Event,
) -> Result<(), ClientStateError> {
    for target_id in tag_values(event, "e") {
        if target_id.len() != 64 || !target_id.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO deleted_events(
               scope, target_event_id, deletion_event_id, deleted_at
             ) VALUES(?1, ?2, ?3, ?4)",
            params![
                scope.key(),
                target_id,
                event.id.to_hex(),
                event.created_at.as_secs() as i64
            ],
        )?;
        let target = tx
            .query_row(
                "SELECT kind, channel_id, root_id, target_id FROM events
                 WHERE scope=?1 AND event_id=?2",
                params![scope.key(), target_id],
                |row| {
                    Ok((
                        row.get::<_, u32>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;
        tx.execute(
            "UPDATE events SET deleted=1 WHERE scope=?1 AND event_id=?2",
            params![scope.key(), target_id],
        )?;
        tx.execute(
            "UPDATE reactions SET deleted=1 WHERE scope=?1 AND reaction_event_id=?2",
            params![scope.key(), target_id],
        )?;
        tx.execute(
            "DELETE FROM unread_events WHERE scope=?1 AND event_id=?2",
            params![scope.key(), target_id],
        )?;
        tx.execute(
            "DELETE FROM event_search WHERE scope=?1 AND event_id=?2",
            params![scope.key(), target_id],
        )?;

        let Some((target_kind, channel_id, root_id, edit_target)) = target else {
            continue;
        };
        if target_kind == kind::KIND_STREAM_MESSAGE_EDIT {
            if let Some(edit_target) = edit_target {
                rebuild_edit(tx, scope, &edit_target)?;
            }
        }
        if target_kind == kind::KIND_NIP29_GROUP_METADATA {
            if let Some(channel_id) = channel_id.as_deref() {
                rebuild_channel_metadata(tx, scope, channel_id)?;
            }
        }
        if target_kind == kind::KIND_NIP29_GROUP_MEMBERS {
            if let Some(channel_id) = channel_id.as_deref() {
                rebuild_membership(tx, scope, channel_id)?;
            }
        }
        if let Some(root_id) = root_id.as_deref() {
            rebuild_thread_summary(tx, scope, root_id)?;
        }
        if let Some(channel_id) = channel_id.as_deref() {
            recompute_unread(tx, scope, channel_id)?;
            refresh_channel_rollup(tx, scope, channel_id)?;
        }
    }
    Ok(())
}

fn rebuild_edit(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    target_id: &str,
) -> Result<(), ClientStateError> {
    tx.execute(
        "DELETE FROM message_edits WHERE scope=?1 AND target_event_id=?2",
        params![scope.key(), target_id],
    )?;
    let candidate = tx
        .query_row(
            "SELECT event_id, created_at, content, tags_json FROM events
             WHERE scope=?1 AND kind=?2 AND target_id=?3 AND deleted=0
             ORDER BY created_at DESC, event_id ASC LIMIT 1",
            params![scope.key(), kind::KIND_STREAM_MESSAGE_EDIT, target_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    if let Some((event_id, created_at, content, tags_json)) = candidate {
        tx.execute(
            "INSERT INTO message_edits(
               scope, target_event_id, edit_event_id, edit_created_at, content, tags_json
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                scope.key(),
                target_id,
                event_id,
                created_at,
                content,
                tags_json
            ],
        )?;
    }
    replace_search_row(tx, scope, target_id)?;
    Ok(())
}

fn rebuild_channel_metadata(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    channel_id: &str,
) -> Result<(), ClientStateError> {
    tx.execute(
        "DELETE FROM channels WHERE scope=?1 AND channel_id=?2",
        params![scope.key(), channel_id],
    )?;
    let json = tx
        .query_row(
            "SELECT tags_json FROM events
             WHERE scope=?1 AND channel_id=?2 AND kind=?3 AND deleted=0
             ORDER BY created_at DESC, event_id ASC LIMIT 1",
            params![scope.key(), channel_id, kind::KIND_NIP29_GROUP_METADATA],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(json) = json {
        let event_id = tx.query_row(
            "SELECT event_id FROM events
             WHERE scope=?1 AND channel_id=?2 AND kind=?3 AND deleted=0
             ORDER BY created_at DESC, event_id ASC LIMIT 1",
            params![scope.key(), channel_id, kind::KIND_NIP29_GROUP_METADATA],
            |row| row.get::<_, String>(0),
        )?;
        let event = load_event(tx, scope, &event_id, &json)?;
        project_channel_metadata(tx, scope, &event)?;
    }
    Ok(())
}

fn rebuild_membership(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    channel_id: &str,
) -> Result<(), ClientStateError> {
    tx.execute(
        "DELETE FROM pending_memberships WHERE scope=?1 AND channel_id=?2",
        params![scope.key(), channel_id],
    )?;
    tx.execute(
        "UPDATE channels SET is_member=0, member_count=0,
           membership_event_id=NULL, membership_created_at=NULL
         WHERE scope=?1 AND channel_id=?2",
        params![scope.key(), channel_id],
    )?;
    let candidate = tx
        .query_row(
            "SELECT event_id, tags_json FROM events
             WHERE scope=?1 AND channel_id=?2 AND kind=?3 AND deleted=0
             ORDER BY created_at DESC, event_id ASC LIMIT 1",
            params![scope.key(), channel_id, kind::KIND_NIP29_GROUP_MEMBERS],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((event_id, tags_json)) = candidate {
        let event = load_event(tx, scope, &event_id, &tags_json)?;
        project_membership(tx, scope, &event)?;
    }
    Ok(())
}

fn load_event(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    event_id: &str,
    tags_json: &str,
) -> Result<Event, ClientStateError> {
    let (pubkey, created_at, kind, content, sig) = tx.query_row(
        "SELECT pubkey, created_at, kind, content, sig
         FROM events WHERE scope=?1 AND event_id=?2",
        params![scope.key(), event_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        },
    )?;
    let value = serde_json::json!({
        "id": event_id,
        "pubkey": pubkey,
        "created_at": created_at,
        "kind": kind,
        "tags": serde_json::from_str::<serde_json::Value>(tags_json)?,
        "content": content,
        "sig": sig,
    });
    Ok(serde_json::from_value(value)?)
}

fn replace_search_row(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    event_id: &str,
) -> Result<(), ClientStateError> {
    tx.execute(
        "DELETE FROM event_search WHERE scope=?1 AND event_id=?2",
        params![scope.key(), event_id],
    )?;
    let row = tx
        .query_row(
            "SELECT e.channel_id, COALESCE(m.content, e.content)
             FROM events e
             LEFT JOIN message_edits m
               ON m.scope=e.scope AND m.target_event_id=e.event_id
             WHERE e.scope=?1 AND e.event_id=?2 AND e.deleted=0
               AND e.kind IN (9, 40001, 40002, 45001, 45003)",
            params![scope.key(), event_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((Some(channel_id), content)) = row {
        tx.execute(
            "INSERT INTO event_search(scope, event_id, channel_id, content)
             VALUES(?1, ?2, ?3, ?4)",
            params![scope.key(), event_id, channel_id, content],
        )?;
    }
    Ok(())
}

fn rebuild_thread_summary(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    root_id: &str,
) -> rusqlite::Result<()> {
    let summary_sql = format!(
        "SELECT COUNT(*), MAX(created_at) FROM events
         WHERE scope=?1 AND root_id=?2 AND deleted=0
           AND kind IN ({MESSAGE_KINDS_SQL})"
    );
    let (count, last): (u32, Option<u64>) =
        tx.query_row(&summary_sql, params![scope.key(), root_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    tx.execute(
        "INSERT INTO thread_summaries(scope, root_id, reply_count, last_reply_at)
         VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(scope, root_id) DO UPDATE SET
           reply_count=excluded.reply_count, last_reply_at=excluded.last_reply_at",
        params![scope.key(), root_id, count, last],
    )?;
    tx.execute(
        "DELETE FROM thread_participants WHERE scope=?1 AND root_id=?2",
        params![scope.key(), root_id],
    )?;
    let participants_sql = format!(
        "INSERT INTO thread_participants(scope, root_id, pubkey, last_reply_at)
         SELECT scope, root_id, pubkey, MAX(created_at) FROM events
         WHERE scope=?1 AND root_id=?2 AND deleted=0
           AND kind IN ({MESSAGE_KINDS_SQL})
         GROUP BY scope, root_id, pubkey"
    );
    tx.execute(&participants_sql, params![scope.key(), root_id])?;
    Ok(())
}

fn recompute_unread(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    channel_id: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE unread_events AS u SET unread=CASE
           WHEN EXISTS(
             SELECT 1 FROM events e
             WHERE e.scope=u.scope AND e.event_id=u.event_id
               AND e.deleted=0 AND e.pubkey<>?3
           ) AND u.created_at > MAX(
             COALESCE((SELECT read_at FROM read_markers r
               WHERE r.scope=u.scope AND r.context_id=u.channel_id), -1),
             COALESCE((SELECT read_at FROM read_markers r
               WHERE r.scope=u.scope AND r.context_id='msg:' || u.event_id), -1),
             COALESCE((SELECT read_at FROM read_markers r
               WHERE r.scope=u.scope AND r.context_id='thread:' || u.root_id), -1)
           ) THEN 1 ELSE 0 END
         WHERE u.scope=?1 AND u.channel_id=?2",
        params![scope.key(), channel_id, scope.viewer_pubkey],
    )?;
    Ok(())
}

fn is_unread(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    channel_id: &str,
    event_id: &str,
    root_id: Option<&str>,
    created_at: i64,
) -> rusqlite::Result<bool> {
    let context_ids = [
        channel_id.to_string(),
        format!("msg:{event_id}"),
        root_id
            .map(|root| format!("thread:{root}"))
            .unwrap_or_default(),
    ];
    let read_at: Option<i64> = tx.query_row(
        "SELECT MAX(read_at) FROM read_markers
         WHERE scope=?1 AND context_id IN (?2, ?3, ?4)",
        params![scope.key(), context_ids[0], context_ids[1], context_ids[2]],
        |row| row.get(0),
    )?;
    Ok(read_at.is_none_or(|read_at| created_at > read_at))
}

fn refresh_channel_rollup(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    channel_id: &str,
) -> rusqlite::Result<()> {
    let latest = tx
        .query_row(
            "SELECT event_id, created_at FROM events
             WHERE scope=?1 AND channel_id=?2 AND deleted=0
               AND kind IN (9, 40001, 40002, 45001, 45003)
             ORDER BY created_at DESC, event_id ASC LIMIT 1",
            params![scope.key(), channel_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let unread: u32 = tx.query_row(
        "SELECT COUNT(*) FROM unread_events
         WHERE scope=?1 AND channel_id=?2 AND unread=1",
        params![scope.key(), channel_id],
        |row| row.get(0),
    )?;
    let (last_event_id, last_event_at) = latest
        .map(|(id, at)| (Some(id), Some(at)))
        .unwrap_or((None, None));
    tx.execute(
        "UPDATE channels SET last_event_id=?3, last_event_at=?4, unread_count=?5
         WHERE scope=?1 AND channel_id=?2",
        params![
            scope.key(),
            channel_id,
            last_event_id,
            last_event_at,
            unread
        ],
    )?;
    Ok(())
}

fn collect_marker_channels(
    tx: &Transaction<'_>,
    scope: &ProjectionScope,
    context_id: &str,
    channels: &mut BTreeSet<String>,
) -> rusqlite::Result<()> {
    if let Some(event_id) = context_id.strip_prefix("msg:") {
        if let Some(channel_id) = tx
            .query_row(
                "SELECT channel_id FROM events WHERE scope=?1 AND event_id=?2",
                params![scope.key(), event_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
        {
            channels.insert(channel_id);
        }
    } else if let Some(root_id) = context_id.strip_prefix("thread:") {
        let mut statement = tx.prepare(
            "SELECT DISTINCT channel_id FROM events
             WHERE scope=?1 AND (root_id=?2 OR event_id=?2) AND channel_id IS NOT NULL",
        )?;
        let rows = statement.query_map(params![scope.key(), root_id], |row| row.get(0))?;
        for row in rows {
            channels.insert(row?);
        }
    } else {
        channels.insert(context_id.to_string());
    }
    Ok(())
}

fn incoming_wins(incoming_at: i64, incoming_id: &str, old_at: i64, old_id: &str) -> bool {
    incoming_at > old_at || (incoming_at == old_at && incoming_id < old_id)
}

pub(crate) fn is_message_kind(kind: u32) -> bool {
    matches!(
        kind,
        kind::KIND_STREAM_MESSAGE
            | 40001
            | kind::KIND_STREAM_MESSAGE_V2
            | kind::KIND_STREAM_MESSAGE_DIFF
            | kind::KIND_SYSTEM_MESSAGE
            | kind::KIND_JOB_REQUEST
            | kind::KIND_JOB_ACCEPTED
            | kind::KIND_JOB_PROGRESS
            | kind::KIND_JOB_RESULT
            | kind::KIND_JOB_CANCEL
            | kind::KIND_JOB_ERROR
            | kind::KIND_FORUM_POST
            | kind::KIND_FORUM_COMMENT
            | kind::KIND_HUDDLE_STARTED
            | kind::KIND_HUDDLE_ENDED
    )
}

fn is_unread_kind(kind: u32) -> bool {
    matches!(
        kind,
        kind::KIND_STREAM_MESSAGE
            | 40001
            | kind::KIND_STREAM_MESSAGE_V2
            | kind::KIND_FORUM_POST
            | kind::KIND_FORUM_COMMENT
    )
}

fn is_relevant_kind(kind: u32) -> bool {
    is_message_kind(kind)
        || matches!(
            kind,
            kind::KIND_TEXT_NOTE
                | kind::KIND_DELETION
                | kind::KIND_REACTION
                | kind::KIND_NIP29_DELETE_EVENT
                | kind::KIND_NIP29_GROUP_METADATA
                | kind::KIND_NIP29_GROUP_MEMBERS
                | kind::KIND_STREAM_MESSAGE_EDIT
                | kind::KIND_WORKFLOW_APPROVAL_REQUESTED
                | kind::KIND_WORKFLOW_APPROVAL_GRANTED
                | kind::KIND_WORKFLOW_APPROVAL_DENIED
        )
}

fn tag_value(event: &Event, key: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() >= 2 && parts[0] == key).then(|| parts[1].clone())
    })
}

fn last_tag_value(event: &Event, key: &str) -> Option<String> {
    event.tags.iter().rev().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() >= 2 && parts[0] == key).then(|| parts[1].clone())
    })
}

fn tag_values(event: &Event, key: &str) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() >= 2 && parts[0] == key).then(|| parts[1].clone())
        })
        .collect()
}

fn has_tag(event: &Event, key: &str) -> bool {
    event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().is_some_and(|part| part == key))
}

fn has_tag_value(event: &Event, key: &str, value: &str) -> bool {
    event.tags.iter().any(|tag| {
        let parts = tag.as_slice();
        parts.len() >= 2 && parts[0] == key && parts[1] == value
    })
}
