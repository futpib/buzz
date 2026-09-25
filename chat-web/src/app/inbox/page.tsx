import type { Metadata } from "next";

import { requireSession } from "@/server/auth";
import { loadInboxWorkspace } from "@/server/inbox";
import { PAGE_TITLES } from "@/shared/page-title";
import { InboxShell } from "@/ui/InboxShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: PAGE_TITLES.inbox };

export default async function InboxPage() {
  const session = await requireSession();
  return <InboxShell initial={await loadInboxWorkspace(session)} />;
}
