import type { Metadata } from "next";

import { requireSession } from "@/server/auth";
import { loadSentWorkspace } from "@/server/sent";
import { PAGE_TITLES } from "@/shared/page-title";
import { SentShell } from "@/ui/SentShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: PAGE_TITLES.sent };

export default async function SentPage() {
  const session = await requireSession();
  return <SentShell initial={await loadSentWorkspace(session)} />;
}
