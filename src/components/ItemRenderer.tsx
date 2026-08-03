import {
  Bot,
  Brain,
  Braces,
  ChevronRight,
  Clock3,
  FileCode2,
  Globe,
  Image as ImageIcon,
  ImagePlus,
  MessagesSquare,
  Minimize2,
  ScanEye,
  Sparkles,
  Terminal,
  User,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  CodexItem,
  FileDownloadCapability,
  FileDownloadHandler,
  PlanStep,
} from "../types/protocol";
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
import { displayToolStatus, hasVisibleReasoning, isFailedToolActivity } from "./activityUtils";

const TOOL_OUTPUT_MAX_DISPLAY_CHARACTERS = 24_000;
const FAILURE_PREVIEW_MAX_CHARACTERS = 360;
const FAILURE_PREVIEW_MAX_LINES = 3;
const FILE_DOWNLOAD_CAPABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

interface ItemRendererProps {
  disclosureOpen?: boolean;
  imagePreviewUrls?: readonly string[];
  item: CodexItem;
  onDownloadFile?: FileDownloadHandler;
  onDisclosureOpenChange?: (open: boolean) => void;
}

function fileDownloadCapabilities(item: CodexItem): FileDownloadCapability[] {
  const candidates: unknown = item.askCodexFileDownloads;
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((candidate): candidate is FileDownloadCapability => (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as Record<string, unknown>).href === "string" &&
    typeof (candidate as Record<string, unknown>).capabilityId === "string" &&
    Boolean((candidate as Record<string, unknown>).href) &&
    FILE_DOWNLOAD_CAPABILITY_ID_PATTERN.test((candidate as Record<string, unknown>).capabilityId as string)
  ));
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

function ToolActivityTitle({
  children,
  detail,
  icon,
}: {
  children: ReactNode;
  detail?: string;
  icon: ReactNode;
}) {
  return (
    <span className="tool-activity-icon-copy">
      {icon}
      <span className="tool-activity-title">
        <strong>{children}</strong>
        {detail && <span className="command-summary">{detail}</span>}
      </span>
    </span>
  );
}

function StaticToolActivity({
  detail,
  icon,
  item,
  title,
}: {
  detail?: string;
  icon: ReactNode;
  item: CodexItem;
  title: string;
}) {
  const status = displayToolStatus(item);
  return (
    <div className={`tool-block tool-activity tool-activity-static${isFailedToolActivity(item) ? " tool-activity--failed" : ""}`}>
      <div className="tool-activity-summary">
        <span className="tool-activity-main">
          <ToolActivityTitle detail={detail} icon={icon}>{title}</ToolActivityTitle>
        </span>
        {status && <span className="tool-activity-state"><StatusPill status={status} /></span>}
      </div>
    </div>
  );
}

