"use client";

import { LoaderCircle, X } from "lucide-react";
import PhotoSwipe from "photoswipe";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ImageGalleryItem } from "@/ui/image-gallery";

const MIN_ZOOM_PERCENT = 100;
const MAX_ZOOM_MULTIPLIER = 8;
const ZOOM_STEP_MULTIPLIER = 0.5;
const CONTROL_ANIMATION_MS = 180;

const ICONS = {
  close:
    '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  minus:
    '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  plus: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  reset:
    '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
} as const;

type ImageSize = {
  width: number;
  height: number;
};

type ResolvedImage = ImageGalleryItem & ImageSize & { sourceIndex: number };

function resolveImage(item: ImageGalleryItem, sourceIndex: number) {
  if (item.width && item.height) {
    return Promise.resolve<ResolvedImage>({
      ...item,
      height: item.height,
      sourceIndex,
      width: item.width,
    });
  }
  return new Promise<ResolvedImage>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({
          ...item,
          height: image.naturalHeight,
          sourceIndex,
          width: image.naturalWidth,
        });
      } else {
        reject(new Error("Image has no dimensions"));
      }
    };
    image.onerror = () => reject(new Error("Image failed to load"));
    image.src = item.src;
  });
}

function zoomRatio(viewer: PhotoSwipe): number {
  const slide = viewer.currSlide;
  if (!slide || slide.zoomLevels.initial <= 0) return 1;
  return slide.currZoomLevel / slide.zoomLevels.initial;
}

function zoomBy(viewer: PhotoSwipe, direction: -1 | 1) {
  const slide = viewer.currSlide;
  if (!slide) return;
  const initial = slide.zoomLevels.initial;
  const target = Math.min(
    slide.zoomLevels.max,
    Math.max(
      initial,
      slide.currZoomLevel + initial * ZOOM_STEP_MULTIPLIER * direction,
    ),
  );
  viewer.zoomTo(target, viewer.getViewportCenterPoint(), CONTROL_ANIMATION_MS);
}

function resetZoom(viewer: PhotoSwipe) {
  const initial = viewer.currSlide?.zoomLevels.initial;
  if (initial) {
    viewer.zoomTo(
      initial,
      viewer.getViewportCenterPoint(),
      CONTROL_ANIMATION_MS,
    );
  }
}

