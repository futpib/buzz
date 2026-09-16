export default function Loading() {
  return (
    <main
      className="loading-shell"
      aria-label="Loading Buzz"
      aria-live="polite"
    >
      <aside className="loading-sidebar">
        <div className="loading-sidebar-header">
          <span className="loading-block loading-brand" />
          <span className="loading-block loading-workspace-name" />
        </div>
        <div className="loading-sidebar-links">
          {[
            "inbox",
            "threads",
            "activity",
            "one",
            "two",
            "three",
            "four",
            "five",
          ].map((item) => (
            <span className="loading-block loading-sidebar-link" key={item} />
          ))}
        </div>
      </aside>
      <section className="loading-main">
        <div className="loading-header">
          <span className="loading-block loading-title" />
        </div>
        <div className="loading-messages">
          {["one", "two", "three", "four", "five", "six", "seven"].map(
            (item) => (
              <div className="loading-message" key={item}>
                <span className="loading-block loading-avatar" />
                <span className="loading-message-copy">
                  <span className="loading-block loading-name" />
                  <span className="loading-block loading-line" />
                  <span className="loading-block loading-line loading-line-short" />
                </span>
              </div>
            ),
          )}
        </div>
      </section>
    </main>
  );
}
