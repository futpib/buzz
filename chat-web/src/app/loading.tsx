export default function Loading() {
  return (
    <main className="loading-shell" aria-label="Loading Buzz">
      <aside className="loading-sidebar" />
      <section className="loading-main">
        <div className="loading-header" />
        <div className="loading-lines">
          {["one", "two", "three", "four", "five", "six", "seven"].map(
            (line) => (
              <div className="loading-line" key={line} />
            ),
          )}
        </div>
      </section>
    </main>
  );
}
