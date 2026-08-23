//! Agent thread lifecycle events shared by harnesses and coordinators.
//!
//! A lifecycle event is ephemeral and channel-scoped. The agent signs it and
//! includes its NIP-OA `auth` tag; coordinators independently verify that
//! attestation before projecting state into durable UI such as a reaction on
//! the thread root.

use nostr::{Event, EventBuilder, EventId, Kind, Tag};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::kind::KIND_AGENT_THREAD_LIFECYCLE;

/// Current ownership of the next action in a thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentThreadState {
    /// Work is queued or actively running in an agent harness.
    Agent,
    /// The last agent turn completed successfully; a human may act next.
    Human,
    /// Work failed, became stale, or could not be assigned.
    Failed,
}

impl AgentThreadState {
    /// Stable wire value used in event content and coordinator reaction tags.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Human => "human",
            Self::Failed => "failed",
        }
    }
}

/// Versioned JSON content of a lifecycle event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadLifecycle {
    /// Wire format version. Currently `1`.
    pub version: u8,
    /// Harness-generated turn identifier, or a stable queue source identifier.
    pub turn_id: String,
    /// Which side owns the next action.
    pub state: AgentThreadState,
    /// More specific diagnostic phase such as `queued`, `working`, or `retrying`.
    pub phase: String,
    /// Publisher-monotonic revision used to reject reordered snapshots.
    pub revision: u64,
    /// Unix timestamp after which an `agent` snapshot is stale without refresh.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

/// A validated lifecycle event with its routing coordinates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAgentThreadLifecycle {
    /// Channel containing the thread.
    pub channel_id: Uuid,
    /// Root message on which the coordinator projects status.
    pub root_event_id: EventId,
    /// Parsed lifecycle content.
    pub lifecycle: AgentThreadLifecycle,
}

/// Lifecycle event construction or validation error.
#[derive(Debug, Error)]
pub enum AgentThreadLifecycleError {
    /// Event is not the registered lifecycle kind.
    #[error("event is not an agent thread lifecycle event")]
    WrongKind,
    /// A required tag is absent, duplicated, or malformed.
    #[error("invalid lifecycle tags: {0}")]
    InvalidTags(String),
    /// Lifecycle JSON is malformed or violates the wire contract.
    #[error("invalid lifecycle content: {0}")]
    InvalidContent(String),
    /// Nostr event builder rejected a tag.
    #[error("could not build lifecycle event: {0}")]
    Build(String),
}

/// Build an unsigned channel-scoped lifecycle event.
pub fn build_agent_thread_lifecycle(
    channel_id: Uuid,
    root_event_id: EventId,
    lifecycle: &AgentThreadLifecycle,
) -> Result<EventBuilder, AgentThreadLifecycleError> {
    validate_lifecycle(lifecycle)?;
    let channel = channel_id.to_string();
    let root = root_event_id.to_hex();
    let content = serde_json::to_string(lifecycle)
        .map_err(|error| AgentThreadLifecycleError::InvalidContent(error.to_string()))?;
    let channel_tag = Tag::parse(["h", channel.as_str()])
        .map_err(|error| AgentThreadLifecycleError::Build(error.to_string()))?;
    let root_tag = Tag::parse(["e", root.as_str(), "", "root"])
        .map_err(|error| AgentThreadLifecycleError::Build(error.to_string()))?;
    Ok(
        EventBuilder::new(Kind::Custom(KIND_AGENT_THREAD_LIFECYCLE as u16), content)
            .tags([channel_tag, root_tag]),
    )
}

/// Parse and validate a lifecycle event's kind, coordinates, and JSON content.
///
/// Signature and NIP-OA owner attestation verification remain the consumer's
/// responsibility because the expected owner is local policy.
pub fn parse_agent_thread_lifecycle(
    event: &Event,
) -> Result<ParsedAgentThreadLifecycle, AgentThreadLifecycleError> {
    if event.kind != Kind::Custom(KIND_AGENT_THREAD_LIFECYCLE as u16) {
        return Err(AgentThreadLifecycleError::WrongKind);
    }
    let channel = unique_tag_value(event, "h")?;
    let channel_id = Uuid::parse_str(channel)
        .map_err(|error| AgentThreadLifecycleError::InvalidTags(error.to_string()))?;
    let root = unique_root_tag_value(event)?;
    let root_event_id = EventId::from_hex(root)
        .map_err(|error| AgentThreadLifecycleError::InvalidTags(error.to_string()))?;
    let lifecycle: AgentThreadLifecycle = serde_json::from_str(&event.content)
        .map_err(|error| AgentThreadLifecycleError::InvalidContent(error.to_string()))?;
    validate_lifecycle(&lifecycle)?;
    Ok(ParsedAgentThreadLifecycle {
        channel_id,
        root_event_id,
        lifecycle,
    })
}

