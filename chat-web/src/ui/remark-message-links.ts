import { parseMessageLink } from "@/shared/message-link";

const MESSAGE_LINK = /buzz:\/\/message\?[^\s<>"')\]]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

type MarkdownNode = {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
};

function isUnmatchedClosing(value: string): boolean {
  const closing = value.at(-1);
  const opening = closing === ")" ? "(" : "[";
  return Boolean(
    closing && value.split(closing).length > value.split(opening).length,
  );
}

function trimMatch(value: string): { link: string; trailing: string } {
  let link = value.replace(TRAILING_PUNCTUATION, "");
  while (/[)\]]$/.test(link) && isUnmatchedClosing(link)) {
    link = link.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return { link, trailing: value.slice(link.length) };
}

function splitText(value: string): MarkdownNode[] {
  MESSAGE_LINK.lastIndex = 0;
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (
    let match = MESSAGE_LINK.exec(value);
    match;
    match = MESSAGE_LINK.exec(value)
  ) {
    const { link, trailing } = trimMatch(match[0]);
    if (!parseMessageLink(link)) continue;
    if (match.index > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, match.index) });
    }
    nodes.push({
      type: "link",
      url: link,
      children: [{ type: "text", value: link }],
    });
    if (trailing) nodes.push({ type: "text", value: trailing });
    cursor = match.index + match[0].length;
  }
  if (nodes.length === 0) return [{ type: "text", value }];
  if (cursor < value.length)
    nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

function visit(node: MarkdownNode): void {
  if (
    !node.children ||
    node.type === "link" ||
    node.type === "code" ||
    node.type === "inlineCode"
  ) {
    return;
  }
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index];
    if (child.type === "text" && typeof child.value === "string") {
      const replacement = splitText(child.value);
      if (replacement.length !== 1 || replacement[0]?.type !== "text") {
        node.children.splice(index, 1, ...replacement);
      }
    } else {
      visit(child);
    }
  }
}

/** Linkify bare canonical `buzz://message` URLs before React Markdown renders them. */
export default function remarkMessageLinks() {
  return (tree: MarkdownNode) => visit(tree);
}
