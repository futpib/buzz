import type { Metadata } from "next";

import { requireSession } from "@/server/auth";
import { loadActivityWorkspace } from "@/server/activity";
import { PAGE_TITLES } from "@/shared/page-title";
import { ActivityShell } from "@/ui/ActivityShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: PAGE_TITLES.activity };

export default async function ActivityPage() {
  const session = await requireSession();
  return <ActivityShell initial={await loadActivityWorkspace(session)} />;
}
