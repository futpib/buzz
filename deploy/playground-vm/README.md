# Buzz playground VM

This deployment runs a separate Buzz instance under `/opt/buzz-playground` on
the host. It uses the package-managed Firecracker binary, a prebuilt Ubuntu
24.04 guest and Firecracker's prebuilt Linux 6.1.186 kernel. The existing host
Buzz instance and VPS configuration are separate.

The guest has 2 vCPUs, 6 GiB RAM and a sparse 16 GiB disk. The host systemd unit
limits total CPU time to 160% (1.6 logical CPUs, approximately 10% of this
16-thread host) and memory to 6656 MiB including VMM overhead. These are caps;
idle CPU and disk usage are lower. The guest kernel is independent of the host.

Only `slopd-codex-sol-medium` is configured, using `gpt-6-sol` with medium
reasoning. Buzz's coordinator, judge and emoji worker use that same account.
The agent has two concurrent ACP sessions; judge and emoji sessions are
additional. PostgreSQL, Redis, MinIO, pairing and the web app live in the guest.

## Local operation

```bash
sudo systemctl status buzz-playground.service
sudo systemctl restart buzz-playground.service
/opt/buzz-playground/host/ssh
/opt/buzz-playground/host/ssh /opt/buzz/bin/buzz-machine channels list
```

The enabled host unit requires its network unit, which recreates the network
namespace, TAP, routes and scoped firewall rules on every host boot. All guest
services and the public activation timer are enabled. The VM disk, database,
media, git data, Codex sessions and slopd lifecycle journals persist. slopd has
automatic backup and restore enabled. No interactive login is required.

Firecracker runs as `buzzvm` with no capabilities, seccomp, private process and
mount namespaces, and a minimal root containing its package-managed executable
and libraries. Its only writable persistent host file is the guest disk. There
are no host home-directory mounts. The guest cannot initiate connections to the
host, LAN, private WireGuard peer or original public Buzz endpoint. Its outbound
exceptions to the VPS are WireGuard UDP 51820 and its own public relay TCP 8443.
This is one shared VM; its participants are not isolated from one another.

The administrative SSH key is under `/opt/buzz-playground/admin`, with a pinned
guest host key. Guest installation and application files are under `/opt/buzz`.
Normal package-managed files and systemd registration links use their standard
locations. System directories do not contain custom host VM images or scripts.

## Deferred VPS setup

Copy `/opt/buzz-playground/vps-setup.tar.gz` to the VPS using your usual SSH
login. All remaining VPS operations are yours; setup on this host does not log
in to or modify the VPS.

On the VPS, extract the archive:

```bash
sudo install -d -m 0755 /opt/buzz-playground
sudo tar -xzf /path/to/vps-setup.tar.gz -C /opt/buzz-playground
sudo chmod 755 /opt/buzz-playground/vps/vps-firewall
```

First fence the new peer from the VPS and other peers. This preserves replies
to connections initiated by Caddy and survives VPS reboots:

```bash
sudo systemctl link /opt/buzz-playground/vps/buzz-playground-vps-firewall.service
sudo systemctl enable --now buzz-playground-vps-firewall.service
```

Add the new peer to the existing WireGuard configuration and running interface.
The original peer at `10.77.77.2` stays configured:

```bash
sudo sh -c 'umask 077; cp /etc/wireguard/wg-buzz.conf /opt/buzz-playground/vps/wg-buzz.before.conf'
if ! sudo grep -Fq 'MrHUR2eO39IASU3xPoJCmfjaJ8jkb2ne83wAQ3RtzCw=' /etc/wireguard/wg-buzz.conf; then
  sudo tee -a /etc/wireguard/wg-buzz.conf >/dev/null <<'PEER'

[Peer]
PublicKey = MrHUR2eO39IASU3xPoJCmfjaJ8jkb2ne83wAQ3RtzCw=
AllowedIPs = 10.77.77.3/32
PEER
fi
sudo wg set wg-buzz peer MrHUR2eO39IASU3xPoJCmfjaJ8jkb2ne83wAQ3RtzCw= allowed-ips 10.77.77.3/32
sudo wg show wg-buzz
curl -fsS http://10.77.77.3:3000 -H 'Accept: application/nostr+json'
```

