use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use buzz_core::agent_thread_lifecycle::{
    build_agent_thread_lifecycle, AgentThreadLifecycle, AgentThreadState,
};
use nostr::{Keys, Tag};

use crate::relay::{RelayEventPublisher, RestClient};
use crate::scope::SessionScope;

const QUEUED_EXPIRY: Duration = Duration::from_secs(600);
const MIN_WORKING_EXPIRY: Duration = Duration::from_secs(45);

#[derive(Clone)]
pub(crate) struct ThreadLifecycleReporter {
    publisher: Option<RelayEventPublisher>,
    rest_client: Option<RestClient>,
    keys: Keys,
    auth_tag: Option<Tag>,
    next_revision: Arc<AtomicU64>,
}

impl ThreadLifecycleReporter {
    #[cfg(test)]
    pub(crate) fn new(publisher: RelayEventPublisher, keys: Keys, auth_tag: Option<Tag>) -> Self {
        Self {
            publisher: Some(publisher),
            rest_client: None,
            keys,
            auth_tag,
            next_revision: Arc::new(AtomicU64::new(unix_revision())),
        }
    }

    pub(crate) fn new_rest(rest_client: RestClient, keys: Keys, auth_tag: Option<Tag>) -> Self {
        Self {
            publisher: None,
            rest_client: Some(rest_client),
            keys,
            auth_tag,
            next_revision: Arc::new(AtomicU64::new(unix_revision())),
        }
    }

    pub(crate) fn try_agent_queued(&self, scope: &SessionScope, source_id: &str) {
        self.try_publish(
            scope,
            AgentThreadState::Agent,
            &format!("queue:{source_id}"),
            "queued",
            Some(QUEUED_EXPIRY),
        );
    }

    pub(crate) fn try_agent_working(
        &self,
        scope: &SessionScope,
        turn_id: &str,
        liveness_interval: Duration,
    ) {
        let expiry = if liveness_interval.is_zero() {
            QUEUED_EXPIRY
        } else {
            liveness_interval.saturating_mul(3).max(MIN_WORKING_EXPIRY)
        };
        self.try_publish(
            scope,
            AgentThreadState::Agent,
            turn_id,
            "working",
            Some(expiry),
        );
    }

    pub(crate) async fn publish_terminal(
        &self,
        scope: &SessionScope,
        turn_id: &str,
        state: AgentThreadState,
        phase: &str,
    ) {
        let expiry = (state == AgentThreadState::Agent).then_some(QUEUED_EXPIRY);
        let Some(event) = self.build(scope, state, turn_id, phase, expiry) else {
            return;
        };
        let result = if let Some(rest_client) = &self.rest_client {
            match tokio::time::timeout(Duration::from_secs(5), rest_client.submit_event(&event))
                .await
            {
                Ok(result) => result.map(|_| ()),
                Err(_) => {
                    tracing::warn!(scope = %scope.telemetry_label(), state = state.as_str(), phase, "thread lifecycle publish timed out");
                    return;
                }
            }
        } else if let Some(publisher) = &self.publisher {
            publisher.publish_event(event).await
        } else {
            return;
        };
        if let Err(error) = result {
            tracing::warn!(scope = %scope.telemetry_label(), state = state.as_str(), phase, %error, "thread lifecycle publish failed");
        }
    }

    pub(crate) fn try_terminal(
        &self,
        scope: &SessionScope,
        turn_id: &str,
        state: AgentThreadState,
        phase: &str,
    ) {
        self.try_publish(scope, state, turn_id, phase, None);
    }

    fn try_publish(
        &self,
        scope: &SessionScope,
        state: AgentThreadState,
        turn_id: &str,
        phase: &str,
        expiry: Option<Duration>,
    ) {
        let Some(event) = self.build(scope, state, turn_id, phase, expiry) else {
            return;
        };
        if let Some(rest_client) = &self.rest_client {
            let rest_client = rest_client.clone();
            tokio::spawn(async move {
                let _ =
                    tokio::time::timeout(Duration::from_secs(5), rest_client.submit_event(&event))
                        .await;
            });
        } else if let Some(publisher) = &self.publisher {
            if let Err(error) = publisher.try_publish_event(event) {
                tracing::debug!(scope = %scope.telemetry_label(), state = state.as_str(), phase, %error, "thread lifecycle refresh dropped");
            }
        }
    }

