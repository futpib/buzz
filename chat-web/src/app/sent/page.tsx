import { requireSession } from "@/server/auth";
import { loadSentWorkspace } from "@/server/sent";
import { SentShell } from "@/ui/SentShell";

export const dynamic = "force-dynamic";

export default async function SentPage() {
  const session = await requireSession();
  return <SentShell initial={await loadSentWorkspace(session)} />;
}
