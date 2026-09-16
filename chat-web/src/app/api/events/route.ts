import { assertSameOrigin, getRequestSession } from "@/server/auth";
import { publishMessage } from "@/server/messages";
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
    if (raw.length > 96 * 1024) throw new Error("Message request is too large");
    const event = JSON.parse(raw) as NostrEvent;
    return Response.json({ id: await publishMessage(session, event) });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Message was not sent",
      },
      { status: 400 },
    );
  }
}
