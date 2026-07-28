# Buzz VPS edge

This Compose project terminates public IP-address TLS on the VPS and proxies
Buzz over WireGuard to `10.77.77.2:3000`.

Prerequisites:

- Docker with Docker Compose
- WireGuard tools
- TCP ports 80 and 443 open
- UDP port 51820 open
- A stable public IPv4 address

One-time setup:

1. Run `sudo ./setup-wireguard.sh <PRIVATE_HOST_WIREGUARD_PUBLIC_KEY>`.
   It securely generates `/etc/wireguard/wg-buzz.conf`, enables the tunnel, and
   prints the VPS public key needed by the private host.
2. Copy `.env.example` to `.env` and set the real public IP.
3. Run `./bootstrap-certificate.sh` while TCP port 80 is free.
4. Run `docker compose up -d`.

Normal operation:

```bash
docker compose up -d
docker compose ps
docker compose logs -f caddy
docker compose down
```

The Certbot service checks twice daily for renewal. IP certificates use Let's
Encrypt's required `shortlived` profile and last about six days. After a
renewal, Certbot signals Caddy to reload the certificate without dropping
connections.
