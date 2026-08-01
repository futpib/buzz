//! Compute a NIP-OA auth tag for an agent keypair.
//!
//! Usage:
//!   cargo run --release --example compute_auth_tag -- <owner_secret|-> <agent_pubkey_hex> [conditions]
//!
//! Pass `-` to read the owner secret (hex or nsec) from stdin so it does not
//! appear in shell history or the process list.
//!
//! Prints the JSON auth tag to stdout.

use buzz_sdk::nip_oa;
use nostr::{Keys, PublicKey};
use std::io::{self, Read};

fn owner_secret(argument: &str) -> Result<String, String> {
    if argument != "-" {
        return Ok(argument.to_owned());
    }

    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read owner secret from stdin: {error}"))?;
    let secret = input.trim();
    if secret.is_empty() {
        return Err("owner secret from stdin is empty".to_owned());
    }
    Ok(secret.to_owned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!(
            "Usage: {} <owner_secret|-> <agent_pubkey_hex> [conditions]",
            args[0]
        );
        std::process::exit(1);
    }

    let owner_secret = owner_secret(&args[1]).unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(1);
    });
    let owner_keys = Keys::parse(&owner_secret).unwrap_or_else(|_| {
        eprintln!("invalid owner secret key");
        std::process::exit(1);
    });
    let agent_pubkey = PublicKey::from_hex(&args[2]).expect("invalid agent pubkey hex");
    let conditions = args.get(3).map(|s| s.as_str()).unwrap_or("");

    let tag_json = nip_oa::compute_auth_tag(&owner_keys, &agent_pubkey, conditions)
        .expect("failed to compute auth tag");

    println!("{tag_json}");
}
