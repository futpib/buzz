use serde::{Deserialize, Serialize};

/// Relay-and-viewer boundary for every projected row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionScope {
    /// Relay base URL whose accepted events feed this projection.
    pub relay_url: String,
    /// Lowercase hexadecimal public key of the active viewer.
    pub viewer_pubkey: String,
}

impl ProjectionScope {
    /// Construct and normalize a scope.
    pub fn new(relay_url: impl Into<String>, viewer_pubkey: impl Into<String>) -> Self {
        Self {
            relay_url: relay_url.into().trim().trim_end_matches('/').to_string(),
            viewer_pubkey: viewer_pubkey.into().trim().to_ascii_lowercase(),
        }
    }

    pub(crate) fn key(&self) -> String {
        format!("{}\n{}", self.relay_url, self.viewer_pubkey)
    }
}

/// Cursor for deterministic newest-first message pagination.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageCursor {
    /// Unix timestamp of the final row already returned.
    pub created_at: u64,
    /// Event id used to break timestamp ties.
    pub event_id: String,
}

/// One read-state context after the encrypted NIP-RS blob is decoded by the client.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadMarker {
    /// Channel id, `thread:<root-id>`, or `msg:<event-id>`.
    pub context_id: String,
    /// Monotonic Unix timestamp for the context.
    pub read_at: u64,
}

/// Result of applying an atomic event batch.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyStats {
    /// Newly stored relevant events.
    pub inserted: u64,
    /// Events already present by id.
    pub duplicates: u64,
    /// Valid events outside this read model's intentionally narrow kind set.
    pub ignored: u64,
    /// Projection revision after the batch commits.
    pub revision: u64,
}

/// Channel-list row ready for immediate display.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelListItem {
    /// NIP-29 group id.
    pub channel_id: String,
    /// Display name.
    pub name: String,
    /// `stream`, `forum`, or `dm`.
    pub channel_type: String,
    /// `open` or `private`.
    pub visibility: String,
    /// Channel description.
    pub description: String,
    /// Optional current topic.
    pub topic: Option<String>,
    /// Whether the channel metadata marks it archived.
    pub archived: bool,
    /// Whether the current viewer appears in the latest membership snapshot.
    pub is_member: bool,
    /// Distinct members in the latest membership snapshot.
    pub member_count: u32,
    /// Most recent visible message id.
    pub last_event_id: Option<String>,
    /// Most recent visible message timestamp.
    pub last_event_at: Option<u64>,
    /// Incoming messages newer than their effective read markers.
    pub unread_count: u32,
}

/// Aggregated reaction state for one emoji.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReactionGroup {
    /// Emoji or shortcode stored in reaction content.
    pub emoji: String,
    /// Number of distinct reacting identities.
    pub count: u32,
    /// Lowercase public keys of reacting identities.
    pub user_pubkeys: Vec<String>,
    /// Current viewer's reaction event id, when present.
    pub current_user_reaction_id: Option<String>,
}

/// Render-ready message with edits and reactions already overlaid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    /// Nostr event id.
    pub event_id: String,
    /// Event kind.
    pub kind: u32,
    /// Effective author public key.
    pub pubkey: String,
    /// Unix event timestamp.
    pub created_at: u64,
    /// Current message content after the latest edit.
    pub content: String,
    /// Current tags after the latest edit.
    pub tags: Vec<Vec<String>>,
    /// Channel id from the `h` tag, when the event is channel-scoped.
    pub channel_id: Option<String>,
    /// NIP-10 outer root for replies.
    pub root_id: Option<String>,
    /// NIP-10 direct parent for replies.
    pub parent_id: Option<String>,
    /// Whether an edit was applied.
    pub edited: bool,
    /// Aggregated, active reactions.
    pub reactions: Vec<ReactionGroup>,
}

/// A thread root, its replies, and summary fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Thread {
    /// Requested thread root id.
    pub root_id: String,
    /// Root message when it has arrived locally.
    pub root: Option<Message>,
    /// Replies ordered by timestamp then event id.
    pub replies: Vec<Message>,
    /// Number of non-deleted descendants.
    pub reply_count: u32,
    /// Most recent reply timestamp.
    pub last_reply_at: Option<u64>,
    /// Up to three most recent unique participant public keys.
    pub participant_pubkeys: Vec<String>,
}

/// Activity-inbox category matching Buzz mobile semantics.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityCategory {
    /// Workflow approval addressed to the viewer.
    NeedsAction,
    /// User-visible content that mentions the viewer.
    Mention,
    /// Agent job lifecycle event addressed to the viewer.
    AgentActivity,
    /// Direct-message traffic from another identity.
    Activity,
}

/// One locally queryable activity row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityItem {
    /// Stable thread, DM, or event conversation key.
    pub conversation_id: String,
    /// Representative event.
    pub message: Message,
    /// Highest-priority category for this row.
    pub category: ActivityCategory,
    /// Timestamp of the newest grouped event.
    pub latest_activity_at: u64,
    /// Whether the effective context marker covers this event.
    pub read: bool,
}

/// Local full-text search result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    /// Matching message.
    pub message: Message,
    /// SQLite FTS5 BM25 score; lower is a better match.
    pub score: f64,
}
