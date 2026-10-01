"use client";

import { LoaderCircle } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import type { ComponentProps } from "react";
import { useState } from "react";
import { createPortal } from "react-dom";

type ViewLinkProps = Omit<ComponentProps<typeof Link>, "prefetch"> & {
  prefetchMode?: "eager" | "intent";
};

export function ViewLink({
  children,
  onFocus,
  onMouseEnter,
  onTouchStart,
  prefetchMode = "intent",
  ...props
}: ViewLinkProps) {
  const [intent, setIntent] = useState(false);
  const warm = () => setIntent(true);
  return (
    <Link
      {...props}
      onFocus={(event) => {
        warm();
        onFocus?.(event);
      }}
      onMouseEnter={(event) => {
        warm();
        onMouseEnter?.(event);
      }}
      onTouchStart={(event) => {
        warm();
        onTouchStart?.(event);
      }}
      prefetch={prefetchMode === "eager" || intent}
    >
      {children}
      <NavigationFeedback />
    </Link>
  );
}

function NavigationFeedback() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <>
      <LoaderCircle
        aria-label="Loading"
        className="link-pending spin"
        size={14}
      />
      <NavigationProgress />
    </>
  );
}

export function NavigationProgress() {
  return createPortal(
    <span
      aria-label="Loading destination"
      aria-live="polite"
      className="navigation-progress"
      role="status"
    >
      <LoaderCircle aria-hidden="true" className="spin" size={14} />
      Loading…
    </span>,
    document.body,
  );
}
