import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MessageBody({ content }: { content: string }) {
  return (
    <div className="message-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
