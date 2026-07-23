import {
  Bot,
  Brain,
  Braces,
  ChevronRight,
  FileCode2,
  Globe,
  Terminal,
  User,
  Wrench,
} from "lucide-react";
import type { CodexItem, PlanStep } from "../types/protocol";
import {
  commandText,
  isRecord,
  itemText,
  readString,
  stripAnsi,
  textParts,
} from "../utils/protocol";
import { CodeBlock } from "./CodeBlock";
import { DiffViewer } from "./DiffViewer";
import { LazyDetails } from "./LazyDetails";
import { Markdown } from "./Markdown";
import { PlanView } from "./PlanView";
import { StatusPill } from "./StatusPill";

interface ItemRendererProps {
  item: CodexItem;
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
  return <CodeBlock code={stripAnsi(text)} language="json" label={label} maxDisplayCharacters={100_000} />;
}

function UserMessage({ item }: ItemRendererProps) {
  return (
    <article className="message message--user">
      <div className="message-role"><User size={14} aria-hidden="true" />You</div>
      <Markdown>{itemText(item)}</Markdown>
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

function Reasoning({ item }: ItemRendererProps) {
  const summary = textParts(item.summary) || readString(item.summaryText) || "";
  const detail = textParts(item.content) || readString(item.contentText) || readString(item.text) || "";
  return (
    <LazyDetails
      className="reasoning-block"
      summary={(
        <>
          <Brain size={15} aria-hidden="true" />
          <span>Reasoning</span>
          {item.status && <StatusPill status={item.status} />}
          <ChevronRight size={14} className="details-chevron" aria-hidden="true" />
        </>
      )}
    >
      {summary && <Markdown compact>{summary}</Markdown>}
      {detail && detail !== summary && <Markdown compact>{detail}</Markdown>}
      <StreamOmission count={omittedCharacters(item, ["summary", "content"])} />
    </LazyDetails>
  );
}

function CommandExecution({ item }: ItemRendererProps) {
  const output = readString(item.aggregatedOutput) ?? readString(item.output) ?? "";
  const command = commandText(item);
  return (
    <LazyDetails
      className="tool-block command-block"
      initiallyOpen={item.status === "inProgress"}
      summaryClassName="item-heading item-heading--spread"
      summary={(
        <>
          <span>
            <Terminal size={15} aria-hidden="true" />
            <strong>Command</strong>
            {command && <code className="command-summary">{command}</code>}
          </span>
          <StatusPill status={item.status} />
        </>
      )}
    >
      <div className="command-details">
        {command && <CodeBlock code={command} language="shell" label="Command" maxDisplayCharacters={20_000} />}
        {output && (
          <CodeBlock
            code={stripAnsi(output)}
            label="Output"
            maxDisplayCharacters={160_000}
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

function FileChange({ item }: ItemRendererProps) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const output = readString(item.output);
  return (
    <section className="tool-block">
      <div className="item-heading item-heading--spread">
        <span><FileCode2 size={15} aria-hidden="true" /><strong>File changes</strong></span>
        <StatusPill status={item.status} />
      </div>
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
      {output && <CodeBlock code={stripAnsi(output)} label="Output" tone="terminal" truncate="middle" />}
      <StreamOmission count={omittedCharacters(item, ["output"])} />
    </section>
  );
}

function McpToolCall({ item }: ItemRendererProps) {
  const server = readString(item.server) ?? readString(item.serverName) ?? "MCP";
  const tool = readString(item.tool) ?? readString(item.toolName) ?? "tool";
  return (
    <LazyDetails
      className="tool-block mcp-block"
      initiallyOpen={item.status === "inProgress"}
      summaryClassName="item-heading item-heading--spread"
      summary={(
        <>
          <span><Wrench size={15} aria-hidden="true" /><strong>{server} / {tool}</strong></span>
          <StatusPill status={item.status} />
        </>
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

function WebSearch({ item }: ItemRendererProps) {
  const query = readString(item.query) ?? itemText(item);
  return (
    <section className="activity-row">
      <Globe size={15} aria-hidden="true" />
      <span>Web search</span>
      <code>{query}</code>
      <StatusPill status={item.status} />
    </section>
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

export function ItemRenderer({ item }: ItemRendererProps) {
  switch (item.type) {
    case "userMessage":
      return <UserMessage item={item} />;
    case "agentMessage":
      return <AgentMessage item={item} />;
    case "reasoning":
      return <Reasoning item={item} />;
    case "commandExecution":
      return <CommandExecution item={item} />;
    case "fileChange":
      return <FileChange item={item} />;
    case "mcpToolCall":
      return <McpToolCall item={item} />;
    case "plan":
      return <PlanItem item={item} />;
    case "webSearch":
      return <WebSearch item={item} />;
    default:
      if (item.type.toLowerCase().includes("plan")) return <PlanItem item={item} />;
      return <UnknownItem item={item} />;
  }
}
