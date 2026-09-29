import { MessageSquareText } from "lucide-react";
import type { ReactNode } from "react";

import type { ParsedMessageLink } from "@/shared/message-link";
import { messageLinkRoute } from "@/shared/message-link";
import { ViewLink } from "@/ui/ViewLink";

export function BuzzMessageLink({
  children,
  channelName,
  link,
  raw,
}: {
  children: ReactNode;
  channelName: string | null;
  link: ParsedMessageLink;
  raw: boolean;
}) {
  const visibleLabel = channelName
    ? `#${channelName}`
    : `#${link.channelId.slice(0, 8)}…`;
  const contents = raw ? (
    <>
      <MessageSquareText aria-hidden="true" size={13} strokeWidth={2.2} />
      <span>{visibleLabel}</span>
    </>
  ) : (
    children
  );

  if (!channelName) {
    return (
      <span
        className={
          raw
            ? "buzz-message-link buzz-message-link-unavailable"
            : "buzz-message-anchor buzz-message-link-unavailable"
        }
        title="Channel unavailable"
      >
        {contents}
      </span>
    );
  }

  return (
    <ViewLink
      aria-label={`Open message in channel ${channelName} in a new tab`}
      className={raw ? "buzz-message-link" : "buzz-message-anchor"}
      href={messageLinkRoute(link)}
      prefetchMode="intent"
      rel="noopener noreferrer"
      scroll={false}
      target="_blank"
      title={
        raw ? `Message in #${channelName} (opens in a new tab)` : undefined
      }
    >
      {contents}
    </ViewLink>
  );
}
