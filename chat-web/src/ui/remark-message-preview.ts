type MarkdownNode = {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
};

type PreviewState = {
  charactersLeft: number;
  nodesLeft: number;
  imagesLeft: number;
  truncated: boolean;
  hasEllipsis: boolean;
};

const NON_RENDERED_ROOT_NODES = new Set(["definition", "footnoteDefinition"]);
const VALUE_NODES = new Set(["code", "inlineCode", "text"]);
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function truncateValue(
  node: MarkdownNode,
  state: PreviewState,
): MarkdownNode | null {
  const value = node.value ?? "";
  const characters = [...GRAPHEME_SEGMENTER.segment(value)].map(
    ({ segment }) => segment,
  );
  if (characters.length <= state.charactersLeft) {
    state.charactersLeft -= characters.length;
    return node;
  }
  if (state.charactersLeft <= 0) {
    state.truncated = true;
    return null;
  }
  node.value = `${characters.slice(0, state.charactersLeft).join("").trimEnd()}…`;
  state.charactersLeft = 0;
  state.truncated = true;
  state.hasEllipsis = true;
  return node;
}

function truncateNode(
  node: MarkdownNode,
  state: PreviewState,
): MarkdownNode | null {
  state.nodesLeft -= 1;
  if (state.nodesLeft < 0) {
    state.truncated = true;
    return null;
  }
  if (node.type === "image") {
    state.imagesLeft -= 1;
    if (state.imagesLeft < 0) {
      state.truncated = true;
      return null;
    }
    return node;
  }
  if (node.type && VALUE_NODES.has(node.type)) {
    return truncateValue(node, state);
  }
  if (!node.children) return node;

  const children: MarkdownNode[] = [];
  for (const child of node.children) {
    const preview = truncateNode(child, state);
    if (preview) children.push(preview);
    if (state.charactersLeft === 0 || state.nodesLeft < 0) break;
  }
  if (children.length < node.children.length) state.truncated = true;
  node.children = children;
  return children.length > 0 ? node : null;
}

function appendEllipsis(nodes: MarkdownNode[]): boolean {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.children && appendEllipsis(node.children)) return true;
    if (
      node.type &&
      VALUE_NODES.has(node.type) &&
      typeof node.value === "string"
    ) {
      node.value = `${node.value.trimEnd()}…`;
      return true;
    }
  }
  return false;
}

/** Keep rich Markdown semantics while bounding index-card work and output. */
export default function remarkMessagePreview({
  maxBlocks = 3,
  maxCharacters = 72,
  maxImages = 1,
  maxNodes = 80,
}: {
  maxBlocks?: number;
  maxCharacters?: number;
  maxImages?: number;
  maxNodes?: number;
} = {}) {
  return (tree: MarkdownNode) => {
    const state: PreviewState = {
      charactersLeft: maxCharacters,
      nodesLeft: maxNodes,
      imagesLeft: maxImages,
      truncated: false,
      hasEllipsis: false,
    };
    const children = tree.children ?? [];
    const definitions = children.filter(
      (node) => node.type && NON_RENDERED_ROOT_NODES.has(node.type),
    );
    const rendered = children.filter(
      (node) => !node.type || !NON_RENDERED_ROOT_NODES.has(node.type),
    );
    const selected = new Set(rendered.slice(0, maxBlocks));
    if (rendered.length > selected.size) state.truncated = true;

    const preview: MarkdownNode[] = [];
    for (const child of rendered) {
      if (!selected.has(child)) continue;
      const truncated = truncateNode(child, state);
      if (truncated) preview.push(truncated);
      if (state.charactersLeft === 0 || state.nodesLeft < 0) break;
    }
    if (state.truncated && !state.hasEllipsis && !appendEllipsis(preview)) {
      preview.push({
        type: "paragraph",
        children: [{ type: "text", value: "…" }],
      });
    }
    tree.children = [...preview, ...definitions];
  };
}
