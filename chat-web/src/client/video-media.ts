import { responseError, restoreBrowserSession } from "@/client/browser-session";
import {
  encodeNostrAuthorization,
  loadSigningCredential,
  makeMediaGetAuthEvent,
  signingIdentitySignal,
} from "@/client/identity";
import { MAX_VIDEO_BYTES } from "@/shared/attachments";

/** Load a protected video through the authenticated media proxy. */
export async function loadProtectedVideo(
  target: URL,
  signal: AbortSignal,
): Promise<Blob> {
  const identitySignal = signingIdentitySignal();
  const credential = await loadSigningCredential();
  signal.throwIfAborted();
  identitySignal.throwIfAborted();
  if (!credential) throw new Error("Sign in again to load this video");
  const event = makeMediaGetAuthEvent(credential, target.host);
  const fetchVideo = () =>
    fetch(`/api/media?${new URLSearchParams({ url: target.href })}`, {
      cache: "no-store",
      headers: {
        "X-Buzz-Media-Authorization": encodeNostrAuthorization(event),
      },
      signal: AbortSignal.any([
        signal,
        identitySignal,
        AbortSignal.timeout(60_000),
      ]),
    });
  let response = await fetchVideo();
  if (response.status === 401) {
    await restoreBrowserSession(event.pubkey);
    signal.throwIfAborted();
    response = await fetchVideo();
  }
  if (!response.ok)
    throw new Error(await responseError(response, "Video could not be loaded"));
  if (
    !response.headers.get("content-type")?.toLowerCase().startsWith("video/")
  ) {
    await response.body?.cancel();
    throw new Error("Attachment is not a video");
  }
  if (Number(response.headers.get("content-length")) > MAX_VIDEO_BYTES) {
    await response.body?.cancel();
    throw new Error("Video exceeds the attachment size limit");
  }
  const blob = await response.blob();
  if (blob.size > MAX_VIDEO_BYTES)
    throw new Error("Video exceeds the attachment size limit");
  return blob;
}
