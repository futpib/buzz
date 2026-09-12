use std::{path::PathBuf, sync::Arc};

use buzz_core::Event;
use tokio::sync::{mpsc, oneshot};

use crate::{
    model::{
        ActivityItem, ApplyStats, ChannelListItem, Message, PageCursor, ProjectionScope,
        ReadMarker, SearchHit, Thread,
    },
    project, query, schema,
};

const MAX_EVENT_BATCH: usize = 10_000;
const MAX_MARKER_BATCH: usize = 10_000;
const MAX_SEARCH_BYTES: usize = 1_024;

/// Errors returned by the async client-state API.
#[derive(Debug, thiserror::Error)]
pub enum ClientStateError {
    /// The scope is empty or not safely canonicalizable.
    #[error("invalid projection scope: {0}")]
    InvalidScope(String),
    /// An event timestamp cannot be represented by SQLite.
    #[error("timestamp is outside SQLite's signed range: {0}")]
    InvalidTimestamp(u64),
    /// The on-disk schema is newer or otherwise unsupported.
    #[error("unsupported client-state schema version {0}")]
    UnsupportedSchema(i64),
    /// A projection row violated an internal invariant.
    #[error("invalid projected state: {0}")]
    InvalidProjection(String),
    /// A caller supplied an unbounded mutation batch.
    #[error("{operation} batch has {actual} rows; maximum is {maximum}")]
    BatchTooLarge {
        /// Name of the rejected operation.
        operation: &'static str,
        /// Number of supplied rows.
        actual: usize,
        /// Maximum accepted rows.
        maximum: usize,
    },
    /// A query exceeded a bounded input contract.
    #[error("invalid client-state query: {0}")]
    InvalidQuery(String),
    /// Event id or signature verification failed.
    #[error(transparent)]
    Verification(#[from] buzz_core::VerificationError),
    /// SQLite operation failed.
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    /// Nostr tag/event serialization failed.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// Database directory creation failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// The dedicated projection worker stopped unexpectedly.
    #[error("client-state projection worker stopped")]
    WorkerStopped,
    /// A blocking task panicked or was cancelled.
    #[error("client-state blocking task failed: {0}")]
    BlockingTask(String),
}

/// Immediate enqueue failure that returns ownership of the unsent event.
#[derive(Debug, thiserror::Error)]
pub enum EnqueueError {
    /// The bounded queue is full; retry or trigger a relay reconciliation.
    #[error("client-state projection queue is full")]
    Full(Box<Event>),
    /// The worker is no longer running.
    #[error("client-state projection worker is closed")]
    Closed(Box<Event>),
}

impl EnqueueError {
    /// Recover the event that was not queued.
    pub fn into_event(self) -> Event {
        match self {
            Self::Full(event) | Self::Closed(event) => *event,
        }
    }
}

/// Startup configuration for [`ClientState`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenOptions {
    /// Number of pending commands allowed before [`ClientState::enqueue`] reports backpressure.
    pub queue_capacity: usize,
}

impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            queue_capacity: 1_024,
        }
    }
}

#[derive(Clone)]
struct Inner {
    path: PathBuf,
    scope: ProjectionScope,
    sender: mpsc::Sender<Command>,
}

/// Scope-fenced, asynchronous handle to the local Buzz read model.
///
/// Writes are serialized by one dedicated blocking worker. Reads use separate
/// SQLite WAL connections on Tokio's blocking pool, so neither path blocks an
/// async executor or the UI thread.
#[derive(Clone)]
pub struct ClientState {
    inner: Arc<Inner>,
}

enum Command {
    Apply {
        events: Vec<Event>,
        response: Option<oneshot::Sender<Result<ApplyStats, ClientStateError>>>,
    },
    ReadMarkers {
        markers: Vec<ReadMarker>,
        response: oneshot::Sender<Result<u64, ClientStateError>>,
    },
    Barrier {
        response: oneshot::Sender<Result<u64, ClientStateError>>,
    },
}

impl ClientState {
    /// Open or create a projection database using default queue settings.
    pub async fn open(
        path: impl Into<PathBuf>,
        scope: ProjectionScope,
    ) -> Result<Self, ClientStateError> {
        Self::open_with_options(path, scope, OpenOptions::default()).await
    }

