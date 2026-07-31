import {
  Bot,
  Brain,
  Braces,
  ChevronRight,
  FileCode2,
  Globe,
  Image as ImageIcon,
  LoaderCircle,
  Terminal,
  User,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import type { CodexItem, PlanStep } from "../types/protocol";
import {
  commandText,
  isRecord,
  itemText,
  readString,
  stripAnsi,
  textParts,
  userMessageContent,
} from "../utils/protocol";
import { CodeBlock } from "./CodeBlock";
import { DiffViewer } from "./DiffViewer";
import { LazyDetails } from "./LazyDetails";
import { Markdown } from "./Markdown";
import { PlanView } from "./PlanView";
import { StatusPill } from "./StatusPill";
import { displayToolStatus, isFailedToolActivity } from "./activityUtils";

const TOOL_OUTPUT_MAX_DISPLAY_CHARACTERS = 24_000;
const FAILURE_PREVIEW_MAX_CHARACTERS = 360;
const FAILURE_PREVIEW_MAX_LINES = 3;

interface ItemRendererProps {
  disclosureOpen?: boolean;
  imagePreviewUrls?: readonly string[];
  item: CodexItem;
  onDisclosureOpenChange?: (open: boolean) => void;
}

function omittedCharacters(item: CodexItem, fields: readonly string[]): number {
  const omissions = item.streamOmittedCharacters;
  if (!omissions) return 0;
  return Object.entries(omissions).reduce((total, [key, value]) => (
    fields.some((field) => key === field || key.startsWith(`${field}[`)) && Number.isSafeInteger(value) && value > 0
      ? total + value
      : total
  ), 0);
}

function StreamOmission({ count }: { count: number }) {
  return count > 0 ? (
    <div className="content-omission" role="status">
      {count.toLocaleString()} characters omitted while streaming
    </div>
  ) : null;
}

function JsonBlock({ value, label = "JSON" }: { value: unknown; label?: string }) {
  if (value === undefined || value === null) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <CodeBlock
      code={stripAnsi(text)}
      language="json"
      label={label}
      maxDisplayCharacters={TOOL_OUTPUT_MAX_DISPLAY_CHARACTERS}
      truncate="middle"
    />
  );
}

function approvalReasons(item: CodexItem): string[] {
  if (!Array.isArray(item.approvalReasons)) return [];
  return Array.from(new Set(item.approvalReasons.flatMap((reason) => {
    if (typeof reason !== "string") return [];
    const trimmed = reason.trim();
    return trimmed ? [trimmed] : [];
  })));
}

function failureOutputPreview(item: CodexItem, output: string): string {
  if (!output || !isFailedToolActivity(item)) return "";
  const lines = stripAnsi(output)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-FAILURE_PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length <= FAILURE_PREVIEW_MAX_CHARACTERS) return preview;
  const marker = "... ";
  return `${marker}${preview.slice(-(FAILURE_PREVIEW_MAX_CHARACTERS - marker.length))}`;
}

function ToolDisclosureSummary({
  children,
  item,
}: {
  children: ReactNode;
  item: CodexItem;
}) {
  const status = displayToolStatus(item);
  return (
    <>
      <span className="tool-activity-main">{children}</span>
      <span className="tool-activity-state">
        {status && <StatusPill status={status} />}
        <ChevronRight size={14} className="details-chevron" aria-hidden="true" />
      </span>
    </>
  );
}

