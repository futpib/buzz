#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${script_dir}"

if [[ ! -f .env ]]; then
  echo "Copy .env.example to .env and set VPS_PUBLIC_IP first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z ${VPS_PUBLIC_IP:-} || ${VPS_PUBLIC_IP} == 203.0.113.10 ]]; then
  echo "Set the real VPS_PUBLIC_IP in .env first." >&2
  exit 1
fi

docker volume create buzz-edge-letsencrypt >/dev/null
docker volume create buzz-edge-certbot-www >/dev/null

cleanup() {
  docker rm -f buzz-edge-caddy-bootstrap >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run --detach --rm \
  --name buzz-edge-caddy-bootstrap \
  --network host \
  --volume buzz-edge-certbot-www:/var/www/certbot:ro \
  caddy:2.11-alpine \
  file-server --root /var/www/certbot --listen :80 >/dev/null

docker run --rm \
  --network host \
  --volume buzz-edge-letsencrypt:/etc/letsencrypt \
  --volume buzz-edge-certbot-www:/var/www/certbot \
  certbot/certbot:v5.7.0 \
  certonly \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path /var/www/certbot \
  --ip-address "${VPS_PUBLIC_IP}"

docker compose config --quiet
echo "Certificate issued. Start the edge with: docker compose up -d"