function ExpandableToolActivity({
  children,
  className,
  detail,
  disclosureOpen,
  icon,
  item,
  onDisclosureOpenChange,
  title,
}: ItemRendererProps & {
  children: ReactNode;
  className: string;
  detail?: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <LazyDetails
      className={`tool-block tool-activity ${className}${isFailedToolActivity(item) ? " tool-activity--failed" : ""}`}
      onOpenChange={onDisclosureOpenChange}
      open={disclosureOpen}
      summaryClassName="tool-activity-summary"
      summary={(
        <ToolDisclosureSummary item={item}>
          <ToolActivityTitle detail={detail} icon={icon}>{title}</ToolActivityTitle>
        </ToolDisclosureSummary>
      )}
    >
      {children}
    </LazyDetails>
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

function AgentMessage({ item, onDownloadFile }: ItemRendererProps) {
  const text = itemText(item);
  const omitted = omittedCharacters(item, ["text"]);
  return (
    <article className="message message--agent">
      <div className="message-role"><Bot size={14} aria-hidden="true" />Codex</div>
      {text ? (
        <Markdown
          fileDownloads={fileDownloadCapabilities(item)}
          onDownloadFile={onDownloadFile}
        >
          {text}
        </Markdown>
      ) : <span className="streaming-placeholder">Thinking</span>}
      <StreamOmission count={omitted} />
    </article>
  );
}

interface ReasoningGroupProps {
  items: CodexItem[];
}

function reasoningContent(item: CodexItem) {
  const summary = textParts(item.summary) || readString(item.summaryText) || "";
  const detail = textParts(item.content) || readString(item.contentText) || readString(item.text) || "";
  const omitted = omittedCharacters(item, ["summary", "content"]);
  return { summary, detail, omitted };
}

export function ReasoningGroup({ items }: ReasoningGroupProps) {
  const content = items.map(reasoningContent);
  const label = items.length > 1 ? `Reasoning (${items.length})` : "Reasoning";

  if (!hasVisibleReasoning(items)) return null;

  return (
    <LazyDetails
      className="reasoning-block"
      summaryClassName="reasoning-summary"
      summary={(
        <>
          <Brain size={15} aria-hidden="true" />
          <span>{label}</span>
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

function DynamicToolCall(props: ItemRendererProps) {
  const { item } = props;
  const namespace = readString(item.namespace);
  const tool = readString(item.tool) ?? "tool";
  const title = namespace ? `${namespace} / ${tool}` : tool;
  const contentItems = Array.isArray(item.contentItems) ? item.contentItems.filter(isRecord) : [];
  const textOutputs = contentItems.flatMap((entry) => {
    if (entry.type !== "inputText") return [];
    const text = readString(entry.text);
    return text ? [text] : [];
  });
  const imageCount = contentItems.filter((entry) => entry.type === "inputImage").length;
  const audioCount = contentItems.filter((entry) => entry.type === "inputAudio").length;
  return (
    <ExpandableToolActivity
      {...props}
      className="dynamic-tool-block"
      icon={<Sparkles size={15} aria-hidden="true" />}
      title={title}
    >
      <div className="tool-activity-details">
        {item.arguments !== undefined && <JsonBlock value={item.arguments} label="Arguments" />}
        {textOutputs.map((text, index) => (
          <CodeBlock
            code={stripAnsi(text)}
            key={`${item.id}:output:${index}`}
            label={textOutputs.length > 1 ? `Output ${index + 1}` : "Output"}
            maxDisplayCharacters={TOOL_OUTPUT_MAX_DISPLAY_CHARACTERS}
            truncate="middle"
          />
        ))}
        {(imageCount > 0 || audioCount > 0) && (
          <div className="tool-output-summary">
            {imageCount > 0 && <span><ImageIcon size={14} aria-hidden="true" />{imageCount} image output{imageCount === 1 ? "" : "s"}</span>}
            {audioCount > 0 && <span>{audioCount} audio output{audioCount === 1 ? "" : "s"}</span>}
          </div>
        )}
      </div>
    </ExpandableToolActivity>
  );
}

const COLLAB_TOOL_LABELS: Record<string, string> = {
  spawnAgent: "Spawn agent",
  sendInput: "Send agent input",
  resumeAgent: "Resume agent",
  wait: "Wait for agents",
  closeAgent: "Close agent",
};

function CollabAgentToolCall(props: ItemRendererProps) {
  const { item } = props;
  const tool = readString(item.tool) ?? "Agent call";
  const prompt = readString(item.prompt);
  const model = readString(item.model);
  const effort = readString(item.reasoningEffort);
  const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : 0;
  const states = isRecord(item.agentsStates)
    ? Object.values(item.agentsStates).filter(isRecord)
    : [];
  const stateCounts: Record<string, number> = {};
  for (const state of states) {
    const status = readString(state.status);
    if (status) stateCounts[status] = (stateCounts[status] ?? 0) + 1;
  }
  const details = [
    receivers > 0 ? `${receivers} agent${receivers === 1 ? "" : "s"}` : null,
    model,
    effort,
  ].filter((value): value is string => Boolean(value));
  return (
    <ExpandableToolActivity
      {...props}
      className="collab-agent-block"
      detail={details.join(" / ") || undefined}
      icon={<Users size={15} aria-hidden="true" />}
      title={COLLAB_TOOL_LABELS[tool] ?? "Agent call"}
    >
      <div className="tool-activity-details">
        {prompt && <CodeBlock code={prompt} label="Prompt" maxDisplayCharacters={20_000} truncate="middle" />}
        {Object.keys(stateCounts).length > 0 && (
          <div className="tool-output-summary" aria-label="Agent states">
            {Object.entries(stateCounts).map(([status, count]) => (
              <span key={status}>{count} {status}</span>
            ))}
          </div>
        )}
      </div>
    </ExpandableToolActivity>
  );
}

function SubAgentActivity({ item }: ItemRendererProps) {
  const kind = readString(item.kind);
  const labels: Record<string, string> = {
    started: "Agent started",
    interacted: "Agent activity",
    interrupted: "Agent interrupted",
  };
  return (
    <StaticToolActivity
      icon={<MessagesSquare size={15} aria-hidden="true" />}
      item={item}
      title={kind ? labels[kind] ?? "Agent activity" : "Agent activity"}
    />
  );
}

function ImageView({ item }: ItemRendererProps) {
  return (
    <StaticToolActivity
      icon={<ScanEye size={15} aria-hidden="true" />}
      item={item}
      title="Viewed image"
    />
  );
}

function Sleep({ item }: ItemRendererProps) {
  const durationMs = typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0
    ? item.durationMs
    : null;
  const duration = durationMs === null
    ? undefined
    : durationMs >= 1_000
      ? `${(durationMs / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}s`
      : `${Math.round(durationMs)}ms`;
  return (
    <StaticToolActivity
      detail={duration}
      icon={<Clock3 size={15} aria-hidden="true" />}
      item={item}
      title="Waited"
    />
  );
}

function ImageGeneration(props: ItemRendererProps) {
  const { item } = props;
  const prompt = readString(item.revisedPrompt);
  const hasResult = Boolean(readString(item.result));
  if (!prompt && !hasResult) {
    return (
      <StaticToolActivity
        icon={<ImagePlus size={15} aria-hidden="true" />}
        item={item}
        title="Image generation"
      />
    );
  }
  return (
    <ExpandableToolActivity
      {...props}
      className="image-generation-block"
      detail={hasResult ? "result available" : undefined}
      icon={<ImagePlus size={15} aria-hidden="true" />}
      title="Image generation"
    >
      <div className="tool-activity-details">
        {prompt && <CodeBlock code={prompt} label="Revised prompt" maxDisplayCharacters={20_000} truncate="middle" />}
        {hasResult && <div className="tool-output-summary"><span><ImageIcon size={14} aria-hidden="true" />Image result available</span></div>}
      </div>
    </ExpandableToolActivity>
  );
}

function ReviewMode(props: ItemRendererProps) {
  const { item } = props;
  const entered = item.type === "enteredReviewMode";
  const review = readString(item.review);
  const title = entered ? "Review started" : "Review completed";
  if (!review) {
    return <StaticToolActivity icon={<ScanEye size={15} aria-hidden="true" />} item={item} title={title} />;
  }
  return (
    <ExpandableToolActivity
      {...props}
      className="review-activity-block"
      icon={<ScanEye size={15} aria-hidden="true" />}
      title={title}
    >
      <div className="tool-activity-details"><Markdown compact>{review}</Markdown></div>
    </ExpandableToolActivity>
  );
}

function HookPrompt(props: ItemRendererProps) {
  const { item } = props;
  const fragments = Array.isArray(item.fragments) ? item.fragments.filter(isRecord) : [];
  const text = fragments.flatMap((fragment) => {
    const value = readString(fragment.text);
    return value ? [value] : [];
  }).join("\n\n");
  if (!text) {
    return <StaticToolActivity icon={<Workflow size={15} aria-hidden="true" />} item={item} title="Hook prompt" />;
  }
  return (
    <ExpandableToolActivity
      {...props}
      className="hook-prompt-block"
      icon={<Workflow size={15} aria-hidden="true" />}
      title="Hook prompt"
    >
      <div className="tool-activity-details"><Markdown compact>{text}</Markdown></div>
    </ExpandableToolActivity>
  );
}

function ContextCompaction({ item }: ItemRendererProps) {
  return (
    <StaticToolActivity
      icon={<Minimize2 size={15} aria-hidden="true" />}
      item={item}
      title="Context compacted"
    />
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
      return <AgentMessage {...props} />;
    case "reasoning":
      return <ReasoningGroup items={[item]} />;
    case "commandExecution":
      return <CommandExecution {...props} />;
    case "fileChange":
      return <FileChange {...props} />;
    case "mcpToolCall":
      return <McpToolCall {...props} />;
    case "dynamicToolCall":
      return <DynamicToolCall {...props} />;
    case "collabAgentToolCall":
      return <CollabAgentToolCall {...props} />;
    case "subAgentActivity":
      return <SubAgentActivity item={item} />;
    case "plan":
      return <PlanItem item={item} />;
    case "webSearch":
      return <WebSearch {...props} />;
    case "imageView":
      return <ImageView item={item} />;
    case "sleep":
      return <Sleep item={item} />;
    case "imageGeneration":
      return <ImageGeneration {...props} />;
    case "enteredReviewMode":
    case "exitedReviewMode":
      return <ReviewMode {...props} />;
    case "hookPrompt":
      return <HookPrompt {...props} />;
    case "contextCompaction":
      return <ContextCompaction item={item} />;
    default:
      if (item.type.toLowerCase().includes("plan")) return <PlanItem item={item} />;
      return <UnknownItem item={item} />;
  }
}
