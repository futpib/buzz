import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test("relay transport lifecycle under the server-only export condition", async () => {
  // The real transport is server-only; isolate its condition from React DOM tests.
  await promisify(execFile)(
    process.execPath,
    [
      "--conditions=react-server",
      "--import=tsx",
      "--test",
      "src/server/relay-transport.fixture.ts",
    ],
    { timeout: 20_000 },
  );
});
