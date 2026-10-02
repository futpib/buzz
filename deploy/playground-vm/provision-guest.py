#!/usr/bin/env python3
"""Configure the staged Ubuntu guest. Run as root inside the VM."""
import json
import os
import pwd
from pathlib import Path
import secrets
import shutil
import subprocess

B = Path('/opt/buzz')
H = B / 'home'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def write(path, text, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def identity(name):
    path = B / 'config' / (name + '.pem')
    if not path.exists():
        run('openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:secp256k1', '-out', str(path), stderr=subprocess.DEVNULL)
        path.chmod(0o600)
    raw = run('openssl', 'pkey', '-in', str(path), '-text', '-noout', capture_output=True).stdout
    secret = ''.join(raw.split('priv:')[1].split('pub:')[0].split()).replace(':', '')
    public = run(str(B / 'bin/buzz-coordinator-bot'), 'public-key', env={**os.environ, 'BUZZ_BOT_PRIVATE_KEY': secret}, capture_output=True).stdout.strip()
    return secret, public


def envfile(path, values):
    # These files are read by both bash and systemd; JSON strings quote the
    # generated single-line values without interpreting their punctuation.
    write(path, ''.join(f'{k}={json.dumps(v)}\n' for k, v in values.items()), 0o600)


try:
    pwd.getpwnam('buzz')
except KeyError:
    run('useradd', '--uid', '1100', '--home-dir', str(H), '--no-create-home', '--shell', '/bin/bash', 'buzz')
for folder in ['config', 'home/config', 'home/run', 'home/.codex', 'data/git', 'units']:
    (B / folder).mkdir(parents=True, exist_ok=True)
if not (H / 'code').exists():
    (H / 'code').symlink_to(B / 'code')

if not (B / 'config/admin.env').exists():
    owner, owner_pub = identity('owner')
    agent, agent_pub = identity('agent')
    bot, bot_pub = identity('coordinator')
    relay, relay_pub = identity('relay')
    tags = {}
    for name, pub in [('agent', agent_pub), ('coordinator', bot_pub)]:
        tags[name] = run(str(B / 'bin/buzz-compute-auth-tag'), '-', pub, '', input=owner+'\n', capture_output=True).stdout.strip()
    password, redis_password = secrets.token_hex(24), secrets.token_hex(24)
    relay_env = {
        'POSTGRES_PASSWORD': password, 'REDIS_PASSWORD': redis_password,
        'DATABASE_URL': f'postgres://buzz:{password}@127.0.0.1:5432/buzz',
        'REDIS_URL': f'redis://:{redis_password}@127.0.0.1:6379',
        'BUZZ_BIND_ADDR': '0.0.0.0:3000', 'BUZZ_HEALTH_PORT': '8080',
        'BUZZ_DOMAIN': '178.18.254.153:8443', 'RELAY_URL': 'ws://127.0.0.1:3000',
        'BUZZ_MEDIA_BASE_URL': 'https://178.18.254.153:8443/media',
        'BUZZ_MEDIA_SERVER_DOMAIN': '178.18.254.153:8443',
        'BUZZ_CORS_ORIGINS': 'https://178.18.254.153:8444',
        'BUZZ_PAIRING_RELAY_URL': 'wss://178.18.254.153:8443/pair',
        'BUZZ_REQUIRE_AUTH_TOKEN': 'true', 'BUZZ_REQUIRE_RELAY_MEMBERSHIP': 'true',
        'BUZZ_REQUIRE_MEDIA_GET_AUTH': 'true', 'BUZZ_ALLOW_NIP_OA_AUTH': 'true',
        'BUZZ_AUTO_MIGRATE': 'true', 'BUZZ_GIT_CONFORMANCE_PROBE': 'true',
        'RELAY_OWNER_PUBKEY': owner_pub, 'BUZZ_RELAY_PRIVATE_KEY': relay,
        'BUZZ_GIT_HOOK_HMAC_SECRET': secrets.token_hex(32),
        'BUZZ_GIT_REPO_PATH': '/opt/buzz/data/git',
        'BUZZ_S3_ENDPOINT': 'http://127.0.0.1:9000', 'BUZZ_S3_ADDRESSING_STYLE': 'path',
        'BUZZ_S3_ACCESS_KEY': secrets.token_hex(12), 'BUZZ_S3_SECRET_KEY': secrets.token_hex(24),
        'BUZZ_S3_BUCKET': 'buzz-media', 'BUZZ_PUSH_GATEWAY_DELIVERY_URL': '',
        'RUST_LOG': 'info',
    }
    envfile(B / 'config/relay.env', relay_env)
    envfile(H / 'config/relay.env', relay_env)
    envfile(B / 'config/admin.env', {'BUZZ_RELAY_URL': 'http://127.0.0.1:3000', 'BUZZ_PRIVATE_KEY': owner})
    write(B / 'config/identities.json', json.dumps({'owner': owner_pub, 'agent': agent_pub, 'coordinator': bot_pub, 'relay': relay_pub}, indent=2)+'\n')
    shutil.copyfile(B / 'config/agent.pem', H / 'config/agent.pem')
    envfile(H / 'config/agent.env', {
        'BUZZ_RELAY_WS_URL': 'ws://127.0.0.1:3000', 'BUZZ_RELAY_URL': 'http://127.0.0.1:3000',
        'BUZZ_AGENT_OWNER': owner_pub, 'BUZZ_AUTH_TAG': tags['agent'],
        'BUZZ_COORDINATOR_BOT_PUBKEY': bot_pub,
        'BUZZ_AGENT_RESPOND_TO_ALLOWLIST': owner_pub,
        'BUZZ_SLOPD_AGENT_IDENTITY_FORMAT': 'pem',
        'BUZZ_SLOPD_AGENT_IDENTITY_FILE': '/opt/buzz/home/config/agent.pem',
        'BUZZ_ACP_BIN': '/opt/buzz/bin/buzz-acp', 'BUZZ_CLI_BIN': '/opt/buzz/bin/buzz',
        'SLOPD_ACP_BIN': '/opt/buzz/bin/slopd-acp',
        'SLOPD_SOCKET': '/opt/buzz/home/run/slopd.sock',
        'BUZZ_AGENT_ACCOUNT': 'slopd-codex-sol-medium', 'BUZZ_AGENT_BACKEND': 'codex',
        'BUZZ_AGENT_SESSION_TITLE': 'slopd-codex-sol-medium', 'BUZZ_ACP_SESSION_POLICY': 'thread',
        'BUZZ_ACP_SESSION_CONCURRENCY': '2',
    })
    envfile(H / 'config/coordinator.env', {
        'BUZZ_RELAY_URL': 'ws://127.0.0.1:3000', 'BUZZ_BOT_PRIVATE_KEY': bot,
        'BUZZ_AUTH_TAG': tags['coordinator'], 'BUZZ_OWNER_PUBKEYS': owner_pub,
        'BUZZ_DEFAULT_AGENT_PUBKEY': agent_pub, 'BUZZ_JUDGE_ENABLED': 'true',
        'BUZZ_JUDGE_AGENT_COMMAND': '/opt/buzz/bin/slopd-acp',
        'BUZZ_JUDGE_AGENT_ARGS': '--socket,/opt/buzz/home/run/slopd.sock,--account,slopd-codex-sol-medium,--backend,codex',
        'BUZZ_JUDGE_CWD': '/opt/buzz/home', 'BUZZ_JUDGE_IDLE_TIMEOUT': '120',
        'BUZZ_JUDGE_MAX_DURATION': '600', 'BUZZ_EMOJI_REACTOR_ENABLED': 'true',
    })

write(H / '.codex/config.toml', 'model = "gpt-6-sol"\nmodel_reasoning_effort = "medium"\ncheck_for_update_on_startup = false\n[projects."/opt/buzz/home"]\ntrust_level = "trusted"\n[projects."/opt/buzz/code/buzz"]\ntrust_level = "trusted"\n')
if not (B / 'config/wg-playground.conf').exists():
    key = run('wg', 'genkey', capture_output=True).stdout.strip()
    pub = run('wg', 'pubkey', input=key, capture_output=True).stdout.strip()
    write(B / 'config/wg-public-key', pub+'\n')
    write(B / 'config/wg-playground.conf', f'[Interface]\nAddress = 10.77.77.3/32\nPrivateKey = {key}\n\n[Peer]\nPublicKey = XZmrcyHAiKxB31mgLythsOmd7UShD+4Yy6fIZ6pDRms=\nEndpoint = 178.18.254.153:51820\nAllowedIPs = 10.77.77.1/32\nPersistentKeepalive = 25\n', 0o600)

units = {
    'buzz-dependencies': '[Unit]\nDescription=Buzz database, media and web containers\nRequires=docker.service\nAfter=docker.service network-online.target\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/opt/buzz/bin/guest-service dependencies\nTimeoutStartSec=600\n[Install]\nWantedBy=multi-user.target\n',
    'buzz-firewall': '[Unit]\nDescription=Buzz guest ingress firewall\nBefore=network-pre.target\nWants=network-pre.target\nDefaultDependencies=no\nAfter=local-fs.target\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/opt/buzz/bin/guest-firewall\n[Install]\nWantedBy=multi-user.target\n',
    'buzz-wireguard': '[Unit]\nDescription=Buzz playground VPS tunnel\nAfter=network-online.target buzz-firewall.service\nWants=network-online.target\nRequires=buzz-firewall.service\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/wg-quick up /opt/buzz/config/wg-playground.conf\nExecStop=/usr/bin/wg-quick down /opt/buzz/config/wg-playground.conf\n[Install]\nWantedBy=multi-user.target\n',
}
for name in ['relay', 'slopd', 'agent', 'coordinator', 'pairing']:
    dependencies = 'buzz-dependencies.service' if name == 'relay' else 'buzz-relay.service buzz-slopd.service' if name in ['agent', 'coordinator'] else 'network.target'
    command = '/opt/buzz/bin/buzz-pair-relay' if name == 'pairing' else f'/opt/buzz/bin/guest-service {name}'
    units['buzz-'+name] = f'''[Unit]
Description=Buzz playground {name}
After={dependencies}
Wants={dependencies}
StartLimitIntervalSec=0
[Service]
User=buzz
Group=buzz
WorkingDirectory=/opt/buzz/home
Environment=HOME=/opt/buzz/home
Environment=XDG_RUNTIME_DIR=/opt/buzz/home/run
Environment=PATH=/opt/buzz/bin:/usr/local/bin:/usr/bin:/bin
Environment=CODEX_HOME=/opt/buzz/home/.codex
Environment=BUZZ_PAIR_RELAY_BIND_ADDR=0.0.0.0:5000
ExecStart={command}
Restart=always
RestartSec=3
TimeoutStopSec=75
KillMode={'process' if name == 'slopd' else 'mixed'}
UMask=0077
[Install]
WantedBy=multi-user.target
'''
for name, content in units.items():
    write(B / 'units' / (name+'.service'), content)
    run('systemctl', 'link', str(B / 'units' / (name+'.service')))
    run('systemctl', 'enable', name+'.service')
run('chown', '-R', 'buzz:buzz', str(H), str(B / 'data/git'), str(B / 'code'))
run('chmod', '700', str(H / 'config'), str(H / '.codex'), str(B / 'config'))
run('systemctl', 'daemon-reload')
run('systemctl', 'enable', 'docker.service')
print('Guest configured; identities and service credentials are stored under /opt/buzz.')
