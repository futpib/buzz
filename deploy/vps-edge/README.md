# Buzz VPS edge

This Compose project terminates public TLS on the VPS and proxies Buzz over
WireGuard to `10.77.77.2:3000`. Device-pairing WebSockets at `/pair` are routed
to the stateless sidecar on `10.77.77.2:5000`. A dedicated MCP hostname routes
MCP and OAuth to the private host's `slopd-mcp` on `10.77.77.2:8780` without
response compression or proxy buffering.

Prerequisites:

- Docker with Docker Compose
- WireGuard tools
- TCP ports 80 and 443 open
- The existing WireGuard UDP port open
- A stable public IPv4 address
- An MCP hostname resolving to that address

One-time setup:

1. Run `sudo ./setup-wireguard.sh <PRIVATE_HOST_WIREGUARD_PUBLIC_KEY>`.
   It securely generates `/etc/wireguard/wg-buzz.conf`, enables the tunnel, and
   prints the VPS public key needed by the private host. If the VPS already has
   WireGuard, add the private host as a peer there instead.
2. Copy `.env.example` to `.env`, set the real public IP and MCP hostname. A
   hostname you control is preferred. For an immediate test without creating a
   DNS record, use `mcp.<VPS_PUBLIC_IP>.sslip.io`.
3. Run `docker compose up -d`.

Normal operation:

```bash
docker compose up -d
docker compose ps
docker compose logs -f caddy
docker compose down
```

Caddy obtains certificates for the public IP address and MCP hostname from
Let's Encrypt on first startup and renews them automatically. IP certificates
use Let's Encrypt's required `shortlived` profile and last about six days.
Certificate and ACME account state persist in the `caddy-data` Docker volume
across container recreation and normal `docker compose down`/`up` cycles.

The configuration directory is mounted instead of the individual Caddyfile so
Git updates remain visible to the running container.

After pulling a Caddyfile update, ensure Caddy is running, then validate and
reload it:

```bash
docker compose up -d
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

In ChatGPT or Grok, add the connector at
`https://<MCP_PUBLIC_HOST>/mcp`. Use the private host's
`~/.config/slopd-mcp/token` value as the OAuth password. The same value is a
bearer token for MCP clients without OAuth support. The IP-address route remains
available for existing clients, but discovery advertises the hostname.