function UserMessage({ imagePreviewUrls, item }: ItemRendererProps) {
  const orderedContent = userMessageContent(item);
  const fallbackText = orderedContent.length === 0 ? itemText(item) : "";
  const imageCount = orderedContent.filter((part) => part.type !== "text").length;
  return (
    <article className="message message--user">
      <div className="message-role"><User size={14} aria-hidden="true" />You</div>
      {fallbackText && <Markdown>{fallbackText}</Markdown>}
      {imageCount > 0 && (
        <span className="sr-only" aria-label={`${imageCount} image attachment${imageCount === 1 ? "" : "s"}`} />
      )}
      {orderedContent.map((part, index) => {
        if (part.type === "text") return <Markdown key={`text:${index}`}>{part.text}</Markdown>;
        const imageNumber = orderedContent
          .slice(0, index + 1)
          .filter((candidate) => candidate.type !== "text").length;
        const localImageIndex = orderedContent
          .slice(0, index + 1)
          .filter((candidate) => candidate.type === "localImage").length - 1;
        const previewUrl = part.type === "localImage" && localImageIndex >= 0
          ? imagePreviewUrls?.[localImageIndex]
          : undefined;
        return (
          <div className="message-images" key={`${part.type}:${part.detail ?? "auto"}:${index}`}>
            {previewUrl ? (
              <a
                className="message-image-preview"
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open uploaded image"
                aria-label={`Open uploaded image ${imageNumber} of ${imageCount}`}
              >
                <img
                  src={previewUrl}
                  alt={`Uploaded image ${imageNumber} of ${imageCount}`}
                  loading="lazy"
                  decoding="async"
                />
              </a>
            ) : (
              <span className="message-image" aria-label={`Image ${imageNumber} of ${imageCount}`}>
                <ImageIcon size={15} aria-hidden="true" />
                <span>Image {imageCount > 1 ? imageNumber : "attachment"}</span>
              </span>
            )}
          </div>
        );
      })}
    </article>
  );
}

function AgentMessage({ item }: ItemRendererProps) {
  const text = itemText(item);
  const omitted = omittedCharacters(item, ["text"]);
  return (
    <article className="message message--agent">
      <div className="message-role"><Bot size={14} aria-hidden="true" />Codex</div>
      {text ? <Markdown>{text}</Markdown> : <span className="streaming-placeholder">Thinking</span>}
      <StreamOmission count={omitted} />
    </article>
  );
}

interface ReasoningGroupProps {
  active?: boolean;
  items: CodexItem[];
}

function reasoningContent(item: CodexItem) {
  const summary = textParts(item.summary) || readString(item.summaryText) || "";
  const detail = textParts(item.content) || readString(item.contentText) || readString(item.text) || "";
  const omitted = omittedCharacters(item, ["summary", "content"]);
  return { summary, detail, omitted };
}

