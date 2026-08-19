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
declare -a requested_accounts=()
declare -a channels=()
profile_name=""
profile_about=""
owner_pem=""

usage() {
  cat <<'EOF'
Usage: sign-slopd-agents.sh [OPTIONS]

Prompts without echo for the Buzz owner's nsec, verifies that it matches
BUZZ_AGENT_OWNER, and writes one NIP-OA auth-tag environment file per agent.
The nsec is never written to disk or passed as a command-line argument.

  --agent NAME    Sign only this agent (codex, opencode, claude, grok, or zai).
                  May be repeated. The default is the four slopd agents.
  --channel UUID  Add the selected agent to this channel with role bot.
                  May be repeated and requires exactly one --agent.
  --profile NAME  Publish this display name for the selected agent.
  --about TEXT    Profile description used with --profile.
  --owner-pem PATH
                  Read a host-owned owner key from a mode-0600 secp256k1 PEM
                  instead of prompting. Intended for durable machine users.
  --nsec-stdin  Read the secret from stdin instead of /dev/tty.
  --restart     Restart only the selected agents after provisioning.
EOF
}

while (($# > 0)); do
  case "$1" in
    --agent)
      if (($# < 2)); then
        echo "--agent requires a value" >&2
        exit 2
      fi
      requested_accounts+=("$2")
      shift
      ;;
    --channel)
      if (($# < 2)); then
        echo "--channel requires a value" >&2
        exit 2
      fi
      channels+=("$2")
      shift
      ;;
    --profile)
      if (($# < 2)); then
        echo "--profile requires a value" >&2
        exit 2
      fi
      profile_name="$2"
      shift
      ;;
    --about)
      if (($# < 2)); then
        echo "--about requires a value" >&2
        exit 2
      fi
      profile_about="$2"
      shift
      ;;
    --owner-pem)
      if (($# < 2)); then
        echo "--owner-pem requires a value" >&2
        exit 2
      fi
      owner_pem="$2"
      shift
      ;;
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

if [[ -n "${owner_pem}" && "${read_from_stdin}" == true ]]; then
  echo "--owner-pem and --nsec-stdin are mutually exclusive" >&2
  exit 2
fi

if ((${#requested_accounts[@]} == 0)); then
  requested_accounts=(codex opencode claude grok)
fi
for account in "${requested_accounts[@]}"; do
  case "${account}" in
    codex | opencode | claude | grok | zai) ;;
    *)
      echo "Unsupported agent: ${account}" >&2
      exit 2
      ;;
  esac
done
if ((${#channels[@]} > 0 || ${#profile_name} > 0)) &&
  ((${#requested_accounts[@]} != 1)); then
  echo "--channel and --profile require exactly one --agent" >&2
  exit 2
fi
if [[ -n "${profile_about}" && -z "${profile_name}" ]]; then
  echo "--about requires --profile" >&2
  exit 2
fi
for channel in "${channels[@]}"; do
  if [[ ! "${channel}" =~ ^[0-9a-f-]{36}$ ]]; then
    echo "Invalid channel UUID: ${channel}" >&2
    exit 2
  fi
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
  pushd "${repo_root}" >/dev/null
  cargo build --quiet -p buzz-sdk --example compute_auth_tag
  popd >/dev/null
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
    opencode | claude | grok)
      local identity_override="BUZZ_AGENT_${account^^}_IDENTITY"
      BUZZ_SLOPD_AGENT_IDENTITY_FORMAT=pem \
        BUZZ_SLOPD_AGENT_IDENTITY_FILE="${!identity_override:-${HOME}/.config/buzz-slopd-${account}-agent/identity.pem}" \
        "${launcher}" --public-key
      ;;
    zai)
      BUZZ_SLOPD_AGENT_IDENTITY_FORMAT=pem \
        BUZZ_SLOPD_AGENT_IDENTITY_FILE="${BUZZ_AGENT_ZAI_IDENTITY:-${HOME}/.config/buzz-zai-agent/identity.pem}" \
        "${launcher}" --public-key
      ;;
  esac
}

declare -A agent_pubkeys
for account in "${requested_accounts[@]}"; do
  agent_pubkeys["${account}"]="$(agent_public_key "${account}")"
  if [[ ! "${agent_pubkeys[${account}]}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Could not derive a lowercase hex pubkey for ${account}" >&2
    exit 1
  fi
done

owner_secret=""
trap 'owner_secret=""' EXIT
if [[ -n "${owner_pem}" ]]; then
  if [[ ! -r "${owner_pem}" || "$(stat -c '%a' "${owner_pem}")" != 600 ]]; then
    echo "Owner PEM must be readable and mode 0600: ${owner_pem}" >&2
    exit 1
  fi
  owner_secret="$(
    openssl pkey -in "${owner_pem}" -text -noout 2>/dev/null |
      awk '
        /^priv:/ { in_private = 1; next }
        /^pub:/ { in_private = 0 }
        in_private {
          gsub(/[[:space:]:]/, "")
          printf "%s", $0
        }
      '
  )"
elif [[ "${read_from_stdin}" == true ]]; then
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
for account in "${requested_accounts[@]}"; do
  auth_tags["${account}"]="$(
    printf '%s\n' "${owner_secret}" |
      "${signer}" - "${agent_pubkeys[${account}]}" ""
  )"
  if [[ "${auth_tags[${account}]}" != "[\"auth\",\"${expected_owner}\","* ]]; then
    echo "The supplied nsec does not match BUZZ_AGENT_OWNER (${expected_owner})" >&2
    exit 1
  fi
done

if ((${#channels[@]} > 0)); then
  relay_url="$(sed -n 's/^BUZZ_RELAY_URL=//p' "${bridge_config}" | tail -n 1)"
  buzz_cli="$(sed -n 's/^BUZZ_CLI_BIN=//p' "${bridge_config}" | tail -n 1)"
  if [[ -z "${relay_url}" || ! -x "${buzz_cli}" ]]; then
    echo "BUZZ_RELAY_URL and executable BUZZ_CLI_BIN are required for --channel" >&2
    exit 1
  fi
  account="${requested_accounts[0]}"
  for channel in "${channels[@]}"; do
    BUZZ_PRIVATE_KEY="${owner_secret}" BUZZ_RELAY_URL="${relay_url}" \
      "${buzz_cli}" channels add-member \
      --channel "${channel}" \
      --pubkey "${agent_pubkeys[${account}]}" \
      --role bot >/dev/null
    echo "Added ${account} to ${channel} as bot"
  done
fi
owner_secret=""

install -d -m 700 "${auth_config_dir}"
for account in "${requested_accounts[@]}"; do
  destination="${auth_config_dir}/auth-${account}.env"
  temporary="$(mktemp "${auth_config_dir}/.auth-${account}.env.XXXXXX")"
  printf "BUZZ_AUTH_TAG='%s'\n" "${auth_tags[${account}]}" >"${temporary}"
  chmod 600 "${temporary}"
  mv -f "${temporary}" "${destination}"
  echo "Wrote ${destination}"
done

if [[ -n "${profile_name}" ]]; then
  account="${requested_accounts[0]}"
  relay_url="${relay_url:-$(sed -n 's/^BUZZ_RELAY_URL=//p' "${bridge_config}" | tail -n 1)}"
  buzz_cli="${buzz_cli:-$(sed -n 's/^BUZZ_CLI_BIN=//p' "${bridge_config}" | tail -n 1)}"
  identity_override="BUZZ_AGENT_${account^^}_IDENTITY"
  if [[ "${account}" == codex ]]; then
    identity_format=text
    identity_file="${!identity_override:-${HOME}/.config/buzz-slopd-agent/identity.txt}"
  elif [[ "${account}" == zai ]]; then
    identity_format=pem
    identity_file="${!identity_override:-${HOME}/.config/buzz-zai-agent/identity.pem}"
  else
    identity_format=pem
    identity_file="${!identity_override:-${HOME}/.config/buzz-slopd-${account}-agent/identity.pem}"
  fi
  if [[ -z "${relay_url}" || ! -x "${buzz_cli}" ]]; then
    echo "BUZZ_RELAY_URL and executable BUZZ_CLI_BIN are required for --profile" >&2
    exit 1
  fi
  profile_args=(users set-profile --name "${profile_name}")
  if [[ -n "${profile_about}" ]]; then
    profile_args+=(--about "${profile_about}")
  fi
  BUZZ_RELAY_URL="${relay_url}" \
    BUZZ_CLI_BIN="${buzz_cli}" \
    BUZZ_AUTH_TAG="${auth_tags[${account}]}" \
    BUZZ_SLOPD_AGENT_IDENTITY_FORMAT="${identity_format}" \
    BUZZ_SLOPD_AGENT_IDENTITY_FILE="${identity_file}" \
    "${launcher}" --cli "${profile_args[@]}" >/dev/null
  echo "Published ${account} profile as ${profile_name}"
fi

if [[ "${restart}" == true ]]; then
  declare -a services=()
  for account in "${requested_accounts[@]}"; do
    case "${account}" in
      codex) services+=(buzz-slopd-agent.service) ;;
      opencode) services+=(buzz-slopd-opencode-agent.service) ;;
      claude) services+=(buzz-slopd-claude-agent.service) ;;
      grok) services+=(buzz-slopd-grok-agent.service) ;;
      zai) services+=(buzz-zai-agent.service) ;;
    esac
  done
  systemctl --user daemon-reload
  systemctl --user restart "${services[@]}"
  echo "Restarted ${services[*]}"
else
  echo "Run with --restart, or restart the selected Buzz services manually."
fi
