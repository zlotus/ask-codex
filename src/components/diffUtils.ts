import { diffWordsWithSpace, parsePatch } from "diff";

const MAX_STRUCTURED_DIFF_CHARACTERS = 300_000;
const MAX_STRUCTURED_DIFF_LINES = 2_500;
const MAX_WORD_DIFF_LINE_CHARACTERS = 1_000;
const MAX_WORD_DIFF_PAIRS = 120;

export type DiffLineKind = "context" | "addition" | "deletion" | "metadata";

export interface DiffWordSegment {
  value: string;
  changed: boolean;
}

export interface DiffLineView {
  kind: DiffLineKind;
  content: string;
  oldNumber: number | null;
  newNumber: number | null;
  segments?: DiffWordSegment[];
}

export interface SplitDiffRow {
  oldLine: DiffLineView | null;
  newLine: DiffLineView | null;
  metadata?: string;
}

export interface DiffHunkView {
  header: string;
  unifiedLines: DiffLineView[];
  splitRows: SplitDiffRow[];
}

export interface DiffFileView {
  name: string;
  hunks: DiffHunkView[];
}

export interface PreparedDiff {
  patch: string | null;
  files: DiffFileView[];
  additions: number;
  deletions: number;
  fallback: "large" | "invalid" | "unsupported" | null;
}

function safePath(path?: string): string {
  const cleaned = path?.replace(/[\r\n\t]/g, "_").trim();
  return cleaned || "change.txt";
}

function completePatch(diff: string, path?: string, kind?: string): string {
  if (/^(?:diff --git |Index: |--- )/m.test(diff)) return diff;
  if (!/^@@ /m.test(diff)) return diff;

  const name = safePath(path);
  const normalizedKind = kind?.toLowerCase();
  const oldPath = normalizedKind === "add" || normalizedKind === "added" || normalizedKind === "create"
    ? "/dev/null"
    : `a/${name}`;
  const newPath = normalizedKind === "delete" || normalizedKind === "deleted"
    ? "/dev/null"
    : `b/${name}`;
  return `diff --git a/${name} b/${name}\n--- ${oldPath}\n+++ ${newPath}\n${diff}`;
}

