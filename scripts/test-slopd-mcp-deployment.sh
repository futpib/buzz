#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
caddyfile="${repo_root}/deploy/vps-edge/Caddyfile"
unit="${repo_root}/deploy/private-host/systemd/slopd-mcp.service"

bash -n "${repo_root}/deploy/private-host/install-slopd-mcp.sh"

for route in \
  '/mcp' \
  '/mcp/*' \
  '/.well-known/oauth-protected-resource' \
  '/.well-known/oauth-protected-resource/*' \
  '/.well-known/oauth-authorization-server' \
  '/.well-known/oauth-authorization-server/*' \
  '/oauth/register' \
  '/oauth/authorize' \
  '/oauth/token'
do
  if ! rg -q -F "${route}" "${caddyfile}"; then
    echo "Caddyfile is missing slopd-mcp route ${route}" >&2
    exit 1
  fi
done

for expected in \
  'reverse_proxy 10.77.77.2:8780' \
  'ExecStart=/usr/bin/slopd-mcp' \
  '--socket %t/slopd/slopd.sock' \
  'EnvironmentFile=%h/.config/slopd-mcp/service.env'
do
  if ! rg -q -F -- "${expected}" "${caddyfile}" "${unit}"; then
    echo "slopd-mcp deployment is missing: ${expected}" >&2
    exit 1
  fi
done

echo "slopd-mcp deployment checks passed"
