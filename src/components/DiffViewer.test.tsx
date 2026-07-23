import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffViewer } from "./DiffViewer";
import { prepareDiff } from "./diffUtils";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-const oldValue = true;",
  "+const newValue = true;",
].join("\n");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DiffViewer", () => {
  it("prepares an app-server hunk fragment with file metadata", () => {
    const prepared = prepareDiff("@@ -1 +1 @@\n-old\n+new", "src/a.ts", "update");

    expect(prepared.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(prepared.additions).toBe(1);
    expect(prepared.deletions).toBe(1);
  });

  it.each([
    ["mixed text and binary changes", [
      PATCH,
      "diff --git a/image.png b/image.png",
      "new file mode 100644",
      "index 0000000..1234567",
      "Binary files /dev/null and b/image.png differ",
    ].join("\n")],
    ["mode changes", [
      "diff --git a/src/a.ts b/src/a.ts",
      "old mode 100644",
      "new mode 100755",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n")],
    ["rename-only changes", [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ].join("\n")],
  ])("falls back to the complete raw patch for %s", (_label, patch) => {
    const prepared = prepareDiff(patch);

    expect(prepared.patch).toBeNull();
    expect(prepared.files).toEqual([]);
    expect(prepared.fallback).toBe("unsupported");
  });

  it("shows every file when an unsupported mixed patch falls back to raw text", () => {
    const mixedPatch = [
      PATCH,
      "diff --git a/image.png b/image.png",
      "new file mode 100644",
      "index 0000000..1234567",
      "Binary files /dev/null and b/image.png differ",
    ].join("\n");

    render(<DiffViewer diff={mixedPatch} />);

    expect(screen.getByText("Raw diff")).toBeInTheDocument();
    expect(screen.getByText(/Binary files \/dev\/null and b\/image\.png differ/)).toBeInTheDocument();
  });

  it("switches structured diffs between unified, split, and wrapped views", () => {
    const { container } = render(<DiffViewer diff={PATCH} />);

    expect(container.querySelector(".diff-table--unified")).toBeInTheDocument();
    expect(container.querySelectorAll(".diff-word-change").length).toBeGreaterThan(0);
    expect(container.querySelector(".diff-line--deletion .sr-only")).toHaveTextContent("Deleted line:");
    expect(container.querySelector(".diff-line--addition .sr-only")).toHaveTextContent("Added line:");
    fireEvent.click(screen.getByRole("button", { name: "Split diff" }));
    expect(container.querySelector(".diff-table--split")).toBeInTheDocument();
    expect(container.querySelector(".diff-code-cell--deletion .sr-only")).toHaveTextContent("Deleted line:");
    expect(container.querySelector(".diff-code-cell--addition .sr-only")).toHaveTextContent("Added line:");
    fireEvent.click(screen.getByRole("button", { name: "Wrap diff lines" }));
    expect(container.querySelector(".diff-viewer")).toHaveClass("diff-viewer--wrap");
  });

  it("falls back to bounded raw text for malformed and oversized diffs", () => {
    const { rerender } = render(<DiffViewer diff="-old\n+new" path="src/a.ts" />);

    expect(screen.getByText("Raw diff")).toBeInTheDocument();
    rerender(<DiffViewer diff={`+${"x".repeat(300_001)}`} path="src/large.ts" />);
    expect(screen.getByText("Large diff")).toBeInTheDocument();
    expect(screen.getByText(/characters omitted from display/)).toBeInTheDocument();
  });

  it("removes the split control throughout the 650px compact layout", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(max-width: 720px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })));

    render(<DiffViewer diff={PATCH} />);

    expect(screen.queryByRole("button", { name: "Split diff" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unified diff" })).toHaveAttribute("aria-pressed", "true");
  });
});
