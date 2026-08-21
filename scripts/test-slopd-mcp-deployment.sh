#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
caddyfile="${repo_root}/deploy/vps-edge/caddy/Caddyfile"
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
  '{$MCP_PUBLIC_HOST}' \
  'flush_interval -1' \
  'reverse_proxy 10.77.77.2:8780' \
  'MCP_PUBLIC_HOST: ${MCP_PUBLIC_HOST:?set MCP_PUBLIC_HOST in .env}' \
  'SLOPD_MCP_PUBLIC_URL=https://CHANGE_ME_MCP_PUBLIC_HOST' \
  'ExecStart=/usr/bin/slopd-mcp' \
  '--socket %t/slopd/slopd.sock' \
  'EnvironmentFile=%h/.config/slopd-mcp/service.env'
do
  if ! rg -q -F -- "${expected}" \
    "${caddyfile}" \
    "${repo_root}/deploy/vps-edge/compose.yml" \
    "${repo_root}/deploy/private-host/slopd-mcp.env.example" \
    "${unit}"
  then
    echo "slopd-mcp deployment is missing: ${expected}" >&2
    exit 1
  fi
done

echo "slopd-mcp deployment checks passed"
