use std::collections::BTreeMap;

use rusqlite::{params, params_from_iter, Connection};

use crate::{
    model::{
        ActivityCategory, ActivityItem, ChannelListItem, Message, PageCursor, ProjectionScope,
        ReactionGroup, SearchHit, Thread,
    },
    project::MESSAGE_KINDS_SQL,
    store::ClientStateError,
};

const MESSAGE_COLUMNS: &str = "e.event_id, e.kind, e.pubkey, e.created_at,
     COALESCE(m.content, e.content), COALESCE(m.tags_json, e.tags_json),
     e.channel_id, e.root_id, e.parent_id, m.edit_event_id IS NOT NULL";

pub(crate) fn channels(
    conn: &Connection,
    scope: &ProjectionScope,
    members_only: bool,
) -> Result<Vec<ChannelListItem>, ClientStateError> {
    let mut statement = conn.prepare(
        "SELECT channel_id, name, channel_type, visibility, description, topic,
                archived, is_member, member_count, last_event_id, last_event_at, unread_count
         FROM channels
         WHERE scope=?1 AND (?2=0 OR is_member=1)
         ORDER BY archived ASC,
                  COALESCE(last_event_at, metadata_created_at) DESC,
                  name COLLATE NOCASE ASC, channel_id ASC",
    )?;
    let mut rows = statement.query(params![scope.key(), members_only])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(ChannelListItem {
            channel_id: row.get(0)?,
            name: row.get(1)?,
            channel_type: row.get(2)?,
            visibility: row.get(3)?,
            description: row.get(4)?,
            topic: row.get(5)?,
            archived: row.get(6)?,
            is_member: row.get(7)?,
            member_count: row.get(8)?,
            last_event_id: row.get(9)?,
            last_event_at: row.get(10)?,
            unread_count: row.get(11)?,
        });
    }
    Ok(result)
}

pub(crate) fn channel_messages(
    conn: &Connection,
    scope: &ProjectionScope,
    channel_id: &str,
    cursor: Option<&PageCursor>,
    limit: u32,
) -> Result<Vec<Message>, ClientStateError> {
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS}
         FROM events e
         LEFT JOIN message_edits m
           ON m.scope=e.scope AND m.target_event_id=e.event_id
         WHERE e.scope=?1 AND e.channel_id=?2 AND e.deleted=0
           AND e.kind IN ({MESSAGE_KINDS_SQL})
           AND (e.parent_id IS NULL OR e.broadcast=1)
           AND (?3 IS NULL OR e.created_at < ?3 OR (e.created_at=?3 AND e.event_id>?4))
         ORDER BY e.created_at DESC, e.event_id ASC LIMIT ?5"
    );
    let (cursor_at, cursor_id) = cursor
        .map(|value| {
            i64::try_from(value.created_at)
                .map(|created_at| (Some(created_at), value.event_id.as_str()))
                .map_err(|_| ClientStateError::InvalidTimestamp(value.created_at))
        })
        .transpose()?
        .unwrap_or((None, ""));
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![
        scope.key(),
        channel_id,
        cursor_at,
        cursor_id,
        i64::from(limit)
    ])?;
    let mut messages = read_messages(&mut rows)?;
    attach_reactions(conn, scope, &mut messages)?;
    Ok(messages)
}

pub(crate) fn thread(
    conn: &Connection,
    scope: &ProjectionScope,
    root_id: &str,
    limit: u32,
) -> Result<Thread, ClientStateError> {
    let root = message_by_id(conn, scope, root_id)?;
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS}
         FROM events e
         LEFT JOIN message_edits m
           ON m.scope=e.scope AND m.target_event_id=e.event_id
         WHERE e.scope=?1 AND e.root_id=?2 AND e.deleted=0
           AND e.kind IN ({MESSAGE_KINDS_SQL})
         ORDER BY e.created_at ASC, e.event_id ASC LIMIT ?3"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![scope.key(), root_id, i64::from(limit)])?;
    let mut replies = read_messages(&mut rows)?;
    attach_reactions(conn, scope, &mut replies)?;
    let summary = conn.query_row(
        "SELECT reply_count, last_reply_at FROM thread_summaries
         WHERE scope=?1 AND root_id=?2",
        params![scope.key(), root_id],
        |row| Ok((row.get::<_, u32>(0)?, row.get::<_, Option<u64>>(1)?)),
    );
    let (reply_count, last_reply_at) = match summary {
        Ok(summary) => summary,
        Err(rusqlite::Error::QueryReturnedNoRows) => (0, None),
        Err(error) => return Err(error.into()),
    };
    let mut participant_statement = conn.prepare(
        "SELECT pubkey FROM thread_participants
         WHERE scope=?1 AND root_id=?2
         ORDER BY last_reply_at DESC, pubkey ASC LIMIT 3",
    )?;
    let participant_rows =
        participant_statement.query_map(params![scope.key(), root_id], |row| row.get(0))?;
    let mut participant_pubkeys = Vec::new();
    for row in participant_rows {
        participant_pubkeys.push(row?);
    }
    Ok(Thread {
        root_id: root_id.to_string(),
        root,
        replies,
        reply_count,
        last_reply_at,
        participant_pubkeys,
    })
}

