import { Check, Download, LoaderCircle, X } from "lucide-react";
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useEffect,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { Root } from "mdast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import type { FileDownloadCapability, FileDownloadHandler } from "../types/protocol";
import { errorMessage } from "../utils/protocol";
import { CodeBlock } from "./CodeBlock";

interface MarkdownProps {
  children: string;
  compact?: boolean;
  fileDownloads?: readonly FileDownloadCapability[];
  maxCharacters?: number;
  onDownloadFile?: FileDownloadHandler;
}

const DEFAULT_MARKDOWN_CHARACTERS = 240_000;
const COMPACT_MARKDOWN_CHARACTERS = 120_000;
const MAX_MARKDOWN_NODES = 2_000;
const DOWNLOAD_ERROR_CHARACTERS = 300;
const DOWNLOAD_LABEL_CHARACTERS = 120;
const DOWNLOAD_STARTED_FEEDBACK_MS = 2_000;
const MAX_DOWNLOAD_STATES = 32;
const FILE_DOWNLOAD_CAPABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const ORIGINAL_LINK_HREF_PROPERTY = "data-ask-codex-original-href";
const LOCATION_SUFFIX_PATTERN = /^(.*?):[1-9]\d{0,8}(?::[1-9]\d{0,8})?$/;
const MARKDOWN_COMPLEXITY_NOTICE = "Additional Markdown omitted because it exceeds the rendering complexity limit.";

type FileDownloadState = "idle" | "downloading" | "started" | "consumed";

interface FileDownloadProgress {
  state: FileDownloadState;
  error: string;
}

interface FileDownloadContextValue {
  downloadsByHref: ReadonlyMap<string, FileDownloadCapability>;
  downloadStates: ReadonlyMap<string, FileDownloadProgress>;
  downloadFile?: (capability: FileDownloadCapability) => Promise<void>;
}

const FileDownloadContext = createContext<FileDownloadContextValue>({
  downloadsByHref: new Map(),
  downloadStates: new Map(),
});

interface MutableMarkdownNode {
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MutableMarkdownNode[];
  identifier?: string;
  type?: string;
  url?: string;
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

const remarkPreserveLinkHrefs: Plugin<[], Root> = () => (tree) => {
  const root = tree as unknown as MutableMarkdownNode;
  const definitions = new Map<string, string>();
  const visit = (callback: (node: MutableMarkdownNode) => void) => {
    const pending = [root];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) continue;
      callback(node);
      if (node.children) {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          pending.push(node.children[index]);
        }
      }
    }
  };

  visit((node) => {
    if (
      node.type === "definition" &&
      node.identifier &&
      typeof node.url === "string" &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node.url);
    }
  });
  visit((node) => {
    const href = node.type === "link" && typeof node.url === "string"
      ? node.url
      : node.type === "linkReference" && node.identifier
        ? definitions.get(node.identifier)
        : undefined;
    if (href === undefined) return;
    const data = node.data ?? (node.data = {});
    data.hProperties = {
      ...data.hProperties,
      [ORIGINAL_LINK_HREF_PROPERTY]: href,
    };
  });
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

function isAbsoluteLocalFileHref(href: string): boolean {
  return (href.startsWith("/") && !href.startsWith("//")) || /^[A-Za-z]:[\\/]/.test(href);
}

function downloadCapabilitiesByHref(
  capabilities: readonly FileDownloadCapability[],
): ReadonlyMap<string, FileDownloadCapability> {
  const unique = new Map<string, FileDownloadCapability>();
  const duplicates = new Set<string>();
  for (const capability of capabilities) {
    if (
      !capability ||
      typeof capability.href !== "string" ||
      typeof capability.capabilityId !== "string" ||
      !FILE_DOWNLOAD_CAPABILITY_ID_PATTERN.test(capability.capabilityId) ||
      !isAbsoluteLocalFileHref(capability.href)
    ) {
      continue;
    }
    if (unique.has(capability.href)) {
      unique.delete(capability.href);
      duplicates.add(capability.href);
    } else if (!duplicates.has(capability.href)) {
      unique.set(capability.href, capability);
    }
  }
  return unique;
}

function boundedDownloadText(value: string, fallback: string): string {
  const safeCharacters: string[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe = codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    safeCharacters.push(unsafe ? " " : character);
  }
  const normalized = safeCharacters.join("")
    .replace(/\s+/g, " ")
    .trim() || fallback;
  if (normalized.length <= DOWNLOAD_LABEL_CHARACTERS) return normalized;
  return `${normalized.slice(0, DOWNLOAD_LABEL_CHARACTERS - 3)}...`;
}

