import { assertSameOrigin, getRequestSession } from "@/server/auth";
import { getServerConfig } from "@/server/env";
import { relayMediaTarget } from "@/server/media-auth";
import { validateMediaUploadAuthorization } from "@/server/media-upload-auth";
import { attachmentSizeLimit, parseBlobDescriptor } from "@/shared/attachments";

export const dynamic = "force-dynamic";

function relayUploadTarget(): URL {
  return new URL("/upload", `${getServerConfig().relayHttpUrl}/`);
}

function loginRequired(): Response {
  return Response.json(
    { error: "Login required", loginRequired: true },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  if (!getRequestSession(request)) return loginRequired();
  return Response.json(
    { server: relayUploadTarget().host },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const session = getRequestSession(request);
    if (!session) return loginRequired();

    const contentType =
      request.headers.get("content-type")?.split(";", 1)[0].trim() ||
      "application/octet-stream";
    const rawLength = request.headers.get("content-length") ?? "";
    const size = Number(rawLength);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error("Attachment size is missing or invalid");
    }
    const limit = attachmentSizeLimit(contentType);
    if (size > limit) {
      throw new Error(
        `Attachment is larger than ${Math.floor(limit / 1_048_576)} MB`,
      );
    }
    const hash = request.headers.get("x-sha-256") ?? "";
    const authorization = request.headers.get("x-buzz-media-authorization");
    const target = relayUploadTarget();
    validateMediaUploadAuthorization(
      authorization,
      session.pubkey,
      hash,
      target.host,
    );
    if (!request.body) throw new Error("Attachment body is missing");

    const headers = new Headers({
      Authorization: authorization ?? "",
      "Content-Type": contentType,
      "X-SHA-256": hash,
    });
    if (session.authTag) {
      headers.set("x-auth-tag", JSON.stringify(session.authTag));
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: "PUT",
        headers,
        body: request.body,
        redirect: "error",
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(contentType === "video/mp4" ? 600_000 : 120_000),
        ]),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
    } catch {
      return Response.json(
        { error: "Media relay is unavailable" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    const raw = await upstream.text();
    if (!upstream.ok) {
      let relayError = "Attachment was not uploaded";
      try {
        const parsed = JSON.parse(raw) as {
          error?: unknown;
          message?: unknown;
        };
        const candidate = parsed.error ?? parsed.message;
        if (typeof candidate === "string" && candidate.trim()) {
          relayError = candidate.slice(0, 500);
        }
      } catch {
        // Keep the stable user-facing error for a non-JSON relay response.
      }
      return Response.json(
        { error: relayError },
        {
          status: upstream.status,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const descriptor = parseBlobDescriptor(JSON.parse(raw));
    if (descriptor.sha256 !== hash || descriptor.size !== size) {
      throw new Error("Upload response does not match the attachment");
    }
    relayMediaTarget(getServerConfig().relayHttpUrl, descriptor.url);
    return Response.json(descriptor, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Attachment was not uploaded",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