pub(crate) fn activity(
    conn: &Connection,
    scope: &ProjectionScope,
    limit: u32,
) -> Result<Vec<ActivityItem>, ClientStateError> {
    let sql = format!(
        "WITH categorized AS (
           SELECT e.*,
             CASE
               WHEN e.kind IN (46010,46011,46012) AND em.event_id IS NOT NULL THEN 0
               WHEN e.kind IN (1,9,40002,45001,45003)
                    AND em.event_id IS NOT NULL AND e.pubkey<>?2 THEN 1
               WHEN e.kind IN (43001,43002,43003,43004,43005,43006)
                    AND em.event_id IS NOT NULL THEN 2
               WHEN e.kind=9 AND c.channel_type='dm' AND e.pubkey<>?2 THEN 3
             END AS category,
             CASE
               WHEN e.root_id IS NOT NULL THEN e.root_id
               WHEN e.kind=9 AND c.channel_type='dm'
                 THEN 'dm:' || COALESCE(e.channel_id, '')
               ELSE e.event_id
             END AS conversation_id
           FROM events e
           LEFT JOIN event_mentions em
             ON em.scope=e.scope AND em.event_id=e.event_id AND em.pubkey=?2
           LEFT JOIN channels c
             ON c.scope=e.scope AND c.channel_id=e.channel_id
           WHERE e.scope=?1 AND e.deleted=0
         ), ranked AS (
           SELECT categorized.*,
             ROW_NUMBER() OVER (
               PARTITION BY conversation_id
               ORDER BY created_at DESC, event_id ASC
             ) AS conversation_position,
             MIN(category) OVER (PARTITION BY conversation_id) AS best_category,
             MAX(created_at) OVER (PARTITION BY conversation_id) AS latest_activity_at
           FROM categorized
           WHERE category IS NOT NULL
         )
         SELECT {MESSAGE_COLUMNS}, e.best_category, e.conversation_id,
                e.latest_activity_at
         FROM ranked e
         LEFT JOIN message_edits m
           ON m.scope=e.scope AND m.target_event_id=e.event_id
         WHERE e.conversation_position=1
         ORDER BY e.latest_activity_at DESC, e.event_id ASC LIMIT ?3"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![scope.key(), scope.viewer_pubkey, i64::from(limit)])?;
    let mut messages = Vec::new();
    let mut metadata = Vec::new();
    while let Some(row) = rows.next()? {
        messages.push(message_from_row(row)?);
        metadata.push((
            category_from_i64(row.get(10)?)?,
            row.get::<_, String>(11)?,
            row.get::<_, u64>(12)?,
        ));
    }
    attach_reactions(conn, scope, &mut messages)?;
    let mut result = Vec::with_capacity(messages.len());
    for (message, (category, conversation_id, latest_activity_at)) in
        messages.into_iter().zip(metadata)
    {
        let read = activity_is_read(conn, scope, &message, latest_activity_at)?;
        result.push(ActivityItem {
            conversation_id,
            message,
            category,
            latest_activity_at,
            read,
        });
    }
    Ok(result)
}

pub(crate) fn search(
    conn: &Connection,
    scope: &ProjectionScope,
    query: &str,
    limit: u32,
) -> Result<Vec<SearchHit>, ClientStateError> {
    let Some(match_query) = fts_query(query) else {
        return Ok(Vec::new());
    };
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS}, bm25(event_search)
         FROM event_search
         JOIN events e
           ON e.scope=event_search.scope AND e.event_id=event_search.event_id
         LEFT JOIN message_edits m
           ON m.scope=e.scope AND m.target_event_id=e.event_id
         WHERE event_search MATCH ?1 AND event_search.scope=?2 AND e.deleted=0
         ORDER BY bm25(event_search), e.created_at DESC, e.event_id ASC LIMIT ?3"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![match_query, scope.key(), i64::from(limit)])?;
    let mut hits = Vec::new();
    while let Some(row) = rows.next()? {
        hits.push(SearchHit {
            message: message_from_row(row)?,
            score: row.get(10)?,
        });
    }
    let mut messages = hits
        .iter()
        .map(|hit| hit.message.clone())
        .collect::<Vec<_>>();
    attach_reactions(conn, scope, &mut messages)?;
    for (hit, message) in hits.iter_mut().zip(messages) {
        hit.message = message;
    }
    Ok(hits)
}

