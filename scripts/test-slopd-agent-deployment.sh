#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deployment_dir="${repo_root}/deploy/private-host"
launcher="${deployment_dir}/buzz-slopd-agent"

for unit in \
  buzz-slopd-agent.service \
  buzz-slopd-opencode-agent.service \
  buzz-slopd-claude-agent.service \
  buzz-zai-agent.service
do
  unit_path="${deployment_dir}/systemd/${unit}"
  if rg -q -- '--no-(base-prompt|memory)' "${unit_path}"; then
    echo "${unit_path} disables the Buzz base prompt or memory" >&2
    exit 1
  fi
done

if ! rg -q -F 'Environment=BUZZ_AGENT_COMMAND=/usr/bin/opencode' \
  "${deployment_dir}/systemd/buzz-zai-agent.service"; then
  echo "buzz-zai-agent.service does not use OpenCode directly" >&2
  exit 1
fi
if rg -q -F 'slopd-buzz-agent.service' \
  "${deployment_dir}/systemd/buzz-zai-agent.service"; then
  echo "buzz-zai-agent.service unexpectedly depends on slopd" >&2
  exit 1
fi
if ! rg -q -F 'EnvironmentFile=%h/.config/buzz-machine/public.env' \
  "${deployment_dir}/systemd/buzz-zai-agent.service"; then
  echo "buzz-zai-agent.service does not load its machine owner identity" >&2
  exit 1
fi

declare -A expected_auth_files=(
  [buzz-slopd-agent.service]=auth-codex.env
  [buzz-slopd-opencode-agent.service]=auth-opencode.env
  [buzz-slopd-claude-agent.service]=auth-claude.env
  [buzz-zai-agent.service]=auth-zai.env
)
for unit in "${!expected_auth_files[@]}"; do
  if ! rg -q -F "EnvironmentFile=-%h/.config/buzz-slopd-agent/${expected_auth_files[${unit}]}" \
    "${deployment_dir}/systemd/${unit}"; then
    echo "${unit} does not load its per-agent NIP-OA auth tag" >&2
    exit 1
  fi
done

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

identity_file="${tmp_dir}/identity.txt"
printf '%s\n' \
  'Public key: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'Secret key: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  >"${identity_file}"

direct_output="$(
  env \
    BUZZ_SLOPD_AGENT_IDENTITY_FILE="${identity_file}" \
    BUZZ_ACP_BIN=/usr/bin/echo \
    BUZZ_RELAY_WS_URL=wss://relay.example.test \
    BUZZ_AGENT_OWNER=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
    BUZZ_AGENT_COMMAND=/usr/bin/opencode \
    BUZZ_AGENT_ARGS=acp,--pure \
    BUZZ_AGENT_SESSION_TITLE='z.ai glm-4.7' \
    "${launcher}"
)"
for expected in \
  '--agent-command /usr/bin/opencode' \
  '--agent-args=acp,--pure' \
  '--session-title z.ai glm-4.7'
do
  if [[ "${direct_output}" != *"${expected}"* ]]; then
    echo "direct launcher output is missing: ${expected}" >&2
    exit 1
  fi
done

allowlist_output="$(
  env \
    BUZZ_SLOPD_AGENT_IDENTITY_FILE="${identity_file}" \
    BUZZ_ACP_BIN=/usr/bin/echo \
    BUZZ_RELAY_WS_URL=wss://relay.example.test \
    BUZZ_AGENT_OWNER=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
    BUZZ_AGENT_COMMAND=/usr/bin/opencode \
    BUZZ_AGENT_RESPOND_TO=allowlist \
    BUZZ_AGENT_RESPOND_TO_ALLOWLIST=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd \
    BUZZ_AGENT_SESSION_TITLE='z.ai glm-4.7' \
    "${launcher}"
)"
for expected in \
  '--respond-to allowlist' \
  '--respond-to-allowlist dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
do
  if [[ "${allowlist_output}" != *"${expected}"* ]]; then
    echo "allowlist launcher output is missing: ${expected}" >&2
    exit 1
  fi
done

output="$(
  env \
    BUZZ_SLOPD_AGENT_IDENTITY_FILE="${identity_file}" \
    BUZZ_ACP_BIN=/usr/bin/echo \
    BUZZ_RELAY_WS_URL=wss://relay.example.test \
    BUZZ_AGENT_OWNER=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
    SLOPD_ACP_BIN=/opt/slopd-acp \
    BUZZ_AGENT_ACCOUNT=codex \
    BUZZ_AGENT_BACKEND=codex \
    BUZZ_AGENT_SESSION_TITLE='slopd codex' \
    XDG_RUNTIME_DIR="${tmp_dir}" \
    "${launcher}"
)"

if [[ "${output}" == *--no-base-prompt* || "${output}" == *--no-memory* ]]; then
  echo "launcher disabled the Buzz base prompt or memory" >&2
  exit 1
fi

for expected in \
  '--relay-url wss://relay.example.test' \
  '--relay-observer' \
  '--agent-command /opt/slopd-acp' \
  "--agent-args=--socket,${tmp_dir}/slopd-buzz-agent/slopd.sock,--account,codex,--backend,codex,--forward-buzz-env" \
  '--respond-to owner-only' \
  '--session-title slopd codex'
do
  if [[ "${output}" != *"${expected}"* ]]; then
    echo "launcher output is missing: ${expected}" >&2
    exit 1
  fi
