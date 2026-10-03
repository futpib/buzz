#!/usr/bin/env python3
"""Add four pinned accounts while preserving the existing slopd configuration."""

import json
import os
from pathlib import Path
import sys
import tempfile
import tomllib

BEGIN = "# BEGIN BUZZ CODEX PRESETS"
END = "# END BUZZ CODEX PRESETS"


def configure(path):
    original = path.read_text()
    text = original
    if BEGIN in text:
        before, managed = text.split(BEGIN, 1)
        _, after = managed.split(END, 1)
        text = before.rstrip() + after
    config = tomllib.loads(text)
    source = config["accounts"]["codex"]
    executable = source["executable"]
    args = [executable] if isinstance(executable, str) else executable[:]
    # Retain authentication, sandbox, hooks and host-specific CLI options.
    pinned = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ("--model", "-m"):
            index += 2
            continue
        if arg.startswith("--model="):
            index += 1
            continue
        if arg in ("-c", "--config") and index + 1 < len(args):
            if args[index + 1].split("=", 1)[0].strip() == "model_reasoning_effort":
                index += 2
                continue
        pinned.append(arg)
        index += 1
    lines = [BEGIN]
    for model in ("sol", "astra"):
        for effort in ("medium", "xhigh"):
            name = f"codex-{model}-{effort}"
            if name in config["accounts"]:
                raise ValueError(f"Refusing to overwrite unmanaged account {name}")
            account = dict(source)
            account["backend"] = "codex"
            account["executable"] = pinned + [
                "--model", f"gpt-6-{model}", "-c", f'model_reasoning_effort="{effort}"'
            ]
            lines.append(f"\n[accounts.{name}]")
            for key, value in account.items():
                # These account fields are strings, booleans or argv arrays.
                lines.append(f"{json.dumps(key)} = {json.dumps(value)}")
    lines.append(END)
    updated = text.rstrip() + "\n\n" + "\n".join(lines) + "\n"
    tomllib.loads(updated)
    if original == updated:
        return
    backup = path.with_name(path.name + ".before-codex-presets")
    if not backup.exists():
        with open(backup, "x", opener=lambda p, f: os.open(p, f, 0o600)) as stream:
            stream.write(original)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(updated)
    try:
        os.chmod(temporary, path.stat().st_mode & 0o777)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    configure(Path(sys.argv[1]))
