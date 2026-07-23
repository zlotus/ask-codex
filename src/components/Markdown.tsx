import { Children, isValidElement, type ComponentPropsWithoutRef, type ReactNode } from "react";
import type { Root } from "mdast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { CodeBlock } from "./CodeBlock";

interface MarkdownProps {
  children: string;
  compact?: boolean;
  maxCharacters?: number;
}

const DEFAULT_MARKDOWN_CHARACTERS = 240_000;
const COMPACT_MARKDOWN_CHARACTERS = 120_000;
const MAX_MARKDOWN_NODES = 2_000;
const MARKDOWN_COMPLEXITY_NOTICE = "Additional Markdown omitted because it exceeds the rendering complexity limit.";

interface MutableMarkdownNode {
  children?: MutableMarkdownNode[];
}

const remarkLimitNodes: Plugin<[], Root> = () => (tree) => {
  let remaining = MAX_MARKDOWN_NODES - 3;
  let truncated = false;

  const prune = (node: MutableMarkdownNode): boolean => {
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    remaining -= 1;
    if (!node.children) return true;

    const children: MutableMarkdownNode[] = [];
    for (const child of node.children) {
      if (!prune(child)) break;
      children.push(child);
    }
    node.children = children;
    return true;
  };

  prune(tree as unknown as MutableMarkdownNode);
  if (truncated) {
    tree.children.push({
      type: "paragraph",
      children: [{ type: "text", value: MARKDOWN_COMPLEXITY_NOTICE }],
    });
  }
};

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return "";
}

function MarkdownPre({ children }: ComponentPropsWithoutRef<"pre">) {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    return <CodeBlock code={extractText(children).replace(/\n$/, "")} />;
  }
  const language = /(?:^|\s)language-([^\s]+)/.exec(child.props.className ?? "")?.[1];
  return (
    <CodeBlock
      code={extractText(child.props.children).replace(/\n$/, "")}
      language={language}
      label={language || "Code"}
    />
  );
}

export function Markdown({ children, compact = false, maxCharacters }: MarkdownProps) {
  const maximum = maxCharacters ?? (compact ? COMPACT_MARKDOWN_CHARACTERS : DEFAULT_MARKDOWN_CHARACTERS);
  const displayed = children.length > maximum ? children.slice(0, maximum) : children;
  const omitted = children.length - displayed.length;
  return (
    <div className={compact ? "markdown markdown--compact" : "markdown"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkLimitNodes]}
        components={{
          a: ({ children: label, href, title }) => href ? (
            <a href={href} title={title} target="_blank" rel="noreferrer">{label}</a>
          ) : <span>{label}</span>,
          pre: MarkdownPre,
        }}
      >
        {displayed}
      </ReactMarkdown>
      {omitted > 0 && (
        <div className="content-omission" role="status">
          {omitted.toLocaleString()} characters omitted from display
        </div>
      )}
    </div>
  );
}
