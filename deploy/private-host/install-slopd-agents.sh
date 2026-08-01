#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_dir="${HOME}/.config/buzz-slopd-agent"
unit_dir="${HOME}/.config/systemd/user"
libexec_dir="${HOME}/.local/libexec"
config_file="${config_dir}/bridge.env"

if [[ ! -f "${config_file}" ]]; then
  install -Dm600 "${script_dir}/slopd-agents.env.example" "${config_file}"
  echo "Created ${config_file}; replace its CHANGE_ME values, then run this command again." >&2
  exit 1
fi

if rg -q 'CHANGE_ME' "${config_file}"; then
  echo "${config_file} still contains CHANGE_ME placeholders." >&2
  exit 1
fi

install -Dm700 "${script_dir}/buzz-slopd-agent" "${libexec_dir}/buzz-slopd-agent"
for unit in \
  buzz-slopd-agent.service \
  buzz-slopd-opencode-agent.service \
  buzz-slopd-claude-agent.service
do
  install -Dm644 "${script_dir}/systemd/${unit}" "${unit_dir}/${unit}"
done

systemctl --user daemon-reload

if [[ "${1:-}" == "--restart" ]]; then
  systemctl --user restart \
    buzz-slopd-agent.service \
    buzz-slopd-opencode-agent.service \
    buzz-slopd-claude-agent.service
fi
