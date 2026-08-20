#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]] || [[ $# -eq 1 && $1 != --restart ]]; then
  echo "Usage: $0 [--restart]" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_dir="${HOME}/.config/slopd-mcp"
config_file="${config_dir}/service.env"
token_file="${config_dir}/token"
unit_dir="${HOME}/.config/systemd/user"

if [[ ! -f "${config_file}" ]]; then
  install -Dm600 "${script_dir}/slopd-mcp.env.example" "${config_file}"
  echo "Created ${config_file}; replace its CHANGE_ME values, then run this command again." >&2
  exit 1
fi

if rg -q 'CHANGE_ME' "${config_file}"; then
  echo "${config_file} still contains CHANGE_ME placeholders." >&2
  exit 1
fi

if [[ ! -x /usr/bin/slopd-mcp ]]; then
  echo "Missing /usr/bin/slopd-mcp; install the packaged binary first." >&2
  exit 1
fi

if systemctl --user is-active --quiet slopd-mcp-debug.service; then
  echo "slopd-mcp-debug.service is still active; stop and disable it first." >&2
  exit 1
fi

install -d -m 700 "${config_dir}"
if [[ ! -f "${token_file}" ]]; then
  temporary_token="$(mktemp "${config_dir}/.token.XXXXXX")"
  openssl rand -hex -out "${temporary_token}" 32
  chmod 600 "${temporary_token}"
  mv "${temporary_token}" "${token_file}"
  echo "Created ${token_file}"
fi

install -Dm644 \
  "${script_dir}/systemd/slopd-mcp.service" \
  "${unit_dir}/slopd-mcp.service"
systemctl --user daemon-reload
systemctl --user enable --now slopd-mcp.service
if [[ ${1:-} == --restart ]]; then
  systemctl --user restart slopd-mcp.service
fi
