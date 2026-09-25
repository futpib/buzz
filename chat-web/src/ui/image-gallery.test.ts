import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { collectImageGallery } from "./image-gallery";

function markLoaded(image: HTMLImageElement, width: number, height: number) {
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalHeight: { configurable: true, value: height },
    naturalWidth: { configurable: true, value: width },
  });
}

function imageFor(trigger: HTMLButtonElement) {
  const image = trigger.querySelector("img");
  assert.ok(image);
  return image;
}

test("collects loaded message images in gallery order and selects the clicked one", () => {
  const dom = new JSDOM(`<!doctype html><div data-image-gallery>
    <button class="message-media-trigger"><img src="/one.png" alt="One"></button>
    <button class="message-media-trigger"><img src="/two.png" alt="Two" title="Second"></button>
    <button class="message-media-trigger"><img src="/three.png" alt="Three"></button>
  </div>`);
  const previousImage = globalThis.HTMLImageElement;
  Object.defineProperty(globalThis, "HTMLImageElement", {
    configurable: true,
    value: dom.window.HTMLImageElement,
  });
  try {
    const triggers = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    );
    markLoaded(imageFor(triggers[0]), 100, 80);
    markLoaded(imageFor(triggers[1]), 200, 160);
    markLoaded(imageFor(triggers[2]), 300, 240);

    const gallery = collectImageGallery(triggers[1]);

    assert.equal(gallery.index, 1);
    assert.deepEqual(
      gallery.items.map(({ alt, height, title, width }) => ({
        alt,
        height,
        title,
        width,
      })),
      [
        { alt: "One", height: 80, title: undefined, width: 100 },
        { alt: "Two", height: 160, title: "Second", width: 200 },
        { alt: "Three", height: 240, title: undefined, width: 300 },
      ],
    );
  } finally {
    if (previousImage) {
      Object.defineProperty(globalThis, "HTMLImageElement", {
        configurable: true,
        value: previousImage,
      });
    } else {
      Reflect.deleteProperty(globalThis, "HTMLImageElement");
    }
    dom.window.close();
  }
});

test("does not make an unloaded sibling block opening the selected image", () => {
  const dom = new JSDOM(`<!doctype html><div data-image-gallery>
    <button class="message-media-trigger"><img src="/one.png" alt="One"></button>
    <button class="message-media-trigger"><img src="/two.png" alt="Two"></button>
  </div>`);
  const previousImage = globalThis.HTMLImageElement;
  Object.defineProperty(globalThis, "HTMLImageElement", {
    configurable: true,
    value: dom.window.HTMLImageElement,
  });
  try {
    const triggers = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    );
    markLoaded(imageFor(triggers[1]), 200, 160);

    const gallery = collectImageGallery(triggers[1]);

    assert.equal(gallery.index, 0);
    assert.equal(gallery.items.length, 1);
    assert.equal(gallery.items[0].alt, "Two");
  } finally {
    if (previousImage) {
      Object.defineProperty(globalThis, "HTMLImageElement", {
        configurable: true,
        value: previousImage,
      });
    } else {
      Reflect.deleteProperty(globalThis, "HTMLImageElement");
    }
    dom.window.close();
  }
});
