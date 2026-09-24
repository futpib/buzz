import { requireSession } from "@/server/auth";
import { loadActivityWorkspace } from "@/server/activity";
import { ActivityShell } from "@/ui/ActivityShell";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const session = await requireSession();
  return <ActivityShell initial={await loadActivityWorkspace(session)} />;
}
