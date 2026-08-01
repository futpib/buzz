#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_dir="${repo_root}/deploy/compose"

BUZZ_DATA_DIR=/tmp/buzz-compose-source-dev-test \
  docker compose \
    --env-file "${compose_dir}/.env.example" \
    -f "${compose_dir}/compose.yml" \
    -f "${compose_dir}/compose.private-host.yml" \
    -f "${compose_dir}/compose.source.dev.yml" \
    config --format json |
  python3 -c '
import json
import os
import sys

config = json.load(sys.stdin)
services = config["services"]

builder = services["buzz-dev-build"]
assert builder["network_mode"] == "host"
assert builder["restart"] == "no"
assert builder["build"]["target"] == "dev-toolchain"
assert builder["build"]["network"] == "host"
assert builder["command"][0:3] == ["cargo", "build", "--locked"]
assert "buzz-acp" in builder["command"]

for service_name, binary_name in (
    ("relay", "buzz-relay"),
    ("pairing-relay", "buzz-pair-relay"),
):
    service = services[service_name]
    assert service["entrypoint"] == [
        f"/workspace/target/debug/{binary_name}"
    ]
    assert (
        service["depends_on"]["buzz-dev-build"]["condition"]
        == "service_completed_successfully"
    )
    mounts = {mount["target"]: mount for mount in service["volumes"]}
    assert mounts["/workspace"]["read_only"] is True
    assert os.path.realpath(mounts["/workspace"]["source"]) == os.path.realpath(
        sys.argv[1]
    )
    assert mounts["/workspace/target"]["type"] == "volume"

assert "buzz-dev-target" in config["volumes"]
' "${repo_root}"

echo "compose source-dev contract: ok"
