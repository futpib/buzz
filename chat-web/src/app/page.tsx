import { redirect } from "next/navigation";

import { requireSession } from "@/server/auth";
import { EmptyWorkspace } from "@/ui/EmptyWorkspace";
import { loadWorkspaceIndex } from "@/server/data";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await requireSession();
  const { defaultChannel } = await loadWorkspaceIndex(session);
  if (defaultChannel) redirect(`/channels/${defaultChannel.id}`);
  return <EmptyWorkspace />;
}
