#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
bridge_config="${BUZZ_AGENT_BRIDGE_CONFIG:-${HOME}/.config/buzz-slopd-agent/bridge.env}"
machine_public="${BUZZ_MACHINE_PUBLIC_CONFIG:-${HOME}/.config/buzz-machine/public.env}"
config_dir="${HOME}/.config/buzz-thread-mention-bot"
identity_file="${config_dir}/identity.env"
auth_file="${config_dir}/auth.env"
public_file="${config_dir}/public.env"
avatar_file="${config_dir}/avatar.env"
judge_file="${config_dir}/judge.env"
unit_dir="${HOME}/.config/systemd/user"
libexec_dir="${HOME}/.local/libexec"
binary="${libexec_dir}/buzz-thread-mention-bot"
avatar_source="${script_dir}/agent-avatars/thread-mention-bot.png"
unit="buzz-thread-mention-bot.service"
sign=false
restart=false
judge=false
declare -a channels=()

usage() {
  cat <<'EOF'
Usage: install-thread-mention-bot.sh [OPTIONS]

Build and install the deterministic two-party thread mention bot and its
tracked systemd user service. Standalone mode is allowlisted in the installed
ACP agent services. Optional --sign upgrades the bot to a same-owner identity.

  --sign         Prompt without echo to sign or refresh the owner attestation.
  --channel UUID Add the bot to a private channel while the owner key is loaded.
                 May be repeated and requires --sign.
  --restart      Enable and restart the installed user service.
  --judge        Enable the single-session ACP message judge.
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
    --judge)
      judge=true
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
install -Dm700 "${script_dir}/buzz-slopd-agent" "${libexec_dir}/buzz-slopd-agent"
agent_units=(
  buzz-slopd-agent.service
  buzz-slopd-opencode-agent.service
  buzz-slopd-claude-agent.service
  buzz-zai-agent.service
)
for agent_unit in "${agent_units[@]}"; do
  install -Dm644 "${script_dir}/systemd/${agent_unit}" "${unit_dir}/${agent_unit}"
done
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

set -a
# shellcheck source=/dev/null
source "${bridge_config}"
# shellcheck source=/dev/null
source "${identity_file}"
set +a
expected_owner="${BUZZ_AGENT_OWNER:-}"
bot_secret="${BUZZ_BOT_PRIVATE_KEY:-}"
if [[ ! "${expected_owner}" =~ ^[0-9a-f]{64}$ || -z "${bot_secret}" ]]; then
  echo "Bridge owner or bot identity is invalid" >&2
  exit 1
fi
machine_owner="$(
  if [[ -r "${machine_public}" ]]; then
    unset BUZZ_AGENT_OWNER
    # shellcheck source=/dev/null
    source "${machine_public}"
    printf '%s' "${BUZZ_AGENT_OWNER:-}"
  fi
)"
if [[ -n "${machine_owner}" && ! "${machine_owner}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Machine owner identity is invalid" >&2
  exit 1
fi
owner_pubkeys="${expected_owner}"
if [[ -n "${machine_owner}" && "${machine_owner}" != "${expected_owner}" ]]; then
  owner_pubkeys+=",${machine_owner}"
fi
bot_public_key="$(BUZZ_BOT_PRIVATE_KEY="${bot_secret}" "${binary}" public-key)"
temporary_public="$(mktemp "${config_dir}/.public.env.XXXXXX")"
printf '%s\n' \
  "BUZZ_OWNER_PUBKEY=${expected_owner}" \
  "BUZZ_OWNER_PUBKEYS=${owner_pubkeys}" \
  "BUZZ_THREAD_MENTION_BOT_PUBKEY=${bot_public_key}" \
  >"${temporary_public}"
chmod 600 "${temporary_public}"
mv -f "${temporary_public}" "${public_file}"

if [[ "${judge}" == true ]]; then
  : "${SLOPD_ACP_BIN:?SLOPD_ACP_BIN is required for --judge}"
  slopd_socket="${SLOPD_SOCKET:-${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}/slopd-buzz-agent/slopd.sock}"
  judge_account="${BUZZ_JUDGE_AGENT_ACCOUNT:-codex}"
  judge_backend="${BUZZ_JUDGE_AGENT_BACKEND:-codex}"
  for value in "${SLOPD_ACP_BIN}" "${slopd_socket}" "${judge_account}" "${judge_backend}"; do
    if [[ "${value}" == *","* || "${value}" == *"'"* || "${value}" == *$'\n'* ]]; then
      echo "Judge configuration values must not contain commas, quotes, or newlines" >&2
      exit 1
    fi
  done
  temporary_judge="$(mktemp "${config_dir}/.judge.env.XXXXXX")"
  printf '%s\n' \
    'BUZZ_JUDGE_ENABLED=true' \
    "BUZZ_JUDGE_AGENT_COMMAND='${SLOPD_ACP_BIN}'" \
    "BUZZ_JUDGE_AGENT_ARGS='--socket,${slopd_socket},--account,${judge_account},--backend,${judge_backend}'" \
    >"${temporary_judge}"
  chmod 600 "${temporary_judge}"
  mv -f "${temporary_judge}" "${judge_file}"
  echo "Enabled the ACP message judge with ${judge_backend}/${judge_account}"
fi

relay_url="${BUZZ_RELAY_URL:-}"
buzz_cli="${BUZZ_CLI_BIN:-}"
if [[ -r "${avatar_source}" ]]; then
  if [[ -z "${relay_url}" || ! -x "${buzz_cli}" ]]; then
    echo "BUZZ_RELAY_URL and executable BUZZ_CLI_BIN are required to publish the bot avatar" >&2
    exit 1
  fi
  if ! command -v jq >/dev/null; then
    echo "jq is required to publish the bot avatar" >&2
    exit 1
  fi
  avatar_json="$(
    env -u BUZZ_AUTH_TAG \
      BUZZ_PRIVATE_KEY="${bot_secret}" \
      BUZZ_RELAY_URL="${relay_url}" \
      "${buzz_cli}" upload file --file "${avatar_source}"
  )"
  avatar_url="$(printf '%s' "${avatar_json}" | jq -r '.url // empty')"
  if [[ ! "${avatar_url}" =~ ^https?:// ]] ||
    [[ "${avatar_url}" == *[[:space:]]* ]] ||
    [[ "${avatar_url}" == *"'"* ]]; then
    echo "Bot avatar upload returned an invalid URL" >&2
    exit 1
  fi
  temporary_avatar="$(mktemp "${config_dir}/.avatar.env.XXXXXX")"
  printf "BUZZ_BOT_PICTURE_URL='%s'\n" "${avatar_url}" >"${temporary_avatar}"
  chmod 600 "${temporary_avatar}"
  mv -f "${temporary_avatar}" "${avatar_file}"
  echo "Published thread mention bot avatar"
fi

if [[ "${sign}" == true ]]; then
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
  systemctl --user enable "${unit}"
  systemctl --user restart "${unit}"
  systemctl --user try-restart "${agent_units[@]}"
  echo "Enabled and restarted ${unit} and refreshed active ACP agents"
elif [[ ! -r "${auth_file}" ]]; then
  echo "Run with --restart for standalone allowlisted mode, or --sign --restart for owner-attested mode."
else
  echo "Run with --restart to restart the installed bot."
fi
