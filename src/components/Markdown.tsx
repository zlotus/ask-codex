import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  children: string;
  compact?: boolean;
}

export function Markdown({ children, compact = false }: MarkdownProps) {
  return (
    <div className={compact ? "markdown markdown--compact" : "markdown"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: label, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">{label}</a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
