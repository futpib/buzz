import { Children, memo, type ReactNode } from "react";
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ChannelView } from "@/server/types";
import { isVideoAttachmentUrl } from "@/shared/attachments";
import { parseMessageLink } from "@/shared/message-link";
import { AuthenticatedAttachmentLink } from "@/ui/AuthenticatedAttachmentLink";
import { AuthenticatedImage } from "@/ui/AuthenticatedImage";
import { AuthenticatedVideo } from "@/ui/AuthenticatedVideo";
import { BuzzMessageLink } from "@/ui/BuzzMessageLink";
import { MessageTable, MessageTablePreview } from "@/ui/MessageTable";
import remarkMessageLinks from "@/ui/remark-message-links";
import remarkMessagePreview from "@/ui/remark-message-preview";

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
  preview = false,
}: {
  channels?: ChannelView[];
  content: string;
  preview?: boolean;
}) {
  const channelNames = new Map(
    channels.map((channel) => [channel.id, channel.name]),
  );
  const markdownComponents: Components = {
    table: preview ? MessageTablePreview : MessageTable,
    a: ({ node: _node, children, href, title }) => {
      if (href && isVideoAttachmentUrl(href)) {
        return (
          <>
            <AuthenticatedVideo
              src={href}
              label={childText(children)}
              title={title}
            />
            <AuthenticatedAttachmentLink href={href} title={title}>
              {children}
            </AuthenticatedAttachmentLink>
          </>
        );
      }
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
      typeof src === "string" && isVideoAttachmentUrl(src) ? (
        <AuthenticatedVideo src={src} label={alt} title={title} />
      ) : typeof src === "string" ? (
        <AuthenticatedImage alt={alt} src={src} title={title} />
      ) : null,
  };

  return (
    <div
      className={preview ? "message-body message-body-preview" : "message-body"}
    >
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[
          remarkGfm,
          remarkMessageLinks,
          ...(preview ? [remarkMessagePreview] : []),
        ]}
        urlTransform={(url) =>
          parseMessageLink(url) ? url : defaultUrlTransform(url)
        }
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
