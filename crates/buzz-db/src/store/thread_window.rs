//! Newest-first thread windows for latency-sensitive clients.
//!
//! The legacy thread reader walks from the oldest reply forward. That is a
//! useful replay primitive, but it forces a UI to download an entire long
//! thread before it can show the active tail. This module exposes bounded,
//! newest-first pages over the same disposable `thread_metadata` projection.

use buzz_core::{CommunityId, StoredEvent};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use buzz_datastore_tracing::datastore_span;

use crate::{
    error::Result, event::row_to_stored_event, observability, route_proof::ChannelScoped,
    thread::ThreadSummary, Db, ReadSession, ReadSessionInner, RouteDecision, RoutePredicate,
};

/// One retained reply in a newest-first thread window.
#[derive(Debug, Clone)]
pub struct ThreadWindowRow {
    /// Fully reconstructed signed event for this reply.
    pub stored_event: StoredEvent,
    /// Current direct/descendant counts for a reply that heads a nested thread.
    pub thread_summary: Option<ThreadSummary>,
}

/// A bounded page of thread replies plus an authoritative continuation fact.
#[derive(Debug, Clone)]
pub struct ThreadWindow {
    /// Retained replies in `(created_at DESC, id ASC)` order.
    pub rows: Vec<ThreadWindowRow>,
    /// Whether an older page exists after the last retained row.
    pub has_more: bool,
    /// Cursor `(created_at, id)` for the next older page. Present iff
    /// [`Self::has_more`] is true.
    pub next_cursor: Option<(DateTime<Utc>, Vec<u8>)>,
}

/// Scope, page shape, and cursor for one thread-window read.
pub struct ThreadWindowQuery<'a> {
    /// Server-resolved tenant scope.
    pub community_id: CommunityId,
    /// Channel the root and every returned reply must belong to.
    pub channel_id: Uuid,
    /// Raw 32-byte Nostr event ID of the thread root.
    pub root_event_id: &'a [u8],
    /// Raw 32-byte Nostr event ID whose direct replies form this view.
    pub parent_event_id: &'a [u8],
    /// Maximum nested reply depth, or all depths when absent.
    pub depth_limit: Option<u32>,
    /// Maximum reply rows returned, excluding the internal sentinel.
    pub limit: u32,
    /// Last retained `(created_at, id)` from the preceding page.
    pub cursor: Option<(DateTime<Utc>, Vec<u8>)>,
    /// Optional allowlist of Nostr kinds applied before the page limit.
    pub kind_filter: Option<&'a [u32]>,
}

/// Fetch one newest-first thread window from the writer pool.
pub async fn get_thread_window(
    pool: &PgPool,
    query: &ThreadWindowQuery<'_>,
) -> Result<ThreadWindow> {
    let mut conn =
        observability::acquire_writer(pool, observability::WriterOperation::SubscriptionHistory)
            .await?;
    get_thread_window_on(&mut conn, query).await
}

