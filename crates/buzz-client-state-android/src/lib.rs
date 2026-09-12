#![deny(unsafe_code)]
#![warn(missing_docs)]
//! JSON-command JNI bridge for `buzz-client-state`.
//!
//! Kotlin owns scheduling and never calls this library from Android's main
//! thread. The bridge owns one Tokio runtime per open projection; the read
//! model itself keeps SQLite and signature verification on blocking workers.

use std::{
    collections::HashMap,
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use buzz_client_state::{ClientState, PageCursor, ProjectionScope, ReadMarker};
use buzz_core::Event;
use jni::{
    objects::{JObject, JString},
    sys::{jlong, jstring},
    JNIEnv,
};
use serde::Deserialize;
use serde_json::{json, Value};

static NEXT_HANDLE: AtomicI64 = AtomicI64::new(1);
static BRIDGES: OnceLock<Mutex<HashMap<i64, Arc<ClientStateBridge>>>> = OnceLock::new();

/// Errors produced by the platform bridge itself.
#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    /// Tokio runtime creation failed.
    #[error("client-state runtime creation failed: {0}")]
    Runtime(#[from] std::io::Error),
    /// Read-model operation failed.
    #[error(transparent)]
    State(#[from] buzz_client_state::ClientStateError),
    /// JSON command or response was invalid.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// JNI string conversion failed.
    #[error(transparent)]
    Jni(#[from] jni::errors::Error),
    /// A native handle is absent or was already closed.
    #[error("unknown client-state handle {0}")]
    UnknownHandle(i64),
    /// The global native registry was poisoned by a prior panic.
    #[error("client-state registry is unavailable")]
    RegistryPoisoned,
}

/// One open native projection and its asynchronous runtime.
pub struct ClientStateBridge {
    state: ClientState,
    runtime: tokio::runtime::Runtime,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Command {
    Apply {
        events: Vec<Event>,
    },
    ApplyReadMarkers {
        markers: Vec<ReadMarker>,
    },
    Flush,
    Channels {
        #[serde(default = "default_true")]
        members_only: bool,
    },
    ChannelMessages {
        channel_id: String,
        cursor: Option<PageCursor>,
        limit: u32,
    },
    ChannelEvents {
        channel_id: String,
        limit: u32,
    },
    Thread {
        root_id: String,
        limit: u32,
    },
    ThreadEvents {
        root_id: String,
        limit: u32,
    },
    Activity {
        limit: u32,
    },
    Search {
        text: String,
        limit: u32,
    },
}

fn default_true() -> bool {
    true
}

impl ClientStateBridge {
    /// Open one projection database for a relay/viewer scope.
    pub fn open(
        path: impl Into<PathBuf>,
        relay_url: impl Into<String>,
        viewer_pubkey: impl Into<String>,
    ) -> Result<Self, BridgeError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("buzz-client-state")
            .build()?;
        let state = runtime.block_on(ClientState::open(
            path,
            ProjectionScope::new(relay_url, viewer_pubkey),
        ))?;
        // Keep the runtime last so the state sender drops before Tokio waits
        // for the blocking projection worker during bridge shutdown.
        Ok(Self { state, runtime })
    }

    /// Execute one JSON command and return a stable success/error envelope.
    pub fn execute(&self, request_json: &str) -> String {
        match self.execute_inner(request_json) {
            Ok(value) => response_json(true, value, None),
            Err(error) => response_json(false, Value::Null, Some(error.to_string())),
        }
    }

    fn execute_inner(&self, request_json: &str) -> Result<Value, BridgeError> {
        let command: Command = serde_json::from_str(request_json)?;
        let value = match command {
            Command::Apply { events } => {
                serde_json::to_value(self.runtime.block_on(self.state.apply(events))?)?
            }
            Command::ApplyReadMarkers { markers } => json!(self
                .runtime
                .block_on(self.state.apply_read_markers(markers))?),
            Command::Flush => json!(self.runtime.block_on(self.state.flush())?),
            Command::Channels { members_only } => {
                serde_json::to_value(self.runtime.block_on(self.state.channels(members_only))?)?
            }
            Command::ChannelMessages {
                channel_id,
                cursor,
                limit,
            } => serde_json::to_value(
                self.runtime
                    .block_on(self.state.channel_messages(channel_id, cursor, limit))?,
            )?,
            Command::ChannelEvents { channel_id, limit } => serde_json::to_value(
                self.runtime
                    .block_on(self.state.channel_events(channel_id, limit))?,
            )?,
            Command::Thread { root_id, limit } => {
                serde_json::to_value(self.runtime.block_on(self.state.thread(root_id, limit))?)?
            }
            Command::ThreadEvents { root_id, limit } => serde_json::to_value(
                self.runtime
                    .block_on(self.state.thread_events(root_id, limit))?,
            )?,
            Command::Activity { limit } => {
                serde_json::to_value(self.runtime.block_on(self.state.activity(limit))?)?
            }
            Command::Search { text, limit } => {
                serde_json::to_value(self.runtime.block_on(self.state.search(text, limit))?)?
            }
        };
        Ok(value)
    }
}

fn response_json(ok: bool, value: Value, error: Option<String>) -> String {
    serde_json::to_string(&json!({"ok": ok, "value": value, "error": error})).unwrap_or_else(|_| {
        "{\"ok\":false,\"value\":null,\"error\":\"response encode failed\"}".to_string()
    })
}

fn registry() -> &'static Mutex<HashMap<i64, Arc<ClientStateBridge>>> {
    BRIDGES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn insert_bridge(bridge: ClientStateBridge) -> Result<i64, BridgeError> {
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    registry()
        .lock()
        .map_err(|_| BridgeError::RegistryPoisoned)?
        .insert(handle, Arc::new(bridge));
    Ok(handle)
}

fn get_bridge(handle: i64) -> Result<Arc<ClientStateBridge>, BridgeError> {
    registry()
        .lock()
        .map_err(|_| BridgeError::RegistryPoisoned)?
        .get(&handle)
        .cloned()
        .ok_or(BridgeError::UnknownHandle(handle))
}

fn remove_bridge(handle: i64) -> Result<(), BridgeError> {
    registry()
        .lock()
        .map_err(|_| BridgeError::RegistryPoisoned)?
        .remove(&handle);
    Ok(())
}

fn java_string(env: &mut JNIEnv<'_>, value: JString<'_>) -> Result<String, BridgeError> {
    Ok(env.get_string(&value)?.into())
}

fn throw_runtime(env: &mut JNIEnv<'_>, error: impl std::fmt::Display) {
    let _ = env.throw_new("java/lang/RuntimeException", error.to_string());
}

/// Open a native client-state handle.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "system" fn Java_xyz_block_buzz_mobile_ClientStateNative_open(
    mut env: JNIEnv<'_>,
    _receiver: JObject<'_>,
    path: JString<'_>,
    relay_url: JString<'_>,
    viewer_pubkey: JString<'_>,
) -> jlong {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let bridge = ClientStateBridge::open(
            java_string(&mut env, path)?,
            java_string(&mut env, relay_url)?,
            java_string(&mut env, viewer_pubkey)?,
        )?;
        insert_bridge(bridge)
    }));
    match result {
        Ok(Ok(handle)) => handle,
        Ok(Err(error)) => {
            throw_runtime(&mut env, error);
            0
        }
        Err(_) => {
            throw_runtime(&mut env, "client-state native open panicked");
            0
        }
    }
}

