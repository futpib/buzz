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
      {createPortal(
        <span
          aria-label="Loading destination"
          aria-live="polite"
          className="navigation-loading-overlay"
          role="status"
        >
          <span className="loading-sidebar">
            <span className="loading-sidebar-header">
              <span className="loading-block loading-brand" />
              <span className="loading-block loading-workspace-name" />
            </span>
            <span className="loading-sidebar-links">
              {["one", "two", "three", "four", "five"].map((item) => (
                <span
                  className="loading-block loading-sidebar-link"
                  key={item}
                />
              ))}
            </span>
          </span>
          <span className="loading-main">
            <span className="loading-header">
              <span className="loading-block loading-title" />
            </span>
            <span className="loading-messages">
              {["one", "two", "three", "four", "five", "six"].map((item) => (
                <span className="loading-message" key={item}>
                  <span className="loading-block loading-avatar" />
                  <span className="loading-message-copy">
                    <span className="loading-block loading-name" />
                    <span className="loading-block loading-line" />
                    <span className="loading-block loading-line loading-line-short" />
                  </span>
                </span>
              ))}
            </span>
          </span>
        </span>,
        document.body,
      )}
    </>
  );
}
