import { requireSession } from "@/server/auth";
import { loadInboxWorkspace } from "@/server/inbox";
import { InboxShell } from "@/ui/InboxShell";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const session = await requireSession();
  return <InboxShell initial={await loadInboxWorkspace(session)} />;
}
