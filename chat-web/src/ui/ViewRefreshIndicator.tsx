import { LoaderCircle } from "lucide-react";

export function ViewRefreshIndicator({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <span aria-live="polite" className="view-refresh" role="status">
      <LoaderCircle aria-hidden="true" className="spin" size={14} />
      Updating
    </span>
  );
}
