import { requireSession } from "@/server/auth";
import { loadThreadsWorkspace } from "@/server/data";
import { ThreadsShell } from "@/ui/ThreadsShell";

export const dynamic = "force-dynamic";

export default async function ThreadsPage() {
  const session = await requireSession();
  return <ThreadsShell initial={await loadThreadsWorkspace(session)} />;
}
