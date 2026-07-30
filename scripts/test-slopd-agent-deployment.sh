#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deployment_dir="${repo_root}/deploy/private-host"
launcher="${deployment_dir}/buzz-slopd-agent"

for unit in \
  buzz-slopd-agent.service \
  buzz-slopd-opencode-agent.service \
  buzz-slopd-claude-agent.service
do
  unit_path="${deployment_dir}/systemd/${unit}"
  if rg -q -- '--no-(base-prompt|memory)' "${unit_path}"; then
    echo "${unit_path} disables the Buzz base prompt or memory" >&2
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

echo "slopd agent deployment checks passed"
