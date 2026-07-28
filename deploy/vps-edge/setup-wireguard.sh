#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <PRIVATE_HOST_WIREGUARD_PUBLIC_KEY>" >&2
  exit 2
fi

private_host_public_key=$1
if [[ $(printf '%s' "${private_host_public_key}" | base64 -d 2>/dev/null | wc -c) -ne 32 ]]; then
  echo "Invalid private-host WireGuard public key." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="${script_dir}/wg-buzz.conf.example"
staged_config="$(mktemp)"
trap 'rm -f "${staged_config}"' EXIT

sudo install -d -m700 /etc/wireguard
if ! sudo test -s /etc/wireguard/buzz-private.key; then
  umask 077
  wg genkey | sudo install -m600 /dev/stdin /etc/wireguard/buzz-private.key
fi
sudo sh -c \
  'wg pubkey < /etc/wireguard/buzz-private.key > /etc/wireguard/buzz-public.key && chmod 644 /etc/wireguard/buzz-public.key'

vps_private_key="$(sudo cat /etc/wireguard/buzz-private.key)"
while IFS= read -r line; do
  case "${line}" in
    "PrivateKey = CHANGE_ME_VPS_WIREGUARD_PRIVATE_KEY")
      printf 'PrivateKey = %s\n' "${vps_private_key}"
      ;;
    "PublicKey = CHANGE_ME_PRIVATE_HOST_WIREGUARD_PUBLIC_KEY")
      printf 'PublicKey = %s\n' "${private_host_public_key}"
      ;;
    *)
      printf '%s\n' "${line}"
      ;;
  esac
done <"${template}" >"${staged_config}"

sudo install -Dm600 "${staged_config}" /etc/wireguard/wg-buzz.conf
sudo systemctl enable --now wg-quick@wg-buzz.service

printf 'VPS WireGuard public key: '
sudo cat /etc/wireguard/buzz-public.key
