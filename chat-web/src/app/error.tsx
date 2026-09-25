"use client";

import { useEffect } from "react";

import { browserTitle, PAGE_TITLES } from "@/shared/page-title";

export default function ErrorPage({ reset }: { reset: () => void }) {
  useEffect(() => {
    document.title = browserTitle(PAGE_TITLES.error);
  }, []);

  return (
    <main className="centered-state">
      <div className="state-mark">!</div>
      <h1>Buzz is temporarily unavailable</h1>
      <p>The server could not assemble this view from the relay.</p>
      <button className="primary-button" onClick={reset} type="button">
        Try again
      </button>
    </main>
  );
}
