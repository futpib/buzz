import type { Metadata } from "next";

import { requireSession } from "@/server/auth";
import { loadThreadsWorkspace } from "@/server/data";
import { PAGE_TITLES } from "@/shared/page-title";
import { ThreadsShell } from "@/ui/ThreadsShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: PAGE_TITLES.threads };

export default async function ThreadsPage() {
  const session = await requireSession();
  return <ThreadsShell initial={await loadThreadsWorkspace(session)} />;
}