done

pem_file="${tmp_dir}/identity.pem"
openssl genpkey -algorithm EC \
  -pkeyopt ec_paramgen_curve:secp256k1 \
  -out "${pem_file}" \
  2>/dev/null
pem_public_key="$(
  BUZZ_SLOPD_AGENT_IDENTITY_FORMAT=pem \
    BUZZ_SLOPD_AGENT_IDENTITY_FILE="${pem_file}" \
    "${launcher}" --public-key
)"
if [[ ! "${pem_public_key}" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "launcher did not derive a valid public key from a PEM identity" >&2
  exit 1
fi

pushd "${repo_root}" >/dev/null
cargo build --quiet -p buzz-sdk --example compute_auth_tag
popd >/dev/null
signer="${repo_root}/target/debug/examples/compute_auth_tag"
installed_libexec="${tmp_dir}/installed-libexec"
install -Dm700 "${deployment_dir}/sign-slopd-agents.sh" \
  "${installed_libexec}/sign-slopd-agents"
install -Dm700 "${signer}" "${installed_libexec}/buzz-compute-auth-tag"
auth_config_dir="${tmp_dir}/auth-config"
bridge_config="${tmp_dir}/bridge.env"
printf '%s\n' \
  'BUZZ_AGENT_OWNER=79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' \
  >"${bridge_config}"
test_agent_pubkey=c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5
test_owner_nsec=nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgl
printf '%s\n' "${test_owner_nsec}" |
  env \
    BUZZ_AGENT_BRIDGE_CONFIG="${bridge_config}" \
    BUZZ_AGENT_AUTH_CONFIG_DIR="${auth_config_dir}" \
    BUZZ_AGENT_CODEX_PUBKEY="${test_agent_pubkey}" \
    BUZZ_AGENT_OPENCODE_PUBKEY="${test_agent_pubkey}" \
    BUZZ_AGENT_CLAUDE_PUBKEY="${test_agent_pubkey}" \
    "${installed_libexec}/sign-slopd-agents" --nsec-stdin

for account in codex opencode claude; do
  auth_file="${auth_config_dir}/auth-${account}.env"
  if [[ "$(stat -c '%a' "${auth_file}")" != 600 ]]; then
    echo "${auth_file} is not mode 0600" >&2
    exit 1
  fi
  if ! rg -q -F \
    "BUZZ_AUTH_TAG='[\"auth\",\"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798\",\"\"," \
    "${auth_file}"; then
    echo "${auth_file} does not contain the expected owner attestation" >&2
    exit 1
  fi
done

zai_auth_config_dir="${tmp_dir}/zai-auth-config"
printf '%s\n' "${test_owner_nsec}" |
  env \
    BUZZ_AGENT_BRIDGE_CONFIG="${bridge_config}" \
    BUZZ_AGENT_AUTH_CONFIG_DIR="${zai_auth_config_dir}" \
    BUZZ_AGENT_ZAI_PUBKEY="${test_agent_pubkey}" \
    "${installed_libexec}/sign-slopd-agents" --nsec-stdin --agent zai
if [[ "$(stat -c '%a' "${zai_auth_config_dir}/auth-zai.env")" != 600 ]]; then
  echo "Z.AI auth file is not mode 0600" >&2
  exit 1
fi
if [[ -e "${zai_auth_config_dir}/auth-codex.env" ]]; then
  echo "single-agent signing unexpectedly wrote another agent's auth file" >&2
  exit 1
fi

pem_owner_auth_config_dir="${tmp_dir}/pem-owner-auth-config"
env \
  BUZZ_AGENT_BRIDGE_CONFIG="${bridge_config}" \
  BUZZ_AGENT_EXPECTED_OWNER="${pem_public_key}" \
  BUZZ_AGENT_AUTH_CONFIG_DIR="${pem_owner_auth_config_dir}" \
  BUZZ_AGENT_ZAI_PUBKEY="${test_agent_pubkey}" \
  "${installed_libexec}/sign-slopd-agents" \
  --agent zai \
  --owner-pem "${pem_file}"
if [[ ! -f "${pem_owner_auth_config_dir}/auth-zai.env" ]]; then
  echo "PEM owner signing did not write the selected agent auth file" >&2
  exit 1
fi

wrong_auth_config_dir="${tmp_dir}/wrong-auth-config"
if printf '%064d\n' 2 |
  env \
    BUZZ_AGENT_BRIDGE_CONFIG="${bridge_config}" \
    BUZZ_AGENT_AUTH_CONFIG_DIR="${wrong_auth_config_dir}" \
    BUZZ_AGENT_CODEX_PUBKEY="${test_agent_pubkey}" \
    BUZZ_AGENT_OPENCODE_PUBKEY="${test_agent_pubkey}" \
    BUZZ_AGENT_CLAUDE_PUBKEY="${test_agent_pubkey}" \
    "${installed_libexec}/sign-slopd-agents" --nsec-stdin 2>/dev/null; then
  echo "signing accepted an nsec that does not match BUZZ_AGENT_OWNER" >&2
  exit 1
fi
if [[ -d "${wrong_auth_config_dir}" ]] &&
  find "${wrong_auth_config_dir}" -type f -print -quit | rg -q .; then
  echo "signing wrote auth files before rejecting the wrong nsec" >&2
  exit 1
fi

echo "slopd agent deployment checks passed"