fn message_by_id(
    conn: &Connection,
    scope: &ProjectionScope,
    event_id: &str,
) -> Result<Option<Message>, ClientStateError> {
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS}
         FROM events e
         LEFT JOIN message_edits m
           ON m.scope=e.scope AND m.target_event_id=e.event_id
         WHERE e.scope=?1 AND e.event_id=?2 AND e.deleted=0"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![scope.key(), event_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let mut message = message_from_row(row)?;
    attach_reactions(conn, scope, std::slice::from_mut(&mut message))?;
    Ok(Some(message))
}

fn read_messages(rows: &mut rusqlite::Rows<'_>) -> Result<Vec<Message>, ClientStateError> {
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(message_from_row(row)?);
    }
    Ok(result)
}

fn message_from_row(row: &rusqlite::Row<'_>) -> Result<Message, ClientStateError> {
    let tags_json: String = row.get(5)?;
    Ok(Message {
        event_id: row.get(0)?,
        kind: row.get(1)?,
        pubkey: row.get(2)?,
        created_at: row.get(3)?,
        content: row.get(4)?,
        tags: serde_json::from_str(&tags_json)?,
        channel_id: row.get(6)?,
        root_id: row.get(7)?,
        parent_id: row.get(8)?,
        edited: row.get(9)?,
        reactions: Vec::new(),
    })
}

fn attach_reactions(
    conn: &Connection,
    scope: &ProjectionScope,
    messages: &mut [Message],
) -> Result<(), ClientStateError> {
    if messages.is_empty() {
        return Ok(());
    }
    let placeholders = std::iter::repeat_n("?", messages.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT target_event_id, emoji, pubkey, reaction_event_id FROM (
           SELECT target_event_id, emoji, pubkey, reaction_event_id, deleted,
             ROW_NUMBER() OVER (
               PARTITION BY target_event_id, emoji, pubkey
               ORDER BY created_at DESC, reaction_event_id ASC
             ) AS position
           FROM reactions
           WHERE scope=? AND target_event_id IN ({placeholders})
         ) WHERE position=1 AND deleted=0
         ORDER BY target_event_id, emoji, pubkey"
    );
    let values = std::iter::once(scope.key())
        .chain(messages.iter().map(|message| message.event_id.clone()))
        .collect::<Vec<_>>();
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(values))?;
    let mut grouped: BTreeMap<String, BTreeMap<String, Vec<(String, String)>>> = BTreeMap::new();
    while let Some(row) = rows.next()? {
        grouped
            .entry(row.get(0)?)
            .or_default()
            .entry(row.get(1)?)
            .or_default()
            .push((row.get(2)?, row.get(3)?));
    }
    for message in messages {
        let Some(groups) = grouped.remove(&message.event_id) else {
            continue;
        };
        message.reactions = groups
            .into_iter()
            .map(|(emoji, users)| ReactionGroup {
                count: users.len() as u32,
                current_user_reaction_id: users
                    .iter()
                    .find(|(pubkey, _)| pubkey == &scope.viewer_pubkey)
                    .map(|(_, id)| id.clone()),
                user_pubkeys: users.into_iter().map(|(pubkey, _)| pubkey).collect(),
                emoji,
            })
            .collect();
    }
    Ok(())
}

fn activity_is_read(
    conn: &Connection,
    scope: &ProjectionScope,
    message: &Message,
    latest_activity_at: u64,
) -> rusqlite::Result<bool> {
    let message_context = format!("msg:{}", message.event_id);
    let read_at: Option<u64> = if let Some(root_id) = message.root_id.as_deref() {
        conn.query_row(
            "SELECT MAX(read_at) FROM read_markers
             WHERE scope=?1 AND context_id IN (?2, ?3)",
            params![scope.key(), format!("thread:{root_id}"), message_context],
            |row| row.get(0),
        )?
    } else if let Some(channel_id) = message.channel_id.as_deref() {
        conn.query_row(
            "SELECT MAX(read_at) FROM read_markers
             WHERE scope=?1 AND context_id IN (?2, ?3)",
            params![scope.key(), channel_id, message_context],
            |row| row.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT read_at FROM read_markers WHERE scope=?1 AND context_id=?2",
            params![scope.key(), message_context],
            |row| row.get(0),
        )
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?
    };
    Ok(read_at.is_some_and(|read_at| read_at >= latest_activity_at))
}

fn category_from_i64(value: i64) -> Result<ActivityCategory, ClientStateError> {
    match value {
        0 => Ok(ActivityCategory::NeedsAction),
        1 => Ok(ActivityCategory::Mention),
        2 => Ok(ActivityCategory::AgentActivity),
        3 => Ok(ActivityCategory::Activity),
        other => Err(ClientStateError::InvalidProjection(format!(
            "unknown activity category {other}"
        ))),
    }
}

fn fts_query(input: &str) -> Option<String> {
    let terms = input
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}
