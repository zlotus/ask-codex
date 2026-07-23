import { Columns2, Rows3, WrapText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CodeBlock, CopyTextButton } from "./CodeBlock";
import {
  prepareDiff,
  type DiffFileView,
  type DiffLineView,
  type DiffWordSegment,
} from "./diffUtils";

type DiffMode = "unified" | "split";
const COMPACT_DIFF_MEDIA_QUERY = "(max-width: 720px)";

interface DiffViewerProps {
  diff: string;
  path?: string;
  kind?: string;
}

function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(COMPACT_DIFF_MEDIA_QUERY).matches
      : false
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COMPACT_DIFF_MEDIA_QUERY);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

function WordSegments({ segments }: { segments: DiffWordSegment[] }) {
  return segments.map((segment, index) => (
    <span className={segment.changed ? "diff-word-change" : undefined} key={`${index}:${segment.value}`}>
      {segment.value}
    </span>
  ));
}

function LineContent({ line }: { line: DiffLineView }) {
  const accessibleKind = line.kind === "addition"
    ? "Added line: "
    : line.kind === "deletion" ? "Deleted line: " : null;
  return (
    <code>
      {accessibleKind && <span className="sr-only">{accessibleKind}</span>}
      {line.segments ? <WordSegments segments={line.segments} /> : line.content}
    </code>
  );
}

function lineIndicator(line: DiffLineView): string {
  if (line.kind === "addition") return "+";
  if (line.kind === "deletion") return "-";
  return line.kind === "metadata" ? "\\" : " ";
}

function UnifiedFile({ file, showHeader }: { file: DiffFileView; showHeader: boolean }) {
  return (
    <section className="diff-file">
      {showHeader && <div className="diff-file-header"><code>{file.name}</code></div>}
      <table className="diff-table diff-table--unified" aria-label={`Unified diff for ${file.name}`}>
        <tbody>
          {file.hunks.flatMap((hunk, hunkIndex) => [
            <tr className="diff-hunk" key={`hunk:${hunkIndex}`}>
              <td colSpan={3}><code>{hunk.header}</code></td>
            </tr>,
            ...hunk.unifiedLines.map((line, lineIndex) => (
              <tr className={`diff-line diff-line--${line.kind}`} key={`${hunkIndex}:${lineIndex}`}>
                <td className="diff-gutter">{line.oldNumber ?? ""}</td>
                <td className="diff-gutter">{line.newNumber ?? ""}</td>
                <td className="diff-code-cell">
                  <span className="diff-indicator" aria-hidden="true">{lineIndicator(line)}</span>
                  <LineContent line={line} />
                </td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </section>
  );
}

function SplitSide({ line, side }: { line: DiffLineView | null; side: "old" | "new" }) {
  const number = side === "old" ? line?.oldNumber : line?.newNumber;
  return (
    <>
      <td className={`diff-gutter${line ? "" : " diff-gutter--empty"}`}>{number ?? ""}</td>
      <td className={`diff-code-cell diff-code-cell--${line?.kind ?? "empty"}`}>
        {line && (
          <>
            <span className="diff-indicator" aria-hidden="true">{lineIndicator(line)}</span>
            <LineContent line={line} />
          </>
        )}
      </td>
    </>
  );
}

function SplitFile({ file, showHeader }: { file: DiffFileView; showHeader: boolean }) {
  return (
    <section className="diff-file">
      {showHeader && <div className="diff-file-header"><code>{file.name}</code></div>}
      <table className="diff-table diff-table--split" aria-label={`Split diff for ${file.name}`}>
        <tbody>
          {file.hunks.flatMap((hunk, hunkIndex) => [
            <tr className="diff-hunk" key={`hunk:${hunkIndex}`}>
              <td colSpan={4}><code>{hunk.header}</code></td>
            </tr>,
            ...hunk.splitRows.map((row, rowIndex) => row.metadata !== undefined ? (
              <tr className="diff-line diff-line--metadata" key={`${hunkIndex}:${rowIndex}`}>
                <td colSpan={4} className="diff-code-cell">
                  <span className="diff-indicator" aria-hidden="true">\</span>
                  <code>{row.metadata}</code>
                </td>
              </tr>
            ) : (
              <tr className="diff-line" key={`${hunkIndex}:${rowIndex}`}>
                <SplitSide line={row.oldLine} side="old" />
                <SplitSide line={row.newLine} side="new" />
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </section>
  );
}

export function DiffViewer({ diff, path, kind }: DiffViewerProps) {
  const [mode, setMode] = useState<DiffMode>("unified");
  const [wrap, setWrap] = useState(false);
  const compact = useCompactViewport();
  const prepared = useMemo(() => prepareDiff(diff, path, kind), [diff, kind, path]);
  const effectiveMode = compact ? "unified" : mode;

  if (!prepared.patch) {
    return (
      <div className="diff-raw-fallback">
        <CodeBlock
          code={diff}
          language="diff"
          label={prepared.fallback === "large" ? "Large diff" : "Raw diff"}
          maxDisplayCharacters={140_000}
          truncate="middle"
        />
      </div>
    );
  }

  const showFileHeaders = !path || prepared.files.length > 1;
  return (
    <section className={`diff-viewer${wrap ? " diff-viewer--wrap" : ""}`}>
      <header className="diff-viewer-toolbar">
        <div className="diff-stats" aria-label={`${prepared.additions} additions and ${prepared.deletions} deletions`}>
          <span className="diff-stat diff-stat--add">+{prepared.additions}</span>
          <span className="diff-stat diff-stat--delete">-{prepared.deletions}</span>
        </div>
        <div className="diff-viewer-actions">
          <div className="segmented-icons" role="group" aria-label="Diff layout">
            <button
              type="button"
              className={effectiveMode === "unified" ? "is-active" : ""}
              aria-label="Unified diff"
              aria-pressed={effectiveMode === "unified"}
              title="Unified diff"
              onClick={() => setMode("unified")}
            >
              <Rows3 size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`diff-split-action${effectiveMode === "split" ? " is-active" : ""}`}
              aria-label="Split diff"
              aria-pressed={effectiveMode === "split"}
              title="Split diff"
              hidden={compact}
              onClick={() => setMode("split")}
            >
              <Columns2 size={14} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className={`code-action${wrap ? " code-action--active" : ""}`}
            aria-label={wrap ? "Disable line wrapping" : "Wrap diff lines"}
            aria-pressed={wrap}
            title={wrap ? "Disable line wrapping" : "Wrap diff lines"}
            onClick={() => setWrap((current) => !current)}
          >
            <WrapText size={14} aria-hidden="true" />
          </button>
          <CopyTextButton text={diff} label="Copy diff" />
        </div>
      </header>
      <div className="diff-render-surface">
        {prepared.files.map((file, index) => effectiveMode === "split" ? (
          <SplitFile file={file} showHeader={showFileHeaders} key={`${file.name}:${index}`} />
        ) : (
          <UnifiedFile file={file} showHeader={showFileHeaders} key={`${file.name}:${index}`} />
        ))}
      </div>
    </section>
  );
}
