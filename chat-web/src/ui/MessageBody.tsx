import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AuthenticatedImage } from "@/ui/AuthenticatedImage";

export function MessageBody({ content }: { content: string }) {
  return (
    <div className="message-body">
      <ReactMarkdown
        components={{
          img: ({ alt = "", src, title }) =>
            typeof src === "string" ? (
              <AuthenticatedImage alt={alt} src={src} title={title} />
            ) : null,
        }}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
