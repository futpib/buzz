import { assertSameOrigin, getRequestSession } from "@/server/auth";
import {
  applyNavigationAppDataEvent,
  loadNavigationWorkspace,
  markNavigationViewsStale,
  refreshNavigationWorkspace,
} from "@/server/navigation";
import { validateNavigationAppDataEvent } from "@/server/navigation-validation";
import type { NostrEvent } from "@/server/types";

export const dynamic = "force-dynamic";

async function publishPreferenceWithRetry(
  session: NonNullable<ReturnType<typeof getRequestSession>>,
  event: NostrEvent,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await session.relay.publish(event);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1_000 * 2 ** attempt),
        );
      }
    }
  }
  throw lastError;
}

export async function GET(request: Request): Promise<Response> {
  const session = getRequestSession(request);
  if (!session) {
    return Response.json({ error: "Login required" }, { status: 401 });
  }
  try {
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    const view = fresh
      ? await refreshNavigationWorkspace(session)
      : await loadNavigationWorkspace(session);
    return Response.json(view, {
      headers: { "Cache-Control": "private, no-cache" },
    });
  } catch (error) {
    console.error("web navigation state failed", error);
    return Response.json(
      { error: "Navigation state is temporarily unavailable" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const session = getRequestSession(request);
    if (!session) {
      return Response.json({ error: "Login required" }, { status: 401 });
    }
    const raw = await request.text();
    if (raw.length > 192 * 1024) {
      throw new Error("Preference request is too large");
    }
    const event = JSON.parse(raw) as NostrEvent;
    validateNavigationAppDataEvent(session.pubkey, event);
    await publishPreferenceWithRetry(session, event);
    await applyNavigationAppDataEvent(session, event).catch(() => {
      // The relay acknowledged the write; a stale cache remains a retry record.
      markNavigationViewsStale(session);
    });
    return Response.json({ id: event.id });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Preference was not saved",
      },
      { status: 400 },
    );
  }
}
