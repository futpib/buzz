import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getPublicKey, nip19 } from "nostr-tools";
import {
  storeCredential,
  forgetCredential,
  decryptOwnAppDataEvent,
} from "./identity";
import { useWorkspaceNavigation } from "./workspace-navigation";
import { validateNavigationAppDataEvent } from "../server/navigation-validation";

test("the real navigation outbox retains a split snapshot across failure and a concurrent edit", async (t) => {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const pubkey = getPublicKey(secret);
  const credential = { nsec: nip19.nsecEncode(secret), authTag: null };
  const contexts = Object.fromEntries(
    Array.from({ length: 1500 }, (_, i) => [
      `msg:${i.toString(16).padStart(64, "0")}`,
      1_700_000_000 + i,
    ]),
  );
  let saved = JSON.stringify({
    version: 1,
    clientId: "queued",
    readContexts: contexts,
    pendingPublishes: ["read-state:queued"],
  });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: () => saved,
        setItem: (_key: string, value: string) => {
          saved = value;
        },
      },
    },
  });
  t.after(async () => {
    await forgetCredential();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  await storeCredential(credential);
  let controller!: ReturnType<typeof useWorkspaceNavigation>["controller"];
  function Capture() {
    controller = useWorkspaceNavigation(pubkey, []).controller;
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  let release!: (response: Response) => void;
  let started!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const received: Record<string, number> = {};
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      const event = JSON.parse(String(init.body));
      validateNavigationAppDataEvent(pubkey, event);
      calls++;
      if (calls === 2) {
        started();
        return held;
      }
      const value = decryptOwnAppDataEvent(credential, event) as {
        contexts: Record<string, number>;
      };
      Object.assign(received, value.contexts);
      return Response.json({ id: event.id });
    },
  );
  controller.retryPending();
  await secondStarted;
  assert.deepEqual(JSON.parse(saved).pendingPublishes, ["read-state:queued"]);
  const newId = "f".repeat(64);
  controller.markMessageRead(newId, 1_700_100_000);
  release(Response.json({ error: "interrupted chunk" }, { status: 503 }));
  const deadline = Date.now() + 5_000;
  while (controller.snapshot.pendingPublishes.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(controller.snapshot.pendingPublishes, []);
  assert.ok(calls > 4);
  assert.deepEqual(received, { ...contexts, [`msg:${newId}`]: 1_700_100_000 });
  assert.deepEqual(JSON.parse(saved).readContexts, received);
});
