import { redirect } from "next/navigation";

import { EmptyWorkspace } from "@/ui/EmptyWorkspace";
import { loadWorkspaceIndex } from "@/server/data";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { defaultChannel } = await loadWorkspaceIndex();
  if (defaultChannel) redirect(`/channels/${defaultChannel.id}`);
  return <EmptyWorkspace />;
}
