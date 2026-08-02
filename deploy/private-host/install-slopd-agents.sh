#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
config_dir="${HOME}/.config/buzz-slopd-agent"
machine_config_dir="${HOME}/.config/buzz-machine"
zai_config_dir="${HOME}/.config/buzz-zai-agent"
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
pushd "${repo_root}" >/dev/null
cargo build --quiet -p buzz-sdk --example compute_auth_tag
popd >/dev/null
install -Dm700 \
  "${repo_root}/target/debug/examples/compute_auth_tag" \
  "${libexec_dir}/buzz-compute-auth-tag"
install -Dm700 "${script_dir}/sign-slopd-agents.sh" "${libexec_dir}/sign-slopd-agents"
install -Dm700 "${script_dir}/buzz-machine" "${HOME}/.local/bin/buzz-machine"
install -d -m 700 "${machine_config_dir}"
if [[ ! -f "${machine_config_dir}/identity.pem" ]]; then
  temporary_identity="$(mktemp "${machine_config_dir}/.identity.pem.XXXXXX")"
  openssl genpkey -algorithm EC \
    -pkeyopt ec_paramgen_curve:secp256k1 \
    -out "${temporary_identity}" \
    2>/dev/null
  chmod 600 "${temporary_identity}"
  mv "${temporary_identity}" "${machine_config_dir}/identity.pem"
  echo "Created ${machine_config_dir}/identity.pem"
fi
machine_public_key="$(
  BUZZ_SLOPD_AGENT_IDENTITY_FORMAT=pem \
    BUZZ_SLOPD_AGENT_IDENTITY_FILE="${machine_config_dir}/identity.pem" \
    "${libexec_dir}/buzz-slopd-agent" --public-key
)"
human_public_key="$(sed -n 's/^BUZZ_AGENT_OWNER=//p' "${config_file}" | tail -n 1)"
temporary_config="$(mktemp "${machine_config_dir}/.public.env.XXXXXX")"
printf '%s\n' \
  "BUZZ_AGENT_OWNER=${machine_public_key}" \
  'BUZZ_AGENT_RESPOND_TO=allowlist' \
  "BUZZ_AGENT_RESPOND_TO_ALLOWLIST=${human_public_key}" \
  >"${temporary_config}"
chmod 600 "${temporary_config}"
mv -f "${temporary_config}" "${machine_config_dir}/public.env"
install -d -m 700 "${zai_config_dir}"
if [[ ! -f "${zai_config_dir}/identity.pem" ]]; then
  temporary_identity="$(mktemp "${zai_config_dir}/.identity.pem.XXXXXX")"
  openssl genpkey -algorithm EC \
    -pkeyopt ec_paramgen_curve:secp256k1 \
    -out "${temporary_identity}" \
    2>/dev/null
  chmod 600 "${temporary_identity}"
  mv "${temporary_identity}" "${zai_config_dir}/identity.pem"
  echo "Created ${zai_config_dir}/identity.pem"
fi
for unit in \
  buzz-slopd-agent.service \
  buzz-slopd-opencode-agent.service \
  buzz-slopd-claude-agent.service \
  buzz-zai-agent.service
do
  install -Dm644 "${script_dir}/systemd/${unit}" "${unit_dir}/${unit}"
done

systemctl --user daemon-reload

if [[ "${1:-}" == "--restart" ]]; then
  systemctl --user restart \
    buzz-slopd-agent.service \
    buzz-slopd-opencode-agent.service \
    buzz-slopd-claude-agent.service \
    buzz-zai-agent.service
elif [[ "${1:-}" == "--restart-zai" ]]; then
  systemctl --user restart buzz-zai-agent.service
fi
