import { notFound } from "next/navigation";

import { loadWorkspace, UnknownChannelError } from "@/server/data";
import { WorkspaceShell } from "@/ui/WorkspaceShell";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ channelId: string }>;
  searchParams: Promise<{ thread?: string | string[] }>;
};

export default async function ChannelPage({ params, searchParams }: PageProps) {
  const { channelId } = await params;
  const query = await searchParams;
  const rootId = typeof query.thread === "string" ? query.thread : null;
  try {
    const view = await loadWorkspace(channelId, rootId);
    return <WorkspaceShell initial={view} />;
  } catch (error) {
    if (error instanceof UnknownChannelError) notFound();
    throw error;
  }
}
