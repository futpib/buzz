//! An owner's explicit recipient outranks inferred activity, including failures
//! from a previously selected worker. Reconstruct from history after restart.
use super::*;

pub(super) fn latest(events: &[Event], owners: &[PublicKey], bot: &PublicKey) -> Option<PublicKey> {
    events
        .iter()
        .filter(|event| event.kind == Kind::Custom(9) && owners.contains(&event.pubkey))
        .filter_map(|event| {
            let recipient = PublicKey::parse(unique_event_tag_value(event, "p")?).ok()?;
            (!owners.contains(&recipient) && recipient != *bot).then_some((event, recipient))
        })
        .max_by_key(|(event, _)| (event.created_at, event.id))
        .map(|(_, recipient)| recipient)
}

pub(super) fn allows(config: &Config, events: &[Event], agent: PublicKey) -> bool {
    latest(events, &config.owner_pubkeys, &config.bot_keys.public_key())
        .is_none_or(|selected| selected == agent)
}

pub(super) async fn current(config: &Config, key: ThreadKey, agent: PublicKey) -> Result<bool> {
    let events = load_thread(config, key.channel_id, key.root_event_id).await?;
    Ok(allows(config, &events, agent))
}

pub(super) fn job_key(job: &JudgeJob) -> ThreadKey {
    ThreadKey {
        channel_id: job.channel_id,
        root_event_id: parse_thread_relation(&job.target)
            .map_or(job.target.id, |r| r.root_event_id),
    }
}