    /// Open or create a projection database with explicit queue settings.
    pub async fn open_with_options(
        path: impl Into<PathBuf>,
        scope: ProjectionScope,
        options: OpenOptions,
    ) -> Result<Self, ClientStateError> {
        validate_scope(&scope)?;
        if options.queue_capacity == 0 {
            return Err(ClientStateError::InvalidScope(
                "queue capacity must be positive".to_string(),
            ));
        }
        let path = path.into();
        let (sender, receiver) = mpsc::channel(options.queue_capacity);
        let (ready_sender, ready_receiver) = oneshot::channel();
        let worker_path = path.clone();
        let worker_scope = scope.clone();
        tokio::task::spawn_blocking(move || {
            if let Some(parent) = worker_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                if let Err(error) = std::fs::create_dir_all(parent) {
                    let _ = ready_sender.send(Err(error.into()));
                    return;
                }
            }
            let mut conn = match schema::open(&worker_path) {
                Ok(conn) => {
                    let _ = ready_sender.send(Ok(()));
                    conn
                }
                Err(error) => {
                    let _ = ready_sender.send(Err(error));
                    return;
                }
            };
            run_worker(&mut conn, &worker_scope, receiver);
        });
        ready_receiver
            .await
            .map_err(|_| ClientStateError::WorkerStopped)??;
        Ok(Self {
            inner: Arc::new(Inner {
                path,
                scope,
                sender,
            }),
        })
    }

    /// Queue one event without waiting for projection work.
    ///
    /// Backpressure is explicit and the event is returned in [`EnqueueError`];
    /// callers must retry or reconcile instead of silently dropping it.
    pub fn enqueue(&self, event: Event) -> Result<(), EnqueueError> {
        match self.inner.sender.try_send(Command::Apply {
            events: vec![event],
            response: None,
        }) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(Command::Apply { mut events, .. })) => {
                Err(EnqueueError::Full(Box::new(events.remove(0))))
            }
            Err(mpsc::error::TrySendError::Closed(Command::Apply { mut events, .. })) => {
                Err(EnqueueError::Closed(Box::new(events.remove(0))))
            }
            Err(_) => unreachable!("enqueue only sends apply commands"),
        }
    }

    /// Apply a verified-event batch atomically and await its durable revision.
    ///
    /// Waiting is asynchronous; SQLite and signature verification stay on the
    /// dedicated worker thread.
    pub async fn apply(&self, events: Vec<Event>) -> Result<ApplyStats, ClientStateError> {
        check_batch("event", events.len(), MAX_EVENT_BATCH)?;
        let (response, receiver) = oneshot::channel();
        self.inner
            .sender
            .send(Command::Apply {
                events,
                response: Some(response),
            })
            .await
            .map_err(|_| ClientStateError::WorkerStopped)?;
        receiver
            .await
            .map_err(|_| ClientStateError::WorkerStopped)?
    }

    /// Merge decoded NIP-RS markers and await the resulting revision.
    ///
    /// Marker values only move forward, matching cross-device read-state merge
    /// semantics. Decryption deliberately lives in the client identity layer.
    pub async fn apply_read_markers(
        &self,
        markers: Vec<ReadMarker>,
    ) -> Result<u64, ClientStateError> {
        check_batch("read marker", markers.len(), MAX_MARKER_BATCH)?;
        let (response, receiver) = oneshot::channel();
        self.inner
            .sender
            .send(Command::ReadMarkers { markers, response })
            .await
            .map_err(|_| ClientStateError::WorkerStopped)?;
        receiver
            .await
            .map_err(|_| ClientStateError::WorkerStopped)?
    }

    /// Wait until every previously queued mutation has committed.
    pub async fn flush(&self) -> Result<u64, ClientStateError> {
        let (response, receiver) = oneshot::channel();
        self.inner
            .sender
            .send(Command::Barrier { response })
            .await
            .map_err(|_| ClientStateError::WorkerStopped)?;
        receiver
            .await
            .map_err(|_| ClientStateError::WorkerStopped)?
    }

    /// Return locally projected channels in immediate-paint order.
    pub async fn channels(
        &self,
        members_only: bool,
    ) -> Result<Vec<ChannelListItem>, ClientStateError> {
        let inner = self.inner.clone();
        run_query(move || {
            let conn = schema::open(&inner.path)?;
            query::channels(&conn, &inner.scope, members_only)
        })
        .await
    }

    /// Return one deterministic newest-first channel page.
    pub async fn channel_messages(
        &self,
        channel_id: impl Into<String>,
        cursor: Option<PageCursor>,
        limit: u32,
    ) -> Result<Vec<Message>, ClientStateError> {
        let inner = self.inner.clone();
        let channel_id = channel_id.into();
        run_query(move || {
            let conn = schema::open(&inner.path)?;
            query::channel_messages(
                &conn,
                &inner.scope,
                &channel_id,
                cursor.as_ref(),
                bounded_limit(limit),
            )
        })
        .await
    }

    /// Return a bounded chronological raw-event snapshot for one channel.
    ///
    /// The snapshot includes recursively related edits, reactions, and
    /// deletions so an existing client-side formatter can paint directly from
    /// SQLite before the relay refresh completes.
    pub async fn channel_events(
        &self,
        channel_id: impl Into<String>,
        limit: u32,
    ) -> Result<Vec<Event>, ClientStateError> {
        let inner = self.inner.clone();
        let channel_id = channel_id.into();
        run_query(move || {
            let conn = schema::open(&inner.path)?;
            query::channel_events(&conn, &inner.scope, &channel_id, bounded_event_limit(limit))
        })
        .await
    }

    /// Return a bounded chronological raw-event snapshot for one thread.
    pub async fn thread_events(
        &self,
        root_id: impl Into<String>,
        limit: u32,
    ) -> Result<Vec<Event>, ClientStateError> {
        let inner = self.inner.clone();
        let root_id = root_id.into();
        run_query(move || {
            let conn = schema::open(&inner.path)?;
            query::thread_events(&conn, &inner.scope, &root_id, bounded_event_limit(limit))
        })
        .await
    }

    /// Return a root and its chronologically ordered reply projection.
    pub async fn thread(
        &self,
        root_id: impl Into<String>,
        limit: u32,
    ) -> Result<Thread, ClientStateError> {
        let inner = self.inner.clone();
        let root_id = root_id.into();
        run_query(move || {
            let conn = schema::open(&inner.path)?;
            query::thread(&conn, &inner.scope, &root_id, bounded_limit(limit))
        })
        .await
    }

    /// Return conversation-grouped local activity rows.
    pub async fn activity(&self, limit: u32) -> Result<Vec<ActivityItem>, ClientStateError> {
        let inner = self.inner.clone();
        run_query(move || {
            let conn = schema::open(&inner.path)?;
            query::activity(&conn, &inner.scope, bounded_limit(limit))
        })
        .await
    }

    /// Search locally indexed message content with FTS5.
    pub async fn search(
        &self,
        text: impl Into<String>,
        limit: u32,
    ) -> Result<Vec<SearchHit>, ClientStateError> {
        let inner = self.inner.clone();
        let text = text.into();
        if text.len() > MAX_SEARCH_BYTES {
            return Err(ClientStateError::InvalidQuery(format!(
                "search text exceeds {MAX_SEARCH_BYTES} bytes"
            )));
        }
        run_query(move || {
            let conn = schema::open(&inner.path)?;
            query::search(&conn, &inner.scope, &text, bounded_limit(limit))
        })
        .await
    }
}