export function ReasoningGroup({ active = false, items }: ReasoningGroupProps) {
  const content = items.map(reasoningContent);
  const hasContent = content.some(({ summary, detail, omitted }) => summary || detail || omitted > 0);
  const label = items.length > 1 ? `Reasoning (${items.length})` : "Reasoning";

  if (!hasContent) {
    if (!active) return null;
    return (
      <div className="reasoning-block reasoning-block--status" role="status" aria-label="Reasoning in progress">
        <div className="reasoning-summary">
          <Brain size={15} aria-hidden="true" />
          <span>{label}</span>
          <LoaderCircle size={14} className="reasoning-spinner spin" aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <LazyDetails
      className="reasoning-block"
      summaryClassName="reasoning-summary"
      summary={(
        <>
          <Brain size={15} aria-hidden="true" />
          <span>{label}</span>
          {active && (
            <>
              <span className="sr-only">Reasoning in progress</span>
              <LoaderCircle size={14} className="reasoning-spinner spin" aria-hidden="true" />
            </>
          )}
          <ChevronRight size={14} className="details-chevron" aria-hidden="true" />
        </>
      )}
    >
      <div className="reasoning-content">
        {content.map(({ summary, detail, omitted }, index) => (
          <section className="reasoning-entry" key={items[index].id}>
            {summary && (
              <div className="reasoning-part">
                <div className="reasoning-part-label">Summary</div>
                <Markdown compact>{summary}</Markdown>
              </div>
            )}
            {detail && detail !== summary && (
              <div className="reasoning-part">
                <div className="reasoning-part-label">Details</div>
                <Markdown compact>{detail}</Markdown>
              </div>
            )}
            <StreamOmission count={omitted} />
          </section>
        ))}
      </div>
    </LazyDetails>
  );
}

function CommandExecution({ disclosureOpen, item, onDisclosureOpenChange }: ItemRendererProps) {
  const output = readString(item.aggregatedOutput) ?? readString(item.output) ?? "";
  const command = commandText(item);
  const reasons = approvalReasons(item);
  const failurePreview = failureOutputPreview(item, output);
  return (
    <LazyDetails
      className={`tool-block tool-activity command-block${isFailedToolActivity(item) ? " tool-activity--failed" : ""}`}
      onOpenChange={onDisclosureOpenChange}
      open={disclosureOpen}
      summaryClassName="tool-activity-summary"
      summary={(
        <ToolDisclosureSummary item={item}>
          <span className="tool-activity-icon-copy">
            <Terminal size={15} aria-hidden="true" />
            <span className="tool-activity-copy">
              <span className="tool-activity-title">
                <strong>Command</strong>
                {command && <code className="command-summary">{command}</code>}
              </span>
              {reasons.length > 0 && (
                <span className="tool-reason-preview" title={reasons.join("\n")}>
                  {reasons.join(" / ")}
                </span>
              )}
              {failurePreview && (
                <span className="tool-failure-preview" aria-label="Error output preview">
                  {failurePreview}
                </span>
              )}
            </span>
          </span>
        </ToolDisclosureSummary>
      )}
    >
      <div className="command-details">
        {reasons.length > 0 && (
          <div className="tool-reasons">
            <strong>{reasons.length === 1 ? "Reason" : "Reasons"}</strong>
            <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          </div>
        )}
        {command && <CodeBlock code={command} language="shell" label="Command" maxDisplayCharacters={20_000} />}
        {output && (
          <CodeBlock
            code={stripAnsi(output)}
            label="Output"
            maxDisplayCharacters={TOOL_OUTPUT_MAX_DISPLAY_CHARACTERS}
            truncate="middle"
            tone="terminal"
          />
        )}
        <StreamOmission count={omittedCharacters(item, ["aggregatedOutput", "output"])} />
        <div className="tool-meta">
          {readString(item.cwd) && <span>{readString(item.cwd)}</span>}
          {typeof item.exitCode === "number" && <span>exit {item.exitCode}</span>}
          {typeof item.durationMs === "number" && <span>{(item.durationMs / 1000).toFixed(1)}s</span>}
        </div>
      </div>
    </LazyDetails>
  );
}

function FileChange({ disclosureOpen, item, onDisclosureOpenChange }: ItemRendererProps) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const output = readString(item.output);
  const firstChange = changes.find(isRecord);
  const firstPath = firstChange ? readString(firstChange.path) ?? readString(firstChange.file) : undefined;
  const changeSummary = changes.length > 1 ? `${changes.length} files` : firstPath;
  return (
    <LazyDetails
      className={`tool-block tool-activity file-change-block${isFailedToolActivity(item) ? " tool-activity--failed" : ""}`}
      onOpenChange={onDisclosureOpenChange}
      open={disclosureOpen}
      summaryClassName="tool-activity-summary"
      summary={(
        <ToolDisclosureSummary item={item}>
          <span className="tool-activity-icon-copy">
            <FileCode2 size={15} aria-hidden="true" />
            <span className="tool-activity-title">
              <strong>File changes</strong>
              {changeSummary && <code className="command-summary">{changeSummary}</code>}
            </span>
          </span>
        </ToolDisclosureSummary>
      )}
    >
      <ul className="file-change-list">
        {changes.map((change, index) => {
          if (!isRecord(change)) return null;
          const path = readString(change.path) ?? readString(change.file) ?? "Unknown path";
          const kindRecord = isRecord(change.kind) ? change.kind : undefined;
          const kind = readString(kindRecord?.type) ?? readString(change.kind) ?? readString(change.type) ?? "change";
          const diff = readString(change.diff);
          return (
            <li key={`${path}-${index}`} className="file-change-entry">
              <div className="file-change-path">
                <span className={`change-kind change-kind--${kind.toLowerCase()}`}>{kind.slice(0, 1).toUpperCase()}</span>
                <code>{path}</code>
              </div>
              {diff && (
                <LazyDetails className="inline-details" summary="Diff">
                  <DiffViewer diff={diff} path={path} kind={kind} />
                </LazyDetails>
              )}
            </li>
          );
        })}
      </ul>
      {output && (
        <CodeBlock
          code={stripAnsi(output)}
          label="Output"
          maxDisplayCharacters={TOOL_OUTPUT_MAX_DISPLAY_CHARACTERS}
          tone="terminal"
          truncate="middle"
        />
      )}
      <StreamOmission count={omittedCharacters(item, ["output"])} />
    </LazyDetails>
  );
}

