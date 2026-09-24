import { Children, memo, type ReactNode } from "react";
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ChannelView } from "@/server/types";
import { parseMessageLink } from "@/shared/message-link";
import { AuthenticatedAttachmentLink } from "@/ui/AuthenticatedAttachmentLink";
import { AuthenticatedImage } from "@/ui/AuthenticatedImage";
import { BuzzMessageLink } from "@/ui/BuzzMessageLink";
import remarkMessageLinks from "@/ui/remark-message-links";

function childText(children: ReactNode): string {
  return Children.toArray(children)
    .filter(
      (child): child is string | number =>
        typeof child === "string" || typeof child === "number",
    )
    .join("");
}

export const MessageBody = memo(function MessageBody({
  channels = [],
  content,
}: {
  channels?: ChannelView[];
  content: string;
}) {
  const channelNames = new Map(
    channels.map((channel) => [channel.id, channel.name]),
  );
  const markdownComponents: Components = {
    a: ({ node: _node, children, href, title }) => {
      const link = typeof href === "string" ? parseMessageLink(href) : null;
      if (link) {
        return (
          <BuzzMessageLink
            channelName={channelNames.get(link.channelId) ?? null}
            link={link}
            raw={childText(children) === href}
          >
            {children}
          </BuzzMessageLink>
        );
      }
      return (
        <AuthenticatedAttachmentLink href={href} title={title}>
          {children}
        </AuthenticatedAttachmentLink>
      );
    },
    img: ({ alt = "", src, title }) =>
      typeof src === "string" ? (
        <AuthenticatedImage alt={alt} src={src} title={title} />
      ) : null,
  };

  return (
    <div className="message-body">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm, remarkMessageLinks]}
        urlTransform={(url) =>
          parseMessageLink(url) ? url : defaultUrlTransform(url)
        }
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
