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
import { Markdown } from "./Markdown";
import { PlanView } from "./PlanView";
import { StatusPill } from "./StatusPill";

interface ItemRendererProps {
  item: CodexItem;
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === undefined || value === null) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <pre className="code-output">{stripAnsi(text)}</pre>;
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
  return (
    <article className="message message--agent">
      <div className="message-role"><Bot size={14} aria-hidden="true" />Codex</div>
      {text ? <Markdown>{text}</Markdown> : <span className="streaming-placeholder">Thinking</span>}
    </article>
  );
}

function Reasoning({ item }: ItemRendererProps) {
  const summary = textParts(item.summary) || readString(item.summaryText) || "";
  const detail = textParts(item.content) || readString(item.contentText) || readString(item.text) || "";
  return (
    <details className="reasoning-block">
      <summary>
        <Brain size={15} aria-hidden="true" />
        <span>Reasoning</span>
        {item.status && <StatusPill status={item.status} />}
        <ChevronRight size={14} className="details-chevron" aria-hidden="true" />
      </summary>
      {summary && <Markdown compact>{summary}</Markdown>}
      {detail && detail !== summary && <Markdown compact>{detail}</Markdown>}
    </details>
  );
}

function CommandExecution({ item }: ItemRendererProps) {
  const output = readString(item.aggregatedOutput) ?? readString(item.output) ?? "";
  return (
    <section className="tool-block command-block">
      <div className="item-heading item-heading--spread">
        <span><Terminal size={15} aria-hidden="true" /><strong>Command</strong></span>
        <StatusPill status={item.status} />
      </div>
      <pre className="command-line"><code>{commandText(item)}</code></pre>
      {output && <pre className="terminal-output">{stripAnsi(output)}</pre>}
      <div className="tool-meta">
        {readString(item.cwd) && <span>{readString(item.cwd)}</span>}
        {typeof item.exitCode === "number" && <span>exit {item.exitCode}</span>}
        {typeof item.durationMs === "number" && <span>{(item.durationMs / 1000).toFixed(1)}s</span>}
      </div>
    </section>
  );
}

function FileChange({ item }: ItemRendererProps) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
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
                <details className="inline-details">
                  <summary>Diff</summary>
                  <pre className="diff-output">{diff}</pre>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function McpToolCall({ item }: ItemRendererProps) {
  const server = readString(item.server) ?? readString(item.serverName) ?? "MCP";
  const tool = readString(item.tool) ?? readString(item.toolName) ?? "tool";
  return (
    <details className="tool-block mcp-block" open={item.status === "inProgress"}>
      <summary className="item-heading item-heading--spread">
        <span><Wrench size={15} aria-hidden="true" /><strong>{server} / {tool}</strong></span>
        <StatusPill status={item.status} />
      </summary>
      {item.arguments !== undefined && <><span className="block-label">Arguments</span><JsonBlock value={item.arguments} /></>}
      {item.result !== undefined && <><span className="block-label">Result</span><JsonBlock value={item.result} /></>}
      {item.error !== undefined && <><span className="block-label block-label--error">Error</span><JsonBlock value={item.error} /></>}
    </details>
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
  return text ? <section className="tool-block"><Markdown compact>{text}</Markdown></section> : null;
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
    <details className="tool-block unknown-block">
      <summary className="item-heading">
        <Braces size={15} aria-hidden="true" />
        <strong>{item.type}</strong>
      </summary>
      {text ? <Markdown compact>{text}</Markdown> : <JsonBlock value={visible} />}
    </details>
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
