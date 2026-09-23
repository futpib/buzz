import assert from "node:assert/strict";
import test from "node:test";
import type { EmojiMartData } from "@emoji-mart/data";

import {
  buildReactionEmojiIndex,
  defaultReactionEmojis,
  searchReactionEmojis,
  singleEmojiInput,
} from "./reaction-emojis";

const data = {
  categories: [
    {
      id: "people",
      emojis: ["grinning", "joy", "point_up", "test_tube"],
    },
  ],
  emojis: {
    grinning: {
      id: "grinning",
      name: "Grinning Face",
      keywords: ["smile", "happy"],
      skins: [{ native: "😀", unified: "1f600" }],
      version: 1,
    },
    joy: {
      id: "joy",
      name: "Face with Tears of Joy",
      keywords: ["happy", "laugh"],
      skins: [{ native: "😂", unified: "1f602" }],
      version: 1,
    },
    point_up: {
      id: "point_up",
      name: "Index Pointing Up",
      keywords: ["hand", "finger"],
      skins: [{ native: "☝️", unified: "261d-fe0f" }],
      version: 1,
    },
    test_tube: {
      id: "test_tube",
      name: "Test Tube",
      keywords: ["chemistry", "experiment", "science"],
      skins: [{ native: "🧪", unified: "1f9ea" }],
      version: 11,
    },
  },
} as unknown as EmojiMartData;

test("reaction emoji index follows dataset category order", () => {
  assert.deepEqual(
    buildReactionEmojiIndex(data).map(({ id, native }) => ({ id, native })),
    [
      { id: "grinning", native: "😀" },
      { id: "joy", native: "😂" },
      { id: "point_up", native: "☝️" },
      { id: "test_tube", native: "🧪" },
    ],
  );
});

test("emoji search ranks glyph, shortcode, name, and keyword matches", () => {
  const index = buildReactionEmojiIndex(data);
  assert.equal(searchReactionEmojis(index, "🧪")[0]?.id, "test_tube");
  assert.equal(searchReactionEmojis(index, ":pointup:")[0]?.id, "point_up");
  assert.equal(searchReactionEmojis(index, "tears")[0]?.id, "joy");
  assert.equal(searchReactionEmojis(index, "chemistry")[0]?.id, "test_tube");
  assert.deepEqual(searchReactionEmojis(index, "missing"), []);
});

test("default reaction choices retain their fallback glyphs", () => {
  const defaults = defaultReactionEmojis(buildReactionEmojiIndex(data));
  assert.equal(defaults.length, 20);
  assert.equal(
    defaults.find(({ native }) => native === "😀")?.name,
    "Grinning Face",
  );
  assert.equal(defaults.find(({ native }) => native === "🚀")?.name, "🚀");
});

test("direct input accepts one emoji grapheme and rejects text or multiples", () => {
  assert.equal(singleEmojiInput(" 🧪 "), "🧪");
  assert.equal(singleEmojiInput("❤️‍🔥"), "❤️‍🔥");
  assert.equal(singleEmojiInput("🇬🇪"), "🇬🇪");
  assert.equal(singleEmojiInput("1️⃣"), "1️⃣");
  assert.equal(singleEmojiInput("hello"), null);
  assert.equal(singleEmojiInput("🧪🚀"), null);
});
