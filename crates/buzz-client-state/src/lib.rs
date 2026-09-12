#![deny(unsafe_code)]
#![warn(missing_docs)]
//! Async, disposable SQLite projections for latency-sensitive Buzz clients.
//!
//! The relay remains authoritative. This crate keeps a scope-fenced local copy
//! shaped for immediate paint: channels, unread state, activity, search,
//! messages, threads, and reactions. All SQLite work runs off the async runtime
//! and every projection can be rebuilt from relay events.

mod model;
mod project;
mod query;
mod schema;
mod store;

pub use model::{
    ActivityCategory, ActivityItem, ApplyStats, ChannelListItem, Message, PageCursor,
    ProjectionScope, ReactionGroup, ReadMarker, SearchHit, Thread,
};
pub use store::{ClientState, ClientStateError, EnqueueError, OpenOptions};