fn validate_lifecycle(lifecycle: &AgentThreadLifecycle) -> Result<(), AgentThreadLifecycleError> {
    if lifecycle.version != 1 {
        return Err(AgentThreadLifecycleError::InvalidContent(format!(
            "unsupported version {}",
            lifecycle.version
        )));
    }
    if lifecycle.turn_id.is_empty() || lifecycle.turn_id.len() > 128 {
        return Err(AgentThreadLifecycleError::InvalidContent(
            "turnId must contain 1..=128 bytes".to_string(),
        ));
    }
    if lifecycle.phase.is_empty() || lifecycle.phase.len() > 64 {
        return Err(AgentThreadLifecycleError::InvalidContent(
            "phase must contain 1..=64 bytes".to_string(),
        ));
    }
    if lifecycle.state == AgentThreadState::Agent && lifecycle.expires_at.is_none() {
        return Err(AgentThreadLifecycleError::InvalidContent(
            "agent state requires expiresAt".to_string(),
        ));
    }
    if lifecycle.state != AgentThreadState::Agent && lifecycle.expires_at.is_some() {
        return Err(AgentThreadLifecycleError::InvalidContent(
            "terminal state must not carry expiresAt".to_string(),
        ));
    }
    Ok(())
}

fn unique_tag_value<'a>(
    event: &'a Event,
    name: &str,
) -> Result<&'a str, AgentThreadLifecycleError> {
    let mut values = event.tags.iter().filter_map(|tag| {
        let parts = tag.as_slice();
        (parts.first().map(String::as_str) == Some(name))
            .then(|| parts.get(1).map(String::as_str))
            .flatten()
    });
    let value = values
        .next()
        .ok_or_else(|| AgentThreadLifecycleError::InvalidTags(format!("missing {name} tag")))?;
    if values.next().is_some() {
        return Err(AgentThreadLifecycleError::InvalidTags(format!(
            "duplicate {name} tag"
        )));
    }
    Ok(value)
}

fn unique_root_tag_value(event: &Event) -> Result<&str, AgentThreadLifecycleError> {
    let mut values = event.tags.iter().filter_map(|tag| {
        let parts = tag.as_slice();
        (parts.first().map(String::as_str) == Some("e")
            && parts.get(3).map(String::as_str) == Some("root"))
        .then(|| parts.get(1).map(String::as_str))
        .flatten()
    });
    let value = values
        .next()
        .ok_or_else(|| AgentThreadLifecycleError::InvalidTags("missing e root tag".to_string()))?;
    if values.next().is_some() {
        return Err(AgentThreadLifecycleError::InvalidTags(
            "duplicate e root tag".to_string(),
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    #[test]
    fn lifecycle_round_trips_with_thread_coordinates() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let root = EventId::all_zeros();
        let lifecycle = AgentThreadLifecycle {
            version: 1,
            turn_id: "turn-1".to_string(),
            state: AgentThreadState::Agent,
            phase: "working".to_string(),
            revision: 42,
            expires_at: Some(1234),
        };
        let event = build_agent_thread_lifecycle(channel, root, &lifecycle)
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();

        assert_eq!(
            parse_agent_thread_lifecycle(&event).unwrap(),
            ParsedAgentThreadLifecycle {
                channel_id: channel,
                root_event_id: root,
                lifecycle,
            }
        );
    }

    #[test]
    fn rejects_agent_state_without_expiry() {
        let lifecycle = AgentThreadLifecycle {
            version: 1,
            turn_id: "turn-1".to_string(),
            state: AgentThreadState::Agent,
            phase: "working".to_string(),
            revision: 1,
            expires_at: None,
        };

        assert!(
            build_agent_thread_lifecycle(Uuid::new_v4(), EventId::all_zeros(), &lifecycle).is_err()
        );
    }
}
