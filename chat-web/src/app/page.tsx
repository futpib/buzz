import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireSession } from "@/server/auth";
import { EmptyWorkspace } from "@/ui/EmptyWorkspace";
import { loadWorkspaceIndex } from "@/server/data";
import { PAGE_TITLES } from "@/shared/page-title";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: PAGE_TITLES.home };

export default async function HomePage() {
  const session = await requireSession();
  const { defaultChannel } = await loadWorkspaceIndex(session);
  if (defaultChannel) redirect(`/channels/${defaultChannel.id}`);
  return <EmptyWorkspace />;
}