function displayPath(oldName: string | undefined, newName: string | undefined, fallback?: string): string {
  const candidate = newName && newName !== "/dev/null"
    ? newName
    : oldName && oldName !== "/dev/null" ? oldName : fallback;
  return safePath(candidate?.replace(/^[ab]\//, ""));
}

function wordSegments(
  oldText: string,
  newText: string,
  budget: { remaining: number },
): { oldSegments: DiffWordSegment[]; newSegments: DiffWordSegment[] } | null {
  if (
    budget.remaining <= 0 ||
    oldText.length > MAX_WORD_DIFF_LINE_CHARACTERS ||
    newText.length > MAX_WORD_DIFF_LINE_CHARACTERS ||
    oldText.length * newText.length > 250_000
  ) {
    return null;
  }
  budget.remaining -= 1;
  const changes = diffWordsWithSpace(oldText, newText, { timeout: 5 });
  if (!changes) return null;
  return {
    oldSegments: changes
      .filter((change) => !change.added)
      .map((change) => ({ value: change.value, changed: change.removed })),
    newSegments: changes
      .filter((change) => !change.removed)
      .map((change) => ({ value: change.value, changed: change.added })),
  };
}

type ParsedHunk = ReturnType<typeof parsePatch>[number]["hunks"][number];

function parseHunk(hunk: ParsedHunk, wordDiffBudget: { remaining: number }): DiffHunkView {
  let oldNumber = hunk.oldStart;
  let newNumber = hunk.newStart;
  const unifiedLines: DiffLineView[] = hunk.lines.map((rawLine) => {
    const marker = rawLine[0];
    const content = marker === "+" || marker === "-" || marker === " " || marker === "\\"
      ? rawLine.slice(1)
      : rawLine;
    if (marker === "+") {
      return { kind: "addition", content, oldNumber: null, newNumber: newNumber++ };
    }
    if (marker === "-") {
      return { kind: "deletion", content, oldNumber: oldNumber++, newNumber: null };
    }
    if (marker === "\\") {
      return { kind: "metadata", content, oldNumber: null, newNumber: null };
    }
    return {
      kind: "context",
      content,
      oldNumber: oldNumber++,
      newNumber: newNumber++,
    };
  });

  const splitRows: SplitDiffRow[] = [];
  let index = 0;
  while (index < unifiedLines.length) {
    const line = unifiedLines[index]!;
    if (line.kind === "metadata") {
      splitRows.push({ oldLine: null, newLine: null, metadata: line.content });
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      splitRows.push({ oldLine: line, newLine: line });
      index += 1;
      continue;
    }

    const deletions: DiffLineView[] = [];
    const additions: DiffLineView[] = [];
    while (unifiedLines[index]?.kind === "deletion") {
      deletions.push(unifiedLines[index]!);
      index += 1;
    }
    while (unifiedLines[index]?.kind === "addition") {
      additions.push(unifiedLines[index]!);
      index += 1;
    }
    if (deletions.length === 0 && additions.length === 0) {
      const target = line.kind === "addition" ? additions : deletions;
      target.push(line);
      index += 1;
    }

    for (let pairIndex = 0; pairIndex < Math.max(deletions.length, additions.length); pairIndex += 1) {
      const deletion = deletions[pairIndex] ?? null;
      const addition = additions[pairIndex] ?? null;
      if (deletion && addition) {
        const segments = wordSegments(deletion.content, addition.content, wordDiffBudget);
        if (segments) {
          deletion.segments = segments.oldSegments;
          addition.segments = segments.newSegments;
        }
      }
      splitRows.push({ oldLine: deletion, newLine: addition });
    }
  }

  return {
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    unifiedLines,
    splitRows,
  };
}

export function prepareDiff(diff: string, path?: string, kind?: string): PreparedDiff {
  const lineCount = diff.split("\n").length;
  if (diff.length > MAX_STRUCTURED_DIFF_CHARACTERS || lineCount > MAX_STRUCTURED_DIFF_LINES) {
    return { patch: null, files: [], additions: 0, deletions: 0, fallback: "large" };
  }

  const patch = completePatch(diff, path, kind);
  try {
    const parsed = parsePatch(patch);
    const cannotRenderCompletely = parsed.some((file) => (
      file.hunks.length === 0 ||
      file.isBinary ||
      file.isRename ||
      file.isCopy ||
      file.isCreate ||
      file.isDelete ||
      file.oldMode !== undefined ||
      file.newMode !== undefined
    ));
    if (cannotRenderCompletely) {
      return { patch: null, files: [], additions: 0, deletions: 0, fallback: "unsupported" };
    }
    const withHunks = parsed.filter((file) => file.hunks.length > 0);
    if (withHunks.length === 0) {
      return { patch: null, files: [], additions: 0, deletions: 0, fallback: "invalid" };
    }

    let additions = 0;
    let deletions = 0;
    const wordDiffBudget = { remaining: MAX_WORD_DIFF_PAIRS };
    const files = withHunks.map((file) => {
      const hunks = file.hunks.map((hunk) => parseHunk(hunk, wordDiffBudget));
      for (const hunk of hunks) {
        additions += hunk.unifiedLines.filter((line) => line.kind === "addition").length;
        deletions += hunk.unifiedLines.filter((line) => line.kind === "deletion").length;
      }
      return {
        name: displayPath(file.oldFileName, file.newFileName, path),
        hunks,
      };
    });
    return { patch, files, additions, deletions, fallback: null };
  } catch {
    return { patch: null, files: [], additions: 0, deletions: 0, fallback: "invalid" };
  }
}
