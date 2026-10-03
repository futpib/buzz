#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
declare -a channels=()
start=false
while (($#)); do
  case "$1" in
    --channel)
      [[ $# -ge 2 && "$2" =~ ^[0-9a-f-]{36}$ ]] || { echo 'Expected --channel UUID' >&2; exit 2; }
      channels+=(--channel "$2")
      shift
      ;;
    --start) start=true ;;
    -h|--help)
      echo 'Usage: install-codex-presets.sh [--channel UUID ...] [--start]'
      echo 'Install sol/astra × medium/xhigh using the existing machine owner and Codex login.'
      echo '--start enables and starts the four bridges; already-running bridges stay running.'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

machine_dir="${HOME}/.config/buzz-machine"
slopd_config="${HOME}/.config/slopd-buzz-agent/config.toml"
libexec="${HOME}/.local/libexec"
for required in "${machine_dir}/identity.pem" "${machine_dir}/public.env" \
  "${HOME}/.config/buzz-slopd-agent/bridge.env" "${slopd_config}" \
  "${libexec}/buzz-compute-auth-tag"; do
  [[ -r "${required}" ]] || { echo "Missing prerequisite: ${required}; run install-slopd-agents.sh first" >&2; exit 1; }
done
# shellcheck source=/dev/null
source "${machine_dir}/public.env"
export BUZZ_AGENT_EXPECTED_OWNER="${BUZZ_AGENT_OWNER}"
export BUZZ_AUTH_TAG_SIGNER="${libexec}/buzz-compute-auth-tag"
# This is a standalone machine-owned operation, not the invoking agent's identity.
unset BUZZ_AUTH_TAG

python3 "${script_dir}/configure-codex-presets.py" "${slopd_config}"
install -Dm700 "${script_dir}/buzz-slopd-agent" "${libexec}/buzz-slopd-agent"
install -Dm700 "${script_dir}/sign-slopd-agents.sh" "${libexec}/sign-slopd-agents"
install -Dm644 "${script_dir}/systemd/buzz-slopd-codex@.service" \
  "${HOME}/.config/systemd/user/buzz-slopd-codex@.service"

declare -a services=()
for model in sol astra; do
  for effort in medium xhigh; do
    account="codex-${model}-${effort}"
    identity_dir="${HOME}/.config/buzz-slopd-${account}-agent"
    install -d -m 700 "${identity_dir}"
    if [[ ! -f "${identity_dir}/identity.pem" ]]; then
      temporary="$(mktemp "${identity_dir}/.identity.XXXXXX")"
      openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:secp256k1 \
        -out "${temporary}" 2>/dev/null
      chmod 600 "${temporary}"
      mv "${temporary}" "${identity_dir}/identity.pem"
    fi
    "${libexec}/sign-slopd-agents" --agent "${account}" \
      --owner-pem "${machine_dir}/identity.pem" "${channels[@]}" \
      --profile "slopd-${account}" \
      --about "Codex via slopd: gpt-6-${model}, ${effort} reasoning. Separate per-thread sessions."
    services+=("buzz-slopd-codex@${model}-${effort}.service")
  done
done
systemctl --user daemon-reload
# SIGHUP only changes future sessions; never restart the shared daemon here.
systemctl --user kill --kill-whom=main --signal=HUP slopd-buzz-agent.service
if [[ "${start}" == true ]]; then
  systemctl --user enable --now "${services[@]}"
fi
