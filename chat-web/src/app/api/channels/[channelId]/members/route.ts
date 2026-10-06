import { getRequestSession } from "@/server/auth";
import { loadMembers } from "@/server/members";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ channelId: string }> },
): Promise<Response> {
  const session = getRequestSession(request);
  if (!session)
    return Response.json({ error: "Login required" }, { status: 401 });
  try {
    const { channelId } = await context.params;
    return Response.json(
      await loadMembers(
        session,
        channelId,
        new URL(request.url).searchParams.get("fresh") === "1",
      ),
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not load members",
      },
      { status: 400 },
    );
  }
}
