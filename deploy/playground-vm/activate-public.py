#!/usr/bin/env python3
"""Switch the existing community to its public URL once the VPS is ready."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

B = Path('/opt/buzz')
marker = B / 'config/public-active'
progress = B / 'config/public-activating'
if marker.exists():
    raise SystemExit(0)
if not progress.exists():
    try:
        req = urllib.request.Request('https://178.18.254.153:8443', headers={'Accept': 'application/nostr+json'})
        with urllib.request.urlopen(req, timeout=8) as response:
            metadata = json.load(response)
        expected = json.loads((B / 'config/identities.json').read_text())['relay']
        if metadata.get('self') != expected:
            raise ValueError('VPS endpoint is not this playground relay')
    except (OSError, ValueError, urllib.error.URLError):
        # The VPS is intentionally configured later by the operator.
        raise SystemExit(0)
    progress.touch(mode=0o600)


def run(*args):
    subprocess.run(args, check=True)


def update(path, replacements):
    previous = path.stat()
    values = dict((k, json.loads(v)) for k, v in (line.split('=', 1) for line in path.read_text().splitlines()))
    values.update(replacements)
    temporary = path.with_suffix('.new')
    temporary.write_text(''.join(f'{k}={json.dumps(v)}\n' for k, v in values.items()))
    os.chmod(temporary, previous.st_mode & 0o777)
    os.chown(temporary, previous.st_uid, previous.st_gid)
    temporary.replace(path)


run('systemctl', 'stop', 'buzz-agent', 'buzz-coordinator', 'buzz-relay')
run('docker', 'exec', 'buzz-playground-postgres-1', 'psql', '-U', 'buzz', '-d', 'buzz', '-v', 'ON_ERROR_STOP=1', '-c', "UPDATE communities SET host='178.18.254.153:8443' WHERE host='127.0.0.1:3000';")
for path in [B / 'config/relay.env', B / 'home/config/relay.env']:
    update(path, {'RELAY_URL': 'wss://178.18.254.153:8443'})
update(B / 'config/admin.env', {'BUZZ_RELAY_URL': 'https://178.18.254.153:8443'})
update(B / 'home/config/agent.env', {'BUZZ_RELAY_URL': 'https://178.18.254.153:8443', 'BUZZ_RELAY_WS_URL': 'wss://178.18.254.153:8443'})
update(B / 'home/config/coordinator.env', {'BUZZ_RELAY_URL': 'wss://178.18.254.153:8443'})
compose = B / 'compose.yml'
compose.write_text(compose.read_text().replace('BUZZ_RELAY_URL: http://127.0.0.1:3000', 'BUZZ_RELAY_URL: https://178.18.254.153:8443'))
run('systemctl', 'start', 'buzz-relay', 'buzz-agent', 'buzz-coordinator')
run('docker', 'compose', '--env-file', '/opt/buzz/config/relay.env', '-f', str(compose), 'up', '-d', 'chat-web')
for attempt in range(30):
    result = subprocess.run(['/opt/buzz/bin/buzz-machine', 'channels', 'list'], capture_output=True)
    if result.returncode == 0:
        marker.write_text('https://178.18.254.153:8444\n')
        progress.unlink(missing_ok=True)
        print('Public relay authentication verified; playground is active.')
        break
    time.sleep(2)
else:
    raise RuntimeError('Public activation is configured but authentication has not recovered; will retry')
