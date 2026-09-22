import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const darkRootMatch = css.match(
  /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n\s*\}/,
);
if (!darkRootMatch?.[1]) throw new Error("dark theme variables are missing");
const darkRoot = darkRootMatch[1];

function token(name: string): string {
  const value = darkRoot.match(
    new RegExp(`--${name}:\\s*(#[0-9a-f]{3,8})`, "i"),
  )?.[1];
  assert.ok(value, `dark theme token --${name} is missing`);
  return value;
}

function rgb(value: string): [number, number, number] {
  const full =
    value.length === 4
      ? [...value.slice(1)].map((digit) => `${digit}${digit}`).join("")
      : value.slice(1, 7);
  return [0, 2, 4].map((offset) =>
    Number.parseInt(full.slice(offset, offset + 2), 16),
  ) as [number, number, number];
}

function luminance(value: string): number {
  const [red, green, blue] = rgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const bright = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (bright + 0.05) / (dark + 0.05);
}

test("dark theme uses a true OLED-black canvas", () => {
  assert.equal(token("bg"), "#000");
});

test("dark message code remains AAA-readable", () => {
  const ink = token("code-ink");
  assert.ok(contrast(ink, token("code-bg")) >= 7);
  assert.ok(contrast(ink, token("code-inline")) >= 7);
  assert.match(
    css,
    /\.message-body pre \{[\s\S]*?color: var\(--code-ink\);[\s\S]*?\}/,
  );
  assert.match(
    css,
    /\.message-body code:not\(pre code\) \{[\s\S]*?color: var\(--code-ink\);[\s\S]*?\}/,
  );
});

test("dark message copy remains AAA-readable on the canvas", () => {
  assert.ok(contrast(token("message-ink"), token("bg")) >= 7);
});