/// [`get_thread_window`] on the exact session selected by replica routing.
pub(crate) async fn get_thread_window_on(
    conn: &mut sqlx::PgConnection,
    query: &ThreadWindowQuery<'_>,
) -> Result<ThreadWindow> {
    let limit = query.limit.max(1);
    let mut param_idx = 5u32;
    let mut sql = String::from(
        r#"
        SELECT
            e.id,
            e.pubkey,
            e.created_at,
            e.kind,
            e.tags,
            e.content,
            e.sig,
            e.received_at,
            e.channel_id,
            tm.reply_count,
            tm.descendant_count,
            tm.last_reply_at
        FROM thread_metadata tm
        JOIN events e
          ON e.community_id = tm.community_id
         AND e.created_at = tm.event_created_at
         AND e.id = tm.event_id
        WHERE tm.community_id = $1
          AND tm.root_event_id = $2
          AND tm.channel_id = $3
          AND tm.parent_event_id = $4
          AND e.deleted_at IS NULL
        "#,
    );

    if query.depth_limit.is_some() {
        sql.push_str(&format!(" AND tm.depth <= ${param_idx}"));
        param_idx += 1;
    }
    if query.cursor.is_some() {
        let ts_idx = param_idx;
        let id_idx = param_idx + 1;
        sql.push_str(&format!(
            " AND (tm.event_created_at < ${ts_idx} OR (tm.event_created_at = ${ts_idx} AND tm.event_id > ${id_idx}))"
        ));
        param_idx += 2;
    }
    if let Some(kinds) = query.kind_filter {
        if !kinds.is_empty() {
            let kinds = kinds
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",");
            sql.push_str(&format!(" AND e.kind IN ({kinds})"));
        }
    }
    sql.push_str(&format!(
        " ORDER BY tm.event_created_at DESC, tm.event_id ASC LIMIT ${param_idx}"
    ));

    let mut sql_query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(query.community_id.as_uuid())
        .bind(query.root_event_id)
        .bind(query.channel_id)
        .bind(query.parent_event_id);
    if let Some(depth_limit) = query.depth_limit {
        sql_query = sql_query.bind(depth_limit as i32);
    }
    if let Some((created_at, event_id)) = &query.cursor {
        sql_query = sql_query.bind(*created_at).bind(event_id.clone());
    }
    sql_query = sql_query.bind(i64::from(limit) + 1);

    let mut db_rows = sql_query.fetch_all(&mut *conn).await?;
    let has_more = db_rows.len() > limit as usize;
    db_rows.truncate(limit as usize);
    let next_cursor = if has_more {
        match db_rows.last() {
            Some(row) => Some((
                row.try_get::<DateTime<Utc>, _>("created_at")?,
                row.try_get::<Vec<u8>, _>("id")?,
            )),
            None => None,
        }
    } else {
        None
    };

    let mut rows = Vec::with_capacity(db_rows.len());
    for row in db_rows {
        let reply_count: i32 = row.try_get("reply_count")?;
        let descendant_count: i32 = row.try_get("descendant_count")?;
        let last_reply_at: Option<DateTime<Utc>> = row.try_get("last_reply_at")?;
        if let Some(stored_event) = row_to_stored_event(row)? {
            let thread_summary = (reply_count > 0).then_some(ThreadSummary {
                reply_count,
                descendant_count,
                last_reply_at,
                // Filled for all retained nested heads in one batch below.
                participants: Vec::new(),
            });
            rows.push(ThreadWindowRow {
                stored_event,
                thread_summary,
            });
        }
    }

    let nested_heads = rows
        .iter()
        .filter(|row| row.thread_summary.is_some())
        .map(|row| row.stored_event.event.id.as_bytes().to_vec())
        .collect::<Vec<_>>();
    if !nested_heads.is_empty() {
        let participant_rows = sqlx::query(
            r#"
            SELECT parent_event_id, pubkey FROM (
                SELECT
                    tm.parent_event_id,
                    e.pubkey,
                    ROW_NUMBER() OVER (
                        PARTITION BY tm.parent_event_id
                        ORDER BY MAX(e.created_at) DESC
                    ) AS rn
                FROM thread_metadata tm
                JOIN events e
                  ON e.community_id = tm.community_id
                 AND e.created_at = tm.event_created_at
                 AND e.id = tm.event_id
                WHERE tm.community_id = $1
                  AND tm.root_event_id = $2
                  AND tm.channel_id = $3
                  AND tm.parent_event_id = ANY($4)
                  AND e.deleted_at IS NULL
                GROUP BY tm.parent_event_id, e.pubkey
            ) participants
            WHERE rn <= 10
            ORDER BY parent_event_id, rn
            "#,
        )
        .bind(query.community_id.as_uuid())
        .bind(query.root_event_id)
        .bind(query.channel_id)
        .bind(&nested_heads)
        .fetch_all(&mut *conn)
        .await?;
        let mut by_parent = std::collections::HashMap::<Vec<u8>, Vec<Vec<u8>>>::new();
        for row in participant_rows {
            by_parent
                .entry(row.try_get("parent_event_id")?)
                .or_default()
                .push(row.try_get("pubkey")?);
        }
        for row in &mut rows {
            if let Some(summary) = &mut row.thread_summary {
                if let Some(participants) =
                    by_parent.remove(row.stored_event.event.id.as_bytes().as_slice())
                {
                    summary.participants = participants;
                }
            }
        }
    }

    Ok(ThreadWindow {
        rows,
        has_more,
        next_cursor,
    })
}

impl Db {
    /// Fetch a newest-first thread window and retain its proved read session
    /// for request-scoped aux queries.
    #[datastore_span(name = "get_thread_window", system = "postgresql")]
    pub async fn get_thread_window_with_session(
        &self,
        query: ThreadWindowQuery<'_>,
    ) -> Result<(ThreadWindow, ReadSession)> {
        let path = if query.cursor.is_some() {
            "thread_window_cursor"
        } else {
            "thread_window_head"
        };
        let predicate = match &query.cursor {
            Some((upper, _)) => RoutePredicate::Covered {
                upper: *upper,
                proof: ChannelScoped::from_channel_id(query.channel_id),
            },
            None => RoutePredicate::Bounded,
        };
        if let RouteDecision::Replica(mut tx, _entry, reason) = self
            .route_read(
                path,
                predicate,
                observability::ReaderOperation::SubscriptionHistory,
            )
            .await
        {
            match get_thread_window_on(&mut tx, &query).await {
                Ok(window) => {
                    Self::record_route(path, "replica", reason);
                    return Ok((
                        window,
                        ReadSession {
                            inner: ReadSessionInner::Replica {
                                tx,
                                writer: self.pool.clone(),
                            },
                        },
                    ));
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        path,
                        "replica thread window failed; re-running on writer"
                    );
                    Self::record_route(path, "writer", "replica_error");
                }
            }
        }

        let window = get_thread_window(&self.pool, &query).await?;
        Ok((
            window,
            ReadSession {
                inner: ReadSessionInner::Writer(self.pool.clone()),
            },
        ))
    }
}
