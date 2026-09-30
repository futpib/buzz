import { responseError, restoreBrowserSession } from "@/client/browser-session";

export async function fetchView<T>(
  url: string,
  pubkey: string,
  signal: AbortSignal,
): Promise<T> {
  const request = () => fetch(url, { cache: "no-store", signal });
  let response = await request();
  if (response.status === 401) {
    await restoreBrowserSession(pubkey);
    signal.throwIfAborted();
    response = await request();
  }
  if (!response.ok)
    throw new Error(await responseError(response, "Refresh failed"));
  const view = (await response.json()) as T;
  signal.throwIfAborted();
  return view;
}
