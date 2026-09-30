export function ViewRefreshError({
  error,
  active,
  retry,
}: {
  error: string | null;
  active: boolean;
  retry: () => void;
}) {
  if (!error) return null;
  return (
    <div className="view-refresh-error" role="status">
      <span>{error}. Showing saved results; retrying automatically.</span>
      <button disabled={active} onClick={retry} type="button">
        Retry now
      </button>
    </div>
  );
}
