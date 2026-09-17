import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { AuthenticatedImage } from "@/ui/AuthenticatedImage";

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} rel="noopener noreferrer" target="_blank" />
  ),
  img: ({ alt = "", src, title }) =>
    typeof src === "string" ? (
      <AuthenticatedImage alt={alt} src={src} title={title} />
    ) : null,
};

export function MessageBody({ content }: { content: string }) {
  return (
    <div className="message-body">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
