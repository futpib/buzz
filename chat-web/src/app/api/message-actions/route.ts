import { assertSameOrigin, getRequestSession } from "@/server/auth";
import { markActivityViewsStale } from "@/server/activity";
import { markWorkspaceViewsStale } from "@/server/data";
import { markInboxViewsStale } from "@/server/inbox";
import { publishMessageAction } from "@/server/message-actions";
import { markSearchViewsStale } from "@/server/search";
import { markSentViewsStale } from "@/server/sent";
import type { NostrEvent } from "@/server/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const session = getRequestSession(request);
    if (!session) {
      return Response.json({ error: "Login required" }, { status: 401 });
    }
    const raw = await request.text();
    if (raw.length > 96 * 1_024) {
      throw new Error("Message action request is too large");
    }
    const body = JSON.parse(raw) as {
      event?: NostrEvent;
      channelId?: string;
    };
    if (!body.event) throw new Error("Message action event is required");
    const id = await publishMessageAction(session, body.event);
    const signedChannel = body.event.tags.find((tag) => tag[0] === "h")?.[1];
    markWorkspaceViewsStale(session, signedChannel ?? body.channelId);
    markActivityViewsStale(session);
    markInboxViewsStale(session);
    markSearchViewsStale(session);
    markSentViewsStale(session);
    return Response.json({ id });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Message action failed",
      },
      { status: 400 },
    );
  }
}
