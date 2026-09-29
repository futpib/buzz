#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -Dm755 "$script_dir/buzz-resilience" "$HOME/.local/libexec/buzz-resilience"
for unit in buzz-health.service buzz-health.timer buzz-redis-backup.service buzz-redis-backup.timer buzz-resilience-alert.service; do
    install -Dm644 "$script_dir/systemd/$unit" "$HOME/.config/systemd/user/$unit"
done
for agent in buzz-slopd-agent buzz-slopd-claude-agent buzz-slopd-grok-agent buzz-slopd-opencode-agent buzz-zai-agent; do
    if [[ -f "$HOME/.config/systemd/user/$agent.service" ]]; then
        install -Dm644 "$script_dir/systemd/buzz-agent-shutdown.conf" "$HOME/.config/systemd/user/$agent.service.d/resilience.conf"
    fi
done
systemctl --user daemon-reload
systemctl --user enable --now buzz-health.timer buzz-redis-backup.timer
systemctl --user start buzz-health.service buzz-redis-backup.service