/// Execute a JSON command on a native client-state handle.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "system" fn Java_xyz_block_buzz_mobile_ClientStateNative_execute(
    mut env: JNIEnv<'_>,
    _receiver: JObject<'_>,
    handle: jlong,
    request_json: JString<'_>,
) -> jstring {
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<String, BridgeError> {
        let request = java_string(&mut env, request_json)?;
        Ok(get_bridge(handle)?.execute(&request))
    }));
    let value = match result {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => response_json(false, Value::Null, Some(error.to_string())),
        Err(_) => response_json(
            false,
            Value::Null,
            Some("client-state native command panicked".to_string()),
        ),
    };
    match env.new_string(value) {
        Ok(value) => value.into_raw(),
        Err(error) => {
            throw_runtime(&mut env, error);
            std::ptr::null_mut()
        }
    }
}

/// Close a native client-state handle.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "system" fn Java_xyz_block_buzz_mobile_ClientStateNative_close(
    mut env: JNIEnv<'_>,
    _receiver: JObject<'_>,
    handle: jlong,
) {
    let result = catch_unwind(AssertUnwindSafe(|| remove_bridge(handle)));
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => throw_runtime(&mut env, error),
        Err(_) => throw_runtime(&mut env, "client-state native close panicked"),
    }
}