function downloadTargetName(href: string): string {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // A malformed display value still gets a bounded, inert fallback label.
  }
  const path = LOCATION_SUFFIX_PATTERN.exec(decoded)?.[1] ?? decoded;
  const leaf = path.split(/[\\/]/).at(-1) ?? "";
  return boundedDownloadText(leaf, "file");
}

function withDownloadProgress(
  current: ReadonlyMap<string, FileDownloadProgress>,
  capabilityId: string,
  progress: FileDownloadProgress,
): Map<string, FileDownloadProgress> {
  const next = new Map(current);
  next.delete(capabilityId);
  next.set(capabilityId, progress);
  while (next.size > MAX_DOWNLOAD_STATES) {
    const oldest = next.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function FileDownloadLink({
  capability,
  children,
}: {
  capability: FileDownloadCapability;
  children: ReactNode;
}) {
  const { downloadFile, downloadStates } = useContext(FileDownloadContext);
  const progress = downloadStates.get(capability.capabilityId);
  const state = progress?.state ?? "idle";
  const error = progress?.error ?? "";
  const [confirming, setConfirming] = useState(false);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const downloadButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const feedbackId = useId();
  const targetName = downloadTargetName(capability.href);
  const downloaded = state === "started" || state === "consumed";
  const feedback = error || (
    state === "downloading" ? "Downloading" : state === "started" ? "Download started" : ""
  );
  const showingConfirmation = confirming && state === "idle";

  useEffect(() => {
    if (showingConfirmation) {
      confirmButtonRef.current?.focus();
    } else if (restoreFocusRef.current) {
      downloadButtonRef.current?.focus();
      if (state !== "downloading") restoreFocusRef.current = false;
    }
  }, [showingConfirmation, state]);

  const download = async () => {
    if (!downloadFile || state !== "idle") return;
    restoreFocusRef.current = true;
    setConfirming(false);
    await downloadFile(capability);
  };

  return (
    <span className="markdown-file-download">
      <button
        ref={downloadButtonRef}
        className={`markdown-file-download__button${showingConfirmation ? " markdown-file-download__control--concealed" : ""}${downloaded ? " markdown-file-download__button--downloaded" : ""}`}
        type="button"
        aria-busy={state === "downloading" ? true : undefined}
        aria-disabled={state === "downloading" || downloaded ? true : undefined}
        aria-hidden={showingConfirmation}
        aria-describedby={feedback ? feedbackId : undefined}
        aria-label={
          state === "downloading"
            ? `Downloading ${targetName}`
            : state === "started"
              ? `Download started ${targetName}`
              : state === "consumed"
                ? `Download already started ${targetName}`
                : `Download ${targetName}`
        }
        tabIndex={showingConfirmation ? -1 : undefined}
        title={
          state === "started"
            ? `Download started ${targetName}`
            : state === "consumed"
              ? `Download already started ${targetName}`
              : `Download ${targetName}`
        }
        onClick={() => {
          if (state !== "idle") return;
          setConfirming(true);
        }}
      >
        {downloaded
          ? <Check size={14} aria-hidden="true" />
          : state === "downloading"
          ? <LoaderCircle className="spin" size={14} aria-hidden="true" />
          : <Download size={14} aria-hidden="true" />}
        <span className="markdown-file-download__label">
          {state === "started" ? "Download started" : children}
        </span>
      </button>
      <span
        className={`markdown-file-download__confirm${showingConfirmation ? "" : " markdown-file-download__control--concealed"}`}
        role="group"
        aria-hidden={!showingConfirmation}
        aria-label={`Confirm download ${targetName}`}
      >
        <span className="markdown-file-download__prompt">Download {targetName}?</span>
        <button
          ref={confirmButtonRef}
          className="markdown-file-download__confirm-button markdown-file-download__confirm-button--accept"
          type="button"
          aria-label={`Confirm download ${targetName}`}
          tabIndex={showingConfirmation ? undefined : -1}
          title={`Confirm download ${targetName}`}
          onClick={() => void download()}
        >
          <Check size={14} aria-hidden="true" />
        </button>
        <button
          className="markdown-file-download__confirm-button"
          type="button"
          aria-label={`Cancel download ${targetName}`}
          tabIndex={showingConfirmation ? undefined : -1}
          title={`Cancel download ${targetName}`}
          onClick={() => {
            restoreFocusRef.current = true;
            setConfirming(false);
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </span>
      {feedback && (
        <span
          className={`markdown-file-download__feedback${error ? " markdown-file-download__feedback--error" : ""}`}
          id={feedbackId}
          role={error ? "alert" : "status"}
        >
          {feedback}
        </span>
      )}
    </span>
  );
}

type MarkdownLinkProps = ComponentPropsWithoutRef<"a"> &
  Partial<Record<typeof ORIGINAL_LINK_HREF_PROPERTY, string>>;

function MarkdownLink(props: MarkdownLinkProps) {
  const { children: label, href, title } = props;
  const originalHref = props[ORIGINAL_LINK_HREF_PROPERTY];
  const { downloadsByHref, downloadFile } = useContext(FileDownloadContext);
  if (originalHref && isAbsoluteLocalFileHref(originalHref)) {
    const download = downloadsByHref.get(originalHref);
    return download && downloadFile ? (
      <FileDownloadLink
        key={download.capabilityId}
        capability={download}
      >
        {label}
      </FileDownloadLink>
    ) : <span className="markdown-local-file-reference">{label}</span>;
  }
  return href ? (
    <a href={href} title={title} target="_blank" rel="noreferrer">{label}</a>
  ) : <span>{label}</span>;
}

export function Markdown({
  children,
  compact = false,
  fileDownloads = [],
  maxCharacters,
  onDownloadFile,
}: MarkdownProps) {
  const maximum = maxCharacters ?? (compact ? COMPACT_MARKDOWN_CHARACTERS : DEFAULT_MARKDOWN_CHARACTERS);
  const displayed = children.length > maximum ? children.slice(0, maximum) : children;
  const omitted = children.length - displayed.length;
  const downloadsByHref = useMemo(
    () => downloadCapabilitiesByHref(fileDownloads),
    [fileDownloads],
  );
  const [downloadStates, setDownloadStates] = useState(
    () => new Map<string, FileDownloadProgress>(),
  );
  const inFlightDownloadsRef = useRef(new Set<string>());
  const downloadFeedbackTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const timers = downloadFeedbackTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const downloadFile = useCallback(async (capability: FileDownloadCapability): Promise<void> => {
    if (!onDownloadFile || inFlightDownloadsRef.current.has(capability.capabilityId)) return;
    const previousTimer = downloadFeedbackTimersRef.current.get(capability.capabilityId);
    if (previousTimer !== undefined) {
      clearTimeout(previousTimer);
      downloadFeedbackTimersRef.current.delete(capability.capabilityId);
    }
    inFlightDownloadsRef.current.add(capability.capabilityId);
    setDownloadStates((current) => withDownloadProgress(
      current,
      capability.capabilityId,
      { state: "downloading", error: "" },
    ));
    try {
      await onDownloadFile(capability);
      if (!mountedRef.current) return;
      setDownloadStates((current) => withDownloadProgress(
        current,
        capability.capabilityId,
        { state: "started", error: "" },
      ));
      const timer = setTimeout(() => {
        downloadFeedbackTimersRef.current.delete(capability.capabilityId);
        setDownloadStates((current) => {
          if (current.get(capability.capabilityId)?.state !== "started") return current;
          return withDownloadProgress(
            current,
            capability.capabilityId,
            { state: "consumed", error: "" },
          );
        });
      }, DOWNLOAD_STARTED_FEEDBACK_MS);
      downloadFeedbackTimersRef.current.set(capability.capabilityId, timer);
    } catch (cause) {
      if (!mountedRef.current) return;
      const message = errorMessage(cause).trim() || "Unknown error";
      setDownloadStates((current) => withDownloadProgress(
        current,
        capability.capabilityId,
        {
          state: "idle",
          error: `Download failed: ${message.slice(0, DOWNLOAD_ERROR_CHARACTERS)}`,
        },
      ));
    } finally {
      inFlightDownloadsRef.current.delete(capability.capabilityId);
    }
  }, [onDownloadFile]);
  return (
    <div className={compact ? "markdown markdown--compact" : "markdown"}>
      <FileDownloadContext.Provider value={{
        downloadsByHref,
        downloadStates,
        ...(onDownloadFile ? { downloadFile } : {}),
      }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkLimitNodes, remarkPreserveLinkHrefs]}
          components={{
            a: MarkdownLink,
            pre: MarkdownPre,
          }}
        >
          {displayed}
        </ReactMarkdown>
      </FileDownloadContext.Provider>
      {omitted > 0 && (
        <div className="content-omission" role="status">
          {omitted.toLocaleString()} characters omitted from display
        </div>
      )}
    </div>
  );
}
