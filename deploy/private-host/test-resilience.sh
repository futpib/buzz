#!/usr/bin/env bash
# Real Redis fault/recovery test. Never connects to the production containers.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fixture=$(mktemp -d /tmp/buzz-resilience-test.XXXXXXXX)
container=buzz-resilience-test-${fixture##*.}
image=redis:7-alpine
cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
    case "$fixture" in
        /tmp/buzz-resilience-test.*)
            docker run --rm --network none --user 0 --mount "type=bind,src=$fixture,dst=/fixture" \
                "$image" find /fixture -mindepth 1 -delete
            rmdir "$fixture"
            ;;
    esac
}
trap cleanup EXIT
mkdir "$fixture/data" "$fixture/backups"
export BUZZ_REDIS_CONTAINER=$container BUZZ_REDIS_BACKUP_DIR=$fixture/backups XDG_STATE_HOME=$fixture/state
docker run -d --name "$container" --network none \
    --mount "type=bind,src=$fixture/data,dst=/data" \
    -e REDIS_PASSWORD=test-only "$image" redis-server --appendonly yes --requirepass test-only >/dev/null
redis() { docker exec -e REDISCLI_AUTH=test-only "$container" redis-cli "$@"; }
for _ in {1..50}; do
    if redis ping >/dev/null 2>&1; then break; fi
    sleep 0.1
done
redis SET recovery-proof before-backup
bash "$script_dir/buzz-resilience" backup
snapshot=$(find "$fixture/backups" -name 'snapshot-*.rdb' -print -quit)
[[ -n "$snapshot" ]]
before=$(sha256sum "$snapshot")
if bash "$script_dir/buzz-resilience" restore "$snapshot"; then
    echo 'FAIL: live restore was accepted' >&2; exit 1
fi
redis SET recovery-proof after-backup
docker stop --timeout 10 "$container" >/dev/null
if bash "$script_dir/buzz-resilience" backup; then
    echo 'FAIL: backup of stopped server succeeded' >&2; exit 1
fi
[[ $(sha256sum "$snapshot") == "$before" ]]
printf 'invalid RDB fixture' >"$fixture/invalid.rdb"
if bash "$script_dir/buzz-resilience" restore "$fixture/invalid.rdb"; then
    echo 'FAIL: corrupt snapshot accepted' >&2; exit 1
fi
docker run --rm --network none --user 0 --mount "type=bind,src=$fixture/data,dst=/data" \
    "$image" sh -ec 'find /data/appendonlydir -name "*.incr.aof" -exec sh -c '\''printf "invalid AOF fixture" >> "$1"'\'' sh {} \;'
bash "$script_dir/buzz-resilience" restore "$snapshot"
[[ $(docker inspect --format '{{.State.Status}}' "$container") == exited ]]
docker start "$container" >/dev/null
for _ in {1..50}; do
    if redis ping >/dev/null 2>&1; then break; fi
    sleep 0.1
done
[[ $(redis GET recovery-proof) == before-backup ]]
[[ $(docker run --rm --network none --user 0 --mount "type=bind,src=$fixture,dst=/fixture,readonly" \
    "$image" find /fixture -path '*/original/appendonlydir/*.incr.aof' | wc -l) -gt 0 ]]
echo 'PASS: consistent snapshot, live/corrupt restore refusal, failed-backup preservation, corrupt-AOF recovery and original archive'
