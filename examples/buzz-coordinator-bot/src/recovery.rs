//! Reconcile durable turn projections after restart or a missed completion.
//! Expiry is evidence of lost contact, not proof that side effects did not run.
use super::*;

const GRACE_SECS: u64 = 120;
const SCAN_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug)]
pub(super) struct Check {
    pub key: ThreadKey,
    pub agent: PublicKey,
    pub source: EventId,
}

#[derive(Default)]
pub(super) struct Tracker {
    connected: bool,
    ready_at: u64,
    records: HashMap<ThreadKey, HashMap<PublicKey, AgentTurnRecord>>,
    attempted: HashMap<EventId, tokio::time::Instant>,
}

impl Tracker {
    pub(super) fn connect(
        &mut self,
        records: &HashMap<ThreadKey, HashMap<PublicKey, AgentTurnRecord>>,
    ) {
        self.records.clone_from(records);
        self.connected = true;
        self.ready_at = unix_seconds().saturating_add(GRACE_SECS);
    }

    pub(super) fn disconnect(&mut self) {
        self.connected = false;
    }

    pub(super) fn update(&mut self, routes: &RouteState) {
        self.records.clone_from(&routes.agent_turns);
    }

    // Fence the worker before any network await needed to persist the new status.
    pub(super) fn observe(&mut self, key: ThreadKey, agent: PublicKey, record: AgentTurnRecord) {
        record_agent_turn_in(&mut self.records, key, agent, record);
    }

    pub(super) fn current(&self, check: &Check, now: u64) -> bool {
        self.connected
            && now >= self.ready_at
            && self.records.get(&check.key).is_some_and(|records| {
                // Never wake another worker while any agent in the thread is live.
                !records.values().any(|record| {
                    record.state == AgentThreadState::Agent
                        && record
                            .expires_at
                            .is_none_or(|expiry| expiry.saturating_add(GRACE_SECS) > now)
                }) && records.get(&check.agent).is_some_and(|record| {
                    record.event_id == check.source
                        && (record.authoritative
                            || (record.state == AgentThreadState::Agent
                                && record.turn_id.starts_with("route:")))
                })
            })
    }
}

pub(super) async fn enqueue(
    tx: &mpsc::Sender<JudgeWork>,
    tracker: &Arc<Mutex<JudgeTracker>>,
    routes: &RouteState,
) -> Result<()> {
    let mut tracker = tracker.lock().await;
    tracker.recovery.update(routes);
    let now = unix_seconds();
    let checks = tracker
        .recovery
        .records
        .iter()
        .flat_map(|(key, records)| {
            records.iter().map(|(agent, record)| Check {
                key: *key,
                agent: *agent,
                source: record.event_id,
            })
        })
        .filter(|check| tracker.recovery.current(check, now))
        .collect::<Vec<_>>();
    for check in checks {
        if tracker.queued.contains(&check.source)
            || tracker
                .deliveries
                .get(&check.source)
                .is_some_and(JudgeDelivery::complete)
            || tracker
                .recovery
                .attempted
                .get(&check.source)
                .is_some_and(|at| at.elapsed() < SCAN_INTERVAL)
        {
            continue;
        }
        // A full worker queue must not block lifecycle/heartbeat ingestion.
        match tx.try_send(JudgeWork::Recovery(check)) {
            Ok(()) => {
                tracker.queued.insert(check.source);
                tracker
                    .recovery
                    .attempted
                    .insert(check.source, tokio::time::Instant::now());
            }
            Err(mpsc::error::TrySendError::Full(_)) => break,
            Err(error) => bail!("recovery judge worker stopped: {error}"),
        }
    }
    let sources = tracker
        .recovery
        .records
        .values()
        .flat_map(|records| records.values().map(|r| r.event_id))
        .collect::<HashSet<_>>();
    tracker
        .recovery
        .attempted
        .retain(|source, _| sources.contains(source));
    Ok(())
}

#[cfg(test)]
mod tests;