The last command should show the relay's `self` pubkey
`f8b787243218c45f9c000a520629f617e64c656684c0620931e70ce99e570462`.
Do not restart the existing WireGuard interface just to add this peer.

In your existing VPS edge Compose directory, first check that ports 8443 and
8444 are unused. Then add the new Caddy routes:

```bash
sudo ss -ltn '( sport = :8443 or sport = :8444 )'
sudo cp caddy/Caddyfile /opt/buzz-playground/vps/Caddyfile.before
sudo cp /opt/buzz-playground/vps/Caddyfile.playground caddy/Caddyfile.playground
if ! grep -Fxq 'import Caddyfile.playground' caddy/Caddyfile; then
  printf '\nimport Caddyfile.playground\n' | sudo tee -a caddy/Caddyfile >/dev/null
fi
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile &&
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
```

These commands assume the existing deployment's `./caddy` directory is mounted
at `/etc/caddy` and Caddy uses host networking, as in `deploy/vps-edge`. Keep the
existing Caddy data volume and port-80 ACME access. The new routes use the same
IP certificate mechanism. No domain is required.

Allow TCP 8443 and 8444 in your existing VPS/provider firewall. If you use UFW:

```bash
sudo ufw allow 8443/tcp
sudo ufw allow 8444/tcp
```

The VM checks the new HTTPS endpoint every 30 seconds. Once its TLS certificate
validates and the relay identity matches, it switches the existing community
and clients from the local URL to the public URL and verifies authenticated
access. This preserves the community ID and data. Allow about two minutes.
Before these VPS steps the local instance is usable through administrative SSH;
the public route has not been tested.

- Web chat: `https://178.18.254.153:8444`
- Desktop/mobile relay: `wss://178.18.254.153:8443`
- Pairing sidecar: `wss://178.18.254.153:8443/pair`

Check activation from this host:

```bash
/opt/buzz-playground/host/ssh 'cat /opt/buzz/config/public-active; journalctl -u buzz-public-activation.service -n 20 --no-pager'
```

## Invite someone

Create a separate login for each person from this host:

```bash
/opt/buzz-playground/host/ssh /opt/buzz/bin/manage-user add alice
/opt/buzz-playground/host/ssh cat /opt/buzz/config/users/alice.json
```

Privately give that person the web URL and their `nsec` from the second command.
They enter it in the web login form. The helper admits their relay membership
and enables both direct agent access and coordinator routing. It restarts the
two bot bridges, so invite people between active turns. To use an existing
identity, append `--pubkey HEX_PUBLIC_KEY`; this does not create a new secret.
The helper also adds them to `playground`, so the web app opens into a usable
channel immediately.

```bash
/opt/buzz-playground/host/ssh /opt/buzz/bin/manage-user remove alice
```

Revocation removes relay and bot access and deletes the saved login file. Do
not share the administrator identity, host SSH key or Codex login.

## Maintenance and verification

The installed runtime binaries are copies of the working local Buzz/slopd
artifacts; the guest has its own Git checkout of Buzz. Codex has a private copy
of the existing login, without the host's other Codex context or projects.
Downloaded image origins, hashes and deployed versions are recorded under
`/opt/buzz-playground/manifest`. The kernel is a prebuilt Firecracker CI artifact;
guest `apt` upgrades do not replace it. Replace that artifact deliberately when
updating the guest kernel. Recheck `/usr/bin/firecracker` library dependencies
when upgrading the host package.

MinIO is the existing host image copied with `docker save`/`load`; its release
tag is local and has `pull_policy: never`. The copied image is independent of the
running host container. The guest's containers use the guest network namespace
with database and storage listeners restricted to loopback; they do not depend
on bridge features missing from the minimal guest kernel.

The installation checks cover a real Codex turn, coordinator-routed reply,
browser login, guest reboot with restored sessions and a second reply in the
same thread, host service startup with a fresh network namespace, and denied
guest access to the host/LAN/original relay. Temporary users and channels are
removed after verification. The host itself is not rebooted; its enabled units
and startup dependencies are checked instead. Public TLS/proxy operation remains
pending your VPS changes.
