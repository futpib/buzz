#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <VPS_PUBLIC_IPV4> <VPS_WIREGUARD_PUBLIC_KEY>" >&2
  exit 2
fi

vps_ip=$1
vps_public_key=$2

IFS=. read -r octet1 octet2 octet3 octet4 extra <<<"${vps_ip}"
if [[ -n ${extra:-} ]]; then
  echo "Invalid IPv4 address: ${vps_ip}" >&2
  exit 2
fi
for octet in "${octet1:-}" "${octet2:-}" "${octet3:-}" "${octet4:-}"; do
  if [[ ! ${octet} =~ ^(0|[1-9][0-9]{0,2})$ ]] || ((10#${octet} > 255)); then
    echo "Invalid canonical IPv4 address: ${vps_ip}" >&2
    exit 2
  fi
done

if [[ $(printf '%s' "${vps_public_key}" | base64 -d 2>/dev/null | wc -c) -ne 32 ]]; then
  echo "Invalid WireGuard public key." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_dir="${script_dir}/../compose"
env_file="${compose_dir}/.env"
wg_template="${script_dir}/wg-buzz.conf"
staged_config="$(mktemp)"
trap 'rm -f "${staged_config}"' EXIT
local_private_key="$(sudo cat /etc/wireguard/buzz-private.key)"

if [[ ! -f ${env_file} ]]; then
  echo "Missing ${env_file}" >&2
  exit 1
fi

sed -i \
  -e "s|^BUZZ_DOMAIN=.*|BUZZ_DOMAIN=${vps_ip}|" \
  -e "s|^RELAY_URL=.*|RELAY_URL=wss://${vps_ip}|" \
  -e "s|^BUZZ_MEDIA_BASE_URL=.*|BUZZ_MEDIA_BASE_URL=https://${vps_ip}/media|" \
  -e "s|^BUZZ_MEDIA_SERVER_DOMAIN=.*|BUZZ_MEDIA_SERVER_DOMAIN=${vps_ip}|" \
  -e "s|^BUZZ_CORS_ORIGINS=.*|BUZZ_CORS_ORIGINS=https://${vps_ip}|" \
  "${env_file}"
chmod 600 "${env_file}"

sed \
  -e "s/CHANGE_ME_LOCAL_WIREGUARD_PRIVATE_KEY/${local_private_key}/" \
  -e "s/CHANGE_ME_VPS_WIREGUARD_PUBLIC_KEY/${vps_public_key}/" \
  -e "s/CHANGE_ME_VPS_PUBLIC_IP/${vps_ip}/" \
  "${wg_template}" >"${staged_config}"

sudo install -Dm600 "${staged_config}" /etc/wireguard/wg-buzz.conf
sudo systemctl enable --now wg-quick@wg-buzz.service

if ! ping -c 3 -W 2 10.77.77.1 >/dev/null; then
  echo "WireGuard started, but the VPS tunnel address did not answer ping." >&2
  echo "Check UDP/51820 and 'sudo wg show wg-buzz' on both hosts." >&2
  exit 1
fi

(
  cd "${compose_dir}"
  docker compose config --quiet
)

echo "Local setup complete."
echo "Start Buzz with: cd ${compose_dir} && docker compose up -d --wait"
