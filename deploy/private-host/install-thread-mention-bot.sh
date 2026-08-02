#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
bridge_config="${BUZZ_AGENT_BRIDGE_CONFIG:-${HOME}/.config/buzz-slopd-agent/bridge.env}"
config_dir="${HOME}/.config/buzz-thread-mention-bot"
identity_file="${config_dir}/identity.env"
auth_file="${config_dir}/auth.env"
unit_dir="${HOME}/.config/systemd/user"
libexec_dir="${HOME}/.local/libexec"
binary="${libexec_dir}/buzz-thread-mention-bot"
unit="buzz-thread-mention-bot.service"
sign=false
restart=false
declare -a channels=()

usage() {
  cat <<'EOF'
Usage: install-thread-mention-bot.sh [OPTIONS]

Build and install the deterministic two-party thread mention bot and its
tracked systemd user service. The first --sign invocation prompts without echo
for the human Buzz owner's nsec and stores only the resulting NIP-OA tag.

  --sign         Sign or refresh the bot's owner attestation.
  --channel UUID Add the bot to a private channel while the owner key is loaded.
                 May be repeated and requires --sign.
  --restart      Enable and restart the installed user service.
  -h, --help     Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --sign)
      sign=true
      ;;
    --channel)
      if (($# < 2)); then
        echo "--channel requires a value" >&2
        exit 2
      fi
      channels+=("$2")
      shift
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

if ((${#channels[@]} > 0)) && [[ "${sign}" != true ]]; then
  echo "--channel requires --sign so the owner can authorize membership" >&2
  exit 2
fi
for channel in "${channels[@]}"; do
  if [[ ! "${channel}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "Invalid channel UUID: ${channel}" >&2
    exit 2
  fi
done
if [[ ! -r "${bridge_config}" ]]; then
  echo "Missing Buzz bridge config: ${bridge_config}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${repo_root}/bin/activate-hermit"
cargo build --quiet --locked -p thread-mention-bot
install -Dm700 "${repo_root}/target/debug/thread-mention-bot" "${binary}"
install -Dm644 "${script_dir}/systemd/${unit}" "${unit_dir}/${unit}"
install -d -m 700 "${config_dir}"

if [[ ! -f "${identity_file}" ]]; then
  bot_secret="$("${binary}" generate-key)"
  if [[ ! "${bot_secret}" =~ ^nsec1[023456789acdefghjklmnpqrstuvwxyz]+$ ]]; then
    echo "Generated bot key is invalid" >&2
    exit 1
  fi
  temporary_identity="$(mktemp "${config_dir}/.identity.env.XXXXXX")"
  printf "BUZZ_BOT_PRIVATE_KEY='%s'\n" "${bot_secret}" >"${temporary_identity}"
  chmod 600 "${temporary_identity}"
  mv -f "${temporary_identity}" "${identity_file}"
  bot_secret=""
  echo "Created ${identity_file}"
fi

if [[ "${sign}" == true ]]; then
  expected_owner="$(sed -n 's/^BUZZ_AGENT_OWNER=//p' "${bridge_config}" | tail -n 1)"
  bot_secret="$(sed -n "s/^BUZZ_BOT_PRIVATE_KEY=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}$/\1/p" "${identity_file}" | tail -n 1)"
  if [[ ! "${expected_owner}" =~ ^[0-9a-f]{64}$ || -z "${bot_secret}" ]]; then
    echo "Bridge owner or bot identity is invalid" >&2
    exit 1
  fi

  owner_secret=""
  trap 'owner_secret=""; bot_secret=""' EXIT
  IFS= read -r -s -p "Buzz owner nsec: " owner_secret </dev/tty
  printf '\n' >/dev/tty
  if [[ -z "${owner_secret}" ]]; then
    echo "Owner secret is empty" >&2
    exit 1
  fi
  auth_tag="$(
    printf '%s\n' "${owner_secret}" |
      BUZZ_BOT_PRIVATE_KEY="${bot_secret}" "${binary}" auth-tag
  )"
  if [[ "${auth_tag}" != "[\"auth\",\"${expected_owner}\","* ]]; then
    echo "The supplied nsec does not match BUZZ_AGENT_OWNER (${expected_owner})" >&2
    exit 1
  fi
  temporary_auth="$(mktemp "${config_dir}/.auth.env.XXXXXX")"
  printf "BUZZ_AUTH_TAG='%s'\n" "${auth_tag}" >"${temporary_auth}"
  chmod 600 "${temporary_auth}"
  mv -f "${temporary_auth}" "${auth_file}"
  echo "Wrote ${auth_file}"

  if ((${#channels[@]} > 0)); then
    relay_url="$(sed -n 's/^BUZZ_RELAY_URL=//p' "${bridge_config}" | tail -n 1)"
    buzz_cli="$(sed -n 's/^BUZZ_CLI_BIN=//p' "${bridge_config}" | tail -n 1)"
    bot_public_key="$(BUZZ_BOT_PRIVATE_KEY="${bot_secret}" "${binary}" public-key)"
    if [[ -z "${relay_url}" || ! -x "${buzz_cli}" ]]; then
      echo "BUZZ_RELAY_URL and executable BUZZ_CLI_BIN are required for --channel" >&2
      exit 1
    fi
    for channel in "${channels[@]}"; do
      BUZZ_PRIVATE_KEY="${owner_secret}" BUZZ_RELAY_URL="${relay_url}" \
        "${buzz_cli}" channels add-member \
        --channel "${channel}" \
        --pubkey "${bot_public_key}" \
        --role bot >/dev/null
      echo "Added thread mention bot to ${channel} as bot"
    done
  fi
  owner_secret=""
  bot_secret=""
fi

systemctl --user daemon-reload
if [[ "${restart}" == true ]]; then
  if [[ ! -r "${auth_file}" ]]; then
    echo "Missing ${auth_file}; run with --sign before --restart" >&2
    exit 1
  fi
  systemctl --user enable "${unit}"
  systemctl --user restart "${unit}"
  echo "Enabled and restarted ${unit}"
elif [[ ! -r "${auth_file}" ]]; then
  echo "Run this command again with --sign --restart to authorize and start the bot."
else
  echo "Run with --restart to restart the installed bot."
fi
