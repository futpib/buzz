#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
bridge_config="${BUZZ_AGENT_BRIDGE_CONFIG:-${HOME}/.config/buzz-slopd-agent/bridge.env}"
auth_config_dir="${BUZZ_AGENT_AUTH_CONFIG_DIR:-${HOME}/.config/buzz-slopd-agent}"
if [[ -n "${BUZZ_AUTH_TAG_SIGNER:-}" ]]; then
  signer="${BUZZ_AUTH_TAG_SIGNER}"
elif [[ -x "${script_dir}/buzz-compute-auth-tag" ]]; then
  signer="${script_dir}/buzz-compute-auth-tag"
else
  signer="${repo_root}/target/debug/examples/compute_auth_tag"
fi
read_from_stdin=false
restart=false

usage() {
  cat <<'EOF'
Usage: sign-slopd-agents.sh [--nsec-stdin] [--restart]

Prompts without echo for the Buzz owner's nsec, verifies that it matches
BUZZ_AGENT_OWNER, and writes one NIP-OA auth-tag environment file per agent.
The nsec is never written to disk or passed as a command-line argument.

  --nsec-stdin  Read the secret from stdin instead of /dev/tty.
  --restart     Restart all three Buzz/slopd bridges after writing the tags.
EOF
}

while (($# > 0)); do
  case "$1" in
    --nsec-stdin)
      read_from_stdin=true
      ;;
    --restart)
      restart=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ ! -r "${bridge_config}" ]]; then
  echo "Missing bridge config: ${bridge_config}" >&2
  exit 1
fi

expected_owner="${BUZZ_AGENT_EXPECTED_OWNER:-$(
  sed -n 's/^BUZZ_AGENT_OWNER=//p' "${bridge_config}" | tail -n 1
)}"
if [[ ! "${expected_owner}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "BUZZ_AGENT_OWNER must be a 64-character lowercase hex pubkey" >&2
  exit 1
fi

if [[ ! -x "${signer}" ]]; then
  if [[ ! -f "${repo_root}/Cargo.toml" ]]; then
    echo "Auth-tag signer is not installed beside this script; rerun install-slopd-agents.sh" >&2
    exit 1
  fi
  cargo build --quiet --manifest-path "${repo_root}/Cargo.toml" \
    -p buzz-sdk --example compute_auth_tag
fi
if [[ ! -x "${signer}" ]]; then
  echo "Auth-tag signer was not built: ${signer}" >&2
  exit 1
fi

launcher="${script_dir}/buzz-slopd-agent"
agent_public_key() {
  local account="$1"
  local override_name="BUZZ_AGENT_${account^^}_PUBKEY"
  local override="${!override_name:-}"
  if [[ -n "${override}" ]]; then
    printf '%s\n' "${override}"
    return
  fi

  case "${account}" in
    codex)
      BUZZ_SLOPD_AGENT_IDENTITY_FORMAT=text \
        BUZZ_SLOPD_AGENT_IDENTITY_FILE="${BUZZ_AGENT_CODEX_IDENTITY:-${HOME}/.config/buzz-slopd-agent/identity.txt}" \
        "${launcher}" --public-key
      ;;
    opencode | claude)
      local identity_override="BUZZ_AGENT_${account^^}_IDENTITY"
      BUZZ_SLOPD_AGENT_IDENTITY_FORMAT=pem \
        BUZZ_SLOPD_AGENT_IDENTITY_FILE="${!identity_override:-${HOME}/.config/buzz-slopd-${account}-agent/identity.pem}" \
        "${launcher}" --public-key
      ;;
  esac
}

declare -A agent_pubkeys
for account in codex opencode claude; do
  agent_pubkeys["${account}"]="$(agent_public_key "${account}")"
  if [[ ! "${agent_pubkeys[${account}]}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Could not derive a lowercase hex pubkey for ${account}" >&2
    exit 1
  fi
done

owner_secret=""
trap 'owner_secret=""' EXIT
if [[ "${read_from_stdin}" == true ]]; then
  IFS= read -r owner_secret
else
  IFS= read -r -s -p "Buzz owner nsec: " owner_secret </dev/tty
  printf '\n' >/dev/tty
fi
if [[ -z "${owner_secret}" ]]; then
  echo "Owner secret is empty" >&2
  exit 1
fi

declare -A auth_tags
for account in codex opencode claude; do
  auth_tags["${account}"]="$(
    printf '%s\n' "${owner_secret}" |
      "${signer}" - "${agent_pubkeys[${account}]}" ""
  )"
  if [[ "${auth_tags[${account}]}" != "[\"auth\",\"${expected_owner}\","* ]]; then
    echo "The supplied nsec does not match BUZZ_AGENT_OWNER (${expected_owner})" >&2
    exit 1
  fi
done
owner_secret=""

install -d -m 700 "${auth_config_dir}"
for account in codex opencode claude; do
  destination="${auth_config_dir}/auth-${account}.env"
  temporary="$(mktemp "${auth_config_dir}/.auth-${account}.env.XXXXXX")"
  printf "BUZZ_AUTH_TAG='%s'\n" "${auth_tags[${account}]}" >"${temporary}"
  chmod 600 "${temporary}"
  mv -f "${temporary}" "${destination}"
  echo "Wrote ${destination}"
done

if [[ "${restart}" == true ]]; then
  systemctl --user daemon-reload
  systemctl --user restart \
    buzz-slopd-agent.service \
    buzz-slopd-opencode-agent.service \
    buzz-slopd-claude-agent.service
  echo "Restarted all three Buzz/slopd bridges"
else
  echo "Run with --restart, or restart the three Buzz/slopd services manually."
fi
