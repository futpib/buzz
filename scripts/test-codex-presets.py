#!/usr/bin/env python3
"""Exercise the production slopd preset configuration writer."""

import importlib.util
from pathlib import Path
import tempfile
import tomllib
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/private-host/configure-codex-presets.py"
spec = importlib.util.spec_from_file_location("presets", SCRIPT)
presets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(presets)

SOURCE = '''default_account = "codex"
[accounts.codex]
backend = "codex"
config_dir = "~/private-codex"
executable = ["/opt/codex", "--model", "old", "-c", 'model_reasoning_effort="high"', "--disable", "apps"]
[accounts.claude]
backend = "claude"
executable = "/opt/claude"
[backup]
auto_backup = false
'''


class PresetsTest(unittest.TestCase):
    def test_pins_and_repeat_install_preserve_existing_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_text(SOURCE)
            presets.configure(path)
            first = path.read_text()
            parsed = tomllib.loads(first)
            original = tomllib.loads(SOURCE)
            for key, value in original.items():
                if key != "accounts":
                    self.assertEqual(parsed[key], value)
            for key, value in original["accounts"].items():
                self.assertEqual(parsed["accounts"][key], value)
            self.assertEqual(len(parsed["accounts"]), 6)
            for model in ("sol", "astra"):
                for effort in ("medium", "xhigh"):
                    account = parsed["accounts"][f"codex-{model}-{effort}"]
                    self.assertEqual(account["config_dir"], "~/private-codex")
                    self.assertEqual(account["executable"], [
                        "/opt/codex", "--disable", "apps", "--model", f"gpt-6-{model}",
                        "-c", f'model_reasoning_effort="{effort}"',
                    ])
            presets.configure(path)
            self.assertEqual(path.read_text(), first)
            self.assertEqual(path.with_suffix(".toml.before-codex-presets").read_text(), SOURCE)

    def test_unmanaged_name_collision_leaves_file_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            original = SOURCE + '\n[accounts.codex-sol-medium]\nbackend = "codex"\n'
            path.write_text(original)
            with self.assertRaisesRegex(ValueError, "unmanaged account"):
                presets.configure(path)
            self.assertEqual(path.read_text(), original)


if __name__ == "__main__":
    unittest.main()
