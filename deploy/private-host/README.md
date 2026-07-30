# Buzz private-host deployment

Buzz and its stateful dependencies run on this machine using the official
production Compose stack. A public VPS terminates TLS and reaches the relay
over WireGuard.

Network layout:

- VPS WireGuard address: `10.77.77.1/24`
- This host's WireGuard address: `10.77.77.2/24`
- Public relay: `wss://<VPS_PUBLIC_IP>`
- Private relay upstream: `http://10.77.77.2:3000`
- Private readiness endpoint: `http://10.77.77.2:8080/_readiness`

`99-buzz-docker-forwarding.conf` is installed in `/etc/sysctl.d` so Docker can
route traffic arriving over WireGuard into the relay container.

The service cannot start successfully until:

1. `CHANGE_ME_VPS_PUBLIC_IP` is replaced in `deploy/compose/.env`.
2. The WireGuard template is completed and installed at
   `/etc/wireguard/wg-buzz.conf`.
3. `wg-quick@wg-buzz.service` is enabled and connected.

After configuring WireGuard on the VPS, finish all three steps with:

```bash
./deploy/private-host/finish-local-setup.sh \
  <VPS_PUBLIC_IPV4> <VPS_WIREGUARD_PUBLIC_KEY> <VPS_WIREGUARD_PORT>
```

Start and inspect Buzz with:

```bash
cd deploy/compose
docker compose up -d --wait
docker compose ps
docker compose logs -f relay
docker compose down
```

The ignored `deploy/compose/.env` sets
`COMPOSE_FILE=compose.yml:compose.private-host.yml`. This loads the private-host
override automatically without changing the behavior of a clean upstream
checkout, so no extra `-f` arguments or wrapper scripts are needed.

`BUZZ_DATA_DIR` in that file is an absolute, host-managed path for PostgreSQL,
Redis, MinIO, and hosted Git data. This keeps the backend state visible and
easy to include in host backups instead of hiding it under Docker's volume
directory. The production host currently uses `~/buzz-data`.

`compose.env.example` is the committed, secret-free template for that file.
The live `.env`, WireGuard private key, bootstrap owner secret, certificates,
and generated configs are all excluded from Git or stored outside the
repository.

The bootstrap owner keypair is stored outside the repository at
`~/.config/buzz/owner-keypair.txt` with mode `0600`. Back it up securely. Its
secret key is the initial owner identity and must never be committed or pasted
into logs.

## Always-on slopd agents

The three Buzz ACP bridges are installed from the tracked launcher and systemd
units in this directory. Their shared host-specific settings live outside Git
at `~/.config/buzz-slopd-agent/bridge.env`; agent identities remain in their
respective `~/.config/buzz-slopd*-agent/` directories.

On first use, generate the ignored config template:

```bash
./deploy/private-host/install-slopd-agents.sh
```

Replace its `CHANGE_ME` values, then install or refresh the launcher and units:

```bash
./deploy/private-host/install-slopd-agents.sh --restart
```

The bridges intentionally use the normal Buzz base prompt and NIP-AE memory.
Do not add `--no-base-prompt` or `--no-memory`; those switches are for isolated
diagnostics, not the permanent agents.