fn run_worker(
    conn: &mut rusqlite::Connection,
    scope: &ProjectionScope,
    mut receiver: mpsc::Receiver<Command>,
) {
    while let Some(command) = receiver.blocking_recv() {
        match command {
            Command::Apply { events, response } => {
                let result = project::apply_events(conn, scope, events);
                if let Some(response) = response {
                    let _ = response.send(result);
                }
            }
            Command::ReadMarkers { markers, response } => {
                let _ = response.send(project::apply_read_markers(conn, scope, markers));
            }
            Command::Barrier { response } => {
                let _ = response.send(project::current_revision(conn, scope));
            }
        }
    }
}

async fn run_query<T, F>(query: F) -> Result<T, ClientStateError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ClientStateError> + Send + 'static,
{
    tokio::task::spawn_blocking(query)
        .await
        .map_err(|error| ClientStateError::BlockingTask(error.to_string()))?
}

fn validate_scope(scope: &ProjectionScope) -> Result<(), ClientStateError> {
    if scope.relay_url.is_empty() || scope.relay_url.contains(['\n', '\r']) {
        return Err(ClientStateError::InvalidScope(
            "relay URL must be non-empty and single-line".to_string(),
        ));
    }
    if scope.viewer_pubkey.len() != 64
        || !scope.viewer_pubkey.chars().all(|ch| ch.is_ascii_hexdigit())
    {
        return Err(ClientStateError::InvalidScope(
            "viewer pubkey must be 64 hexadecimal characters".to_string(),
        ));
    }
    Ok(())
}

fn bounded_limit(limit: u32) -> u32 {
    limit.clamp(1, 500)
}

fn bounded_event_limit(limit: u32) -> u32 {
    limit.clamp(1, 5_000)
}

fn check_batch(
    operation: &'static str,
    actual: usize,
    maximum: usize,
) -> Result<(), ClientStateError> {
    if actual > maximum {
        return Err(ClientStateError::BatchTooLarge {
            operation,
            actual,
            maximum,
        });
    }
    Ok(())
}