export function ImageLightbox({
  close,
  index,
  items,
}: {
  close: () => void;
  index: number;
  items: ImageGalleryItem[];
}) {
  const [images, setImages] = useState<ResolvedImage[] | null>(null);
  const [launched, setLaunched] = useState(false);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    let active = true;
    void Promise.all(
      items.map((item, sourceIndex) =>
        resolveImage(item, sourceIndex).catch(() => null),
      ),
    ).then((resolved) => {
      if (!active) return;
      const available = resolved.filter(
        (item): item is ResolvedImage => item !== null,
      );
      if (!available.some((item) => item.sourceIndex === index)) {
        closeRef.current();
        return;
      }
      setImages(available);
    });
    return () => {
      active = false;
    };
  }, [index, items]);

  useEffect(() => {
    if (!images) return;
    let active = true;
    let zoomOutput: HTMLElement | null = null;
    let zoomOutButton: HTMLButtonElement | null = null;
    let zoomInButton: HTMLButtonElement | null = null;
    let resetButton: HTMLButtonElement | null = null;

    const initialIndex = images.findIndex(
      (image) => image.sourceIndex === index,
    );
    const viewer = new PhotoSwipe({
      allowPanToNext: true,
      arrowKeys: true,
      arrowNext: true,
      arrowPrev: true,
      bgClickAction: "close",
      bgOpacity: 0.96,
      clickToCloseNonZoomable: false,
      close: false,
      closeOnVerticalDrag: false,
      counter: true,
      dataSource: images.map((image) => ({
        alt: image.alt,
        height: image.height,
        src: image.src,
        title: image.title,
        width: image.width,
      })),
      doubleTapAction: "zoom",
      escKey: true,
      imageClickAction: false,
      index: initialIndex,
      initialZoomLevel: "fit",
      loop: false,
      maxZoomLevel: (levels) => levels.fit * MAX_ZOOM_MULTIPLIER,
      padding: { bottom: 14, left: 14, right: 14, top: 68 },
      pinchToClose: false,
      returnFocus: true,
      secondaryZoomLevel: (levels) => levels.fit * 2,
      showHideAnimationType: "fade",
      tapAction: "toggle-controls",
      trapFocus: true,
      wheelToZoom: false,
      zoom: false,
      zoomAnimationDuration: CONTROL_ANIMATION_MS,
    });

    const updateControls = () => {
      const slide = viewer.currSlide;
      const ratio = zoomRatio(viewer);
      if (zoomOutput) {
        zoomOutput.textContent = `${Math.round(ratio * 100)}%`;
      }
      const atMinimum = ratio <= 1.001;
      const atMaximum = slide
        ? slide.currZoomLevel >= slide.zoomLevels.max - 0.001
        : false;
      if (zoomOutButton) zoomOutButton.disabled = atMinimum;
      if (zoomInButton) zoomInButton.disabled = atMaximum;
      if (resetButton) resetButton.disabled = atMinimum;
    };

    const updateViewerLabel = () => {
      const current = images[viewer.currIndex];
      const alt = current?.alt ?? "";
      viewer.element?.setAttribute(
        "aria-label",
        alt ? `Image viewer: ${alt}` : "Image viewer",
      );
    };

    viewer.on("uiRegister", () => {
      viewer.ui?.registerElement({
        ariaLabel: "Zoom out",
        className: "pswp__button--buzz-zoom-out",
        html: ICONS.minus,
        isButton: true,
        name: "buzzZoomOut",
        onClick: () => zoomBy(viewer, -1),
        onInit: (element) => {
          zoomOutButton = element as HTMLButtonElement;
        },
        order: 7,
        title: "Zoom out",
      });
      viewer.ui?.registerElement({
        className: "pswp__buzz-zoom",
        html: `${MIN_ZOOM_PERCENT}%`,
        name: "buzzZoom",
        onInit: (element) => {
          element.setAttribute("aria-label", "Image zoom");
          zoomOutput = element;
        },
        order: 8,
        tagName: "output",
      });
      viewer.ui?.registerElement({
        ariaLabel: "Zoom in",
        className: "pswp__button--buzz-zoom-in",
        html: ICONS.plus,
        isButton: true,
        name: "buzzZoomIn",
        onClick: () => zoomBy(viewer, 1),
        onInit: (element) => {
          zoomInButton = element as HTMLButtonElement;
        },
        order: 9,
        title: "Zoom in",
      });
      viewer.ui?.registerElement({
        ariaLabel: "Reset zoom",
        className: "pswp__button--buzz-reset",
        html: ICONS.reset,
        isButton: true,
        name: "buzzReset",
        onClick: () => resetZoom(viewer),
        onInit: (element) => {
          resetButton = element as HTMLButtonElement;
        },
        order: 10,
        title: "Reset zoom",
      });
      viewer.ui?.registerElement({
        ariaLabel: "Close image viewer",
        className: "pswp__button--buzz-close",
        html: ICONS.close,
        isButton: true,
        name: "buzzClose",
        onClick: () => viewer.close(),
        order: 11,
        title: "Close image viewer",
      });
    });
    viewer.on("afterInit", () => {
      updateViewerLabel();
      updateControls();
    });
    viewer.on("contentAppendImage", ({ content }) => {
      const title = images[content.index]?.title;
      if (title && content.element instanceof HTMLImageElement) {
        content.element.title = title;
      }
    });
    viewer.on("change", () => {
      updateViewerLabel();
      updateControls();
    });
    viewer.on("keydown", (event) => {
      const keyboardEvent = event.originalEvent;
      if (
        keyboardEvent.ctrlKey ||
        keyboardEvent.metaKey ||
        keyboardEvent.altKey
      ) {
        return;
      }
      if (keyboardEvent.key === "+" || keyboardEvent.key === "=") {
        event.preventDefault();
        keyboardEvent.preventDefault();
        zoomBy(viewer, 1);
      } else if (keyboardEvent.key === "-" || keyboardEvent.key === "_") {
        event.preventDefault();
        keyboardEvent.preventDefault();
        zoomBy(viewer, -1);
      } else if (keyboardEvent.key === "0") {
        event.preventDefault();
        keyboardEvent.preventDefault();
        resetZoom(viewer);
      }
    });
    viewer.on("zoomPanUpdate", updateControls);
    viewer.on("destroy", () => {
      if (active) closeRef.current();
    });

    viewer.init();
    setLaunched(true);
    return () => {
      active = false;
      if (!viewer.isDestroying) viewer.destroy();
    };
  }, [images, index]);

  if (launched) return null;
  return createPortal(
    <div
      aria-label="Image viewer"
      aria-modal="true"
      className="image-lightbox"
      role="dialog"
    >
      <div className="image-lightbox-toolbar">
        <button aria-label="Close image viewer" onClick={close} type="button">
          <X aria-hidden="true" size={21} />
        </button>
      </div>
      <span className="image-lightbox-loading" role="status">
        <LoaderCircle aria-hidden="true" className="spin" size={22} /> Loading
        image…
      </span>
    </div>,
    document.body,
  );
}
