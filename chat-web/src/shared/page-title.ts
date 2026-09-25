import type { ChannelView } from "@/server/types";

export const BUZZ_TITLE = "Buzz";
export const BUZZ_TITLE_TEMPLATE = `%s — ${BUZZ_TITLE}`;

export const PAGE_TITLES = {
  activity: "Activity",
  error: "Unavailable",
  home: "Home",
  inbox: "Inbox",
  login: "Sign in",
  notFound: "Page not found",
  sent: "Sent",
  threads: "Threads",
} as const;

export function browserTitle(title: string): string {
  return `${title} — ${BUZZ_TITLE}`;
}

export function channelPageTitle(
  channel: Pick<ChannelView, "name" | "type">,
  threadOpen: boolean,
): string {
  const channelName = channel.type === "dm" ? channel.name : `#${channel.name}`;
  return threadOpen ? `Thread in ${channelName}` : channelName;
}
