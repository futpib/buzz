import { notFound } from "next/navigation";

import { requireSession } from "@/server/auth";
import { loadWorkspace, UnknownChannelError } from "@/server/data";
import { WorkspaceShell } from "@/ui/WorkspaceShell";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ channelId: string }>;
  searchParams: Promise<{
    thread?: string | string[];
    message?: string | string[];
  }>;
};

export default async function ChannelPage({ params, searchParams }: PageProps) {
  const { channelId } = await params;
  const query = await searchParams;
  const rootId = typeof query.thread === "string" ? query.thread : null;
  const targetMessageId =
    typeof query.message === "string" && /^[0-9a-f]{64}$/i.test(query.message)
      ? query.message
      : null;
  const session = await requireSession();
  try {
    const view = await loadWorkspace(session, channelId, rootId);
    return <WorkspaceShell initial={view} targetMessageId={targetMessageId} />;
  } catch (error) {
    if (error instanceof UnknownChannelError) notFound();
    throw error;
  }
}
