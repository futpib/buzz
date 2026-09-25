export type ImageGalleryItem = {
  alt: string;
  height?: number;
  src: string;
  title?: string;
  width?: number;
};

export type ImageGallerySelection = {
  index: number;
  items: ImageGalleryItem[];
};

function itemForTrigger(trigger: HTMLButtonElement): ImageGalleryItem | null {
  const image = trigger.querySelector("img");
  if (!(image instanceof HTMLImageElement)) return null;
  const src = image.currentSrc || image.src;
  if (!src) return null;
  return {
    alt: image.alt,
    height: image.naturalHeight || undefined,
    src,
    title: image.title || undefined,
    width: image.naturalWidth || undefined,
  };
}

export function collectImageGallery(
  selectedTrigger: HTMLButtonElement,
): ImageGallerySelection {
  const boundary = selectedTrigger.closest("[data-image-gallery]");
  const triggers = boundary
    ? Array.from(
        boundary.querySelectorAll<HTMLButtonElement>(
          "button.message-media-trigger",
        ),
      )
    : [selectedTrigger];
  const selectedItem = itemForTrigger(selectedTrigger);
  const items: ImageGalleryItem[] = [];
  let index = -1;

  for (const trigger of triggers) {
    const item = itemForTrigger(trigger);
    if (!item) continue;
    if (
      trigger !== selectedTrigger &&
      (item.width === undefined || item.height === undefined)
    ) {
      continue;
    }
    if (trigger === selectedTrigger) index = items.length;
    items.push(item);
  }

  if (index >= 0) return { index, items };
  return selectedItem
    ? { index: 0, items: [selectedItem] }
    : { index: 0, items: [] };
}
