import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { AuthenticatedImage } from "@/ui/AuthenticatedImage";

const markdownComponents: Components = {
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
