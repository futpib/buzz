"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
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