    fn build(
        &self,
        scope: &SessionScope,
        state: AgentThreadState,
        turn_id: &str,
        phase: &str,
        expiry: Option<Duration>,
    ) -> Option<nostr::Event> {
        let SessionScope::Thread {
            channel_id,
            root_event_id: root,
        } = scope
        else {
            return None;
        };
        let root_event_id = match nostr::EventId::from_hex(root) {
            Ok(root) => root,
            Err(error) => {
                tracing::warn!(scope = %scope.telemetry_label(), %error, "invalid thread root for lifecycle event");
                return None;
            }
        };
        let lifecycle = AgentThreadLifecycle {
            version: 1,
            turn_id: turn_id.to_string(),
            state,
            phase: phase.to_string(),
            revision: self.next_revision.fetch_add(1, Ordering::Relaxed),
            expires_at: expiry.map(|duration| unix_seconds().saturating_add(duration.as_secs())),
        };
        let mut builder = match build_agent_thread_lifecycle(*channel_id, root_event_id, &lifecycle)
        {
            Ok(builder) => builder,
            Err(error) => {
                tracing::warn!(scope = %scope.telemetry_label(), %error, "thread lifecycle build failed");
                return None;
            }
        };
        if let Some(tag) = &self.auth_tag {
            builder = builder.tag(tag.clone());
        }
        match builder.sign_with_keys(&self.keys) {
            Ok(event) => Some(event),
            Err(error) => {
                tracing::warn!(scope = %scope.telemetry_label(), %error, "thread lifecycle signing failed");
                None
            }
        }
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unix_revision() -> u64 {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros();
    u64::try_from(micros).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::agent_thread_lifecycle::parse_agent_thread_lifecycle;
    use uuid::Uuid;

    #[tokio::test]
    async fn queued_snapshot_is_signed_scoped_and_attested() {
        let (publisher, mut events) = RelayEventPublisher::test_pair();
        let owner = Keys::generate();
        let agent = Keys::generate();
        let auth_json =
            buzz_sdk::nip_oa::compute_auth_tag(&owner, &agent.public_key(), "").unwrap();
        let auth_tag = buzz_sdk::nip_oa::parse_auth_tag(&auth_json).unwrap();
        let reporter = ThreadLifecycleReporter::new(publisher, agent.clone(), Some(auth_tag));
        let root = nostr::EventId::all_zeros();
        let scope = SessionScope::Thread {
            channel_id: Uuid::new_v4(),
            root_event_id: root.to_hex(),
        };

        reporter.try_agent_queued(&scope, "source-1");
        let event = events.recv().await.unwrap();
        let parsed = parse_agent_thread_lifecycle(&event).unwrap();

        assert_eq!(event.pubkey, agent.public_key());
        assert_eq!(parsed.channel_id, scope.channel_id());
        assert_eq!(parsed.root_event_id, root);
        assert_eq!(parsed.lifecycle.state, AgentThreadState::Agent);
        assert_eq!(parsed.lifecycle.phase, "queued");
        assert!(parsed.lifecycle.expires_at.is_some());
        assert!(buzz_sdk::nip_oa::verify_auth_tag(&auth_json, &event.pubkey)
            .is_ok_and(|verified| verified == owner.public_key()));
        assert!(event
            .tags
            .iter()
            .any(|tag| tag == &buzz_sdk::nip_oa::parse_auth_tag(&auth_json).unwrap()));
    }

    #[tokio::test]
    async fn channel_scoped_dm_does_not_publish_thread_status() {
        let (publisher, mut events) = RelayEventPublisher::test_pair();
        let reporter = ThreadLifecycleReporter::new(publisher, Keys::generate(), None);

        reporter.try_agent_queued(
            &SessionScope::Conversation {
                channel_id: Uuid::new_v4(),
            },
            "source-1",
        );

        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn retrying_terminal_snapshot_has_an_expiry() {
        let (publisher, mut events) = RelayEventPublisher::test_pair();
        let reporter = ThreadLifecycleReporter::new(publisher, Keys::generate(), None);
        let scope = SessionScope::Thread {
            channel_id: Uuid::new_v4(),
            root_event_id: nostr::EventId::all_zeros().to_hex(),
        };

        reporter
            .publish_terminal(&scope, "turn-1", AgentThreadState::Agent, "retrying")
            .await;

        let event = events.recv().await.unwrap();
        let parsed = parse_agent_thread_lifecycle(&event).unwrap();
        assert_eq!(parsed.lifecycle.state, AgentThreadState::Agent);
        assert_eq!(parsed.lifecycle.phase, "retrying");
        assert!(parsed.lifecycle.expires_at.is_some());
    }
}
