import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginForm } from "./LoginForm";

test("the pre-hydration login form cannot submit credentials through native navigation", () => {
  const html = renderToStaticMarkup(
    createElement(LoginForm, {
      nextPath: "/activity",
      pairingRelayUrl: "wss://relay.test",
    }),
  );
  const dom = new JSDOM(html);
  const form = dom.window.document.querySelector("form");
  const input = dom.window.document.querySelector<HTMLInputElement>("#nsec");
  const submit = dom.window.document.querySelector<HTMLButtonElement>(
    "button[type=submit]",
  );
  assert.ok(form && input && submit);
  assert.equal(input.disabled, true);
  assert.equal(submit.disabled, true);
  assert.equal(input.hasAttribute("name"), false);
  // Even programmatic enablement must not make the secret a successful form field.
  input.disabled = false;
  input.value = "nsec1dummy-not-a-secret";
  assert.deepEqual([...new dom.window.FormData(form).entries()], []);
  dom.window.close();
});