function McpToolCall({ disclosureOpen, item, onDisclosureOpenChange }: ItemRendererProps) {
  const server = readString(item.server) ?? readString(item.serverName) ?? "MCP";
  const tool = readString(item.tool) ?? readString(item.toolName) ?? "tool";
  return (
    <LazyDetails
      className={`tool-block tool-activity mcp-block${isFailedToolActivity(item) ? " tool-activity--failed" : ""}`}
      onOpenChange={onDisclosureOpenChange}
      open={disclosureOpen}
      summaryClassName="tool-activity-summary"
      summary={(
        <ToolDisclosureSummary item={item}>
          <span className="tool-activity-icon-copy">
            <Wrench size={15} aria-hidden="true" />
            <span className="tool-activity-title"><strong>{server} / {tool}</strong></span>
          </span>
        </ToolDisclosureSummary>
      )}
    >
      {item.arguments !== undefined && <JsonBlock value={item.arguments} label="Arguments" />}
      {item.result !== undefined && <JsonBlock value={item.result} label="Result" />}
      {item.error !== undefined && <JsonBlock value={item.error} label="Error" />}
    </LazyDetails>
  );
}

function PlanItem({ item }: ItemRendererProps) {
  const raw = Array.isArray(item.plan) ? item.plan : [];
  const plan: PlanStep[] = raw.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.step !== "string" || typeof entry.status !== "string") return [];
    return [{ step: entry.step, status: entry.status }];
  });
  if (plan.length > 0) return <PlanView plan={{ explanation: readString(item.explanation), plan }} />;
  const text = readString(item.text);
  return text ? (
    <section className="tool-block">
      <Markdown compact>{text}</Markdown>
      <StreamOmission count={omittedCharacters(item, ["text"])} />
    </section>
  ) : null;
}

function WebSearch({ disclosureOpen, item, onDisclosureOpenChange }: ItemRendererProps) {
  const query = readString(item.query) ?? itemText(item);
  return (
    <LazyDetails
      className={`tool-block tool-activity web-search-block${isFailedToolActivity(item) ? " tool-activity--failed" : ""}`}
      onOpenChange={onDisclosureOpenChange}
      open={disclosureOpen}
      summaryClassName="tool-activity-summary"
      summary={(
        <ToolDisclosureSummary item={item}>
          <span className="tool-activity-icon-copy">
            <Globe size={15} aria-hidden="true" />
            <span className="tool-activity-title">
              <strong>Web search</strong>
              <code className="command-summary">{query}</code>
            </span>
          </span>
        </ToolDisclosureSummary>
      )}
    >
      {query && <div className="web-search-query">{query}</div>}
      <StreamOmission count={omittedCharacters(item, ["query", "text"])} />
    </LazyDetails>
  );
}

function UnknownItem({ item }: ItemRendererProps) {
  const text = itemText(item);
  const visible = Object.fromEntries(Object.entries(item).filter(([key]) => !["id", "type"].includes(key)));
  return (
    <LazyDetails
      className="tool-block unknown-block"
      summaryClassName="item-heading"
      summary={(
        <>
          <Braces size={15} aria-hidden="true" />
          <strong>{item.type}</strong>
        </>
      )}
    >
      {text ? <Markdown compact>{text}</Markdown> : <JsonBlock value={visible} />}
    </LazyDetails>
  );
}

export function ItemRenderer(props: ItemRendererProps) {
  const { item } = props;
  switch (item.type) {
    case "userMessage":
      return <UserMessage {...props} />;
    case "agentMessage":
      return <AgentMessage item={item} />;
    case "reasoning":
      return <ReasoningGroup items={[item]} />;
    case "commandExecution":
      return <CommandExecution {...props} />;
    case "fileChange":
      return <FileChange {...props} />;
    case "mcpToolCall":
      return <McpToolCall {...props} />;
    case "plan":
      return <PlanItem item={item} />;
    case "webSearch":
      return <WebSearch {...props} />;
    default:
      if (item.type.toLowerCase().includes("plan")) return <PlanItem item={item} />;
      return <UnknownItem item={item} />;
  }
}
