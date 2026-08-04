import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "./CodeBlock";
import { Markdown } from "./Markdown";

const CAPABILITY_A = "a".repeat(32);
const CAPABILITY_B = "b".repeat(32);
const CAPABILITY_C = "c".repeat(32);
const CAPABILITY_D = "d".repeat(32);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CodeBlock", () => {
  it("loads highlighting on demand and toggles wrapping", async () => {
    const { container } = render(<CodeBlock code="const answer: number = 42;" language="ts" />);

    await waitFor(() => expect(container.querySelector(".hljs-keyword")).toHaveTextContent("const"));
    const wrap = screen.getByRole("button", { name: "Wrap long lines" });
    fireEvent.click(wrap);
    expect(wrap).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".code-block")).toHaveClass("code-block--wrap");
  });

  it("copies the complete value even when the display is bounded", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const code = "x".repeat(1_500);
    render(<CodeBlock code={code} maxDisplayCharacters={1_000} />);

    expect(screen.getByText("500 characters omitted from display")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("uses the reusable block for fenced Markdown", () => {
    render(<Markdown>{"```json\n{\"ok\": true}\n```"}</Markdown>);

    expect(screen.getByText("json")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy json" })).toBeInTheDocument();
  });

  it("bounds Markdown rendering", () => {
    render(<Markdown maxCharacters={1_000}>{"a".repeat(1_200)}</Markdown>);

    expect(screen.getByText("200 characters omitted from display")).toBeInTheDocument();
  });

  it("bounds Markdown structure as well as source characters", () => {
    const markdown = Array.from({ length: 1_200 }, (_, index) => `**item ${index}**`).join(" ");
    const { container } = render(<Markdown>{markdown}</Markdown>);

    expect(screen.getByText(/exceeds the rendering complexity limit/)).toBeInTheDocument();
    expect(container.querySelectorAll("strong").length).toBeLessThan(1_200);
  });

  it("keeps hostile highlighted HTML and Markdown URLs inert", async () => {
    const source = "<img src=x onerror=alert(1)>";
    const highlighted = render(<CodeBlock code={source} language="html" />);

    await waitFor(() => expect(highlighted.container.querySelector(".hljs-tag")).toBeInTheDocument());
    expect(highlighted.container.querySelector("img")).not.toBeInTheDocument();
    expect(highlighted.container.querySelector("code")).toHaveTextContent(source);
    highlighted.unmount();

    const markdown = render(
      <Markdown>{"<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert(1))"}</Markdown>,
    );
    expect(markdown.container.querySelector("img")).not.toBeInTheDocument();
    expect(markdown.container.querySelector("a")).not.toBeInTheDocument();
    expect(screen.getByText("unsafe")).toBeInTheDocument();
  });

  it("offers downloads only for exactly matched absolute local file capabilities", () => {
    const onDownloadFile = vi.fn().mockResolvedValue(undefined);
    render(
      <Markdown
        fileDownloads={[
          { href: "/tmp/report.txt", capabilityId: CAPABILITY_A },
          { href: "/tmp/report%20final.txt:12:4", capabilityId: CAPABILITY_B },
          { href: "/tmp/report final.txt:8", capabilityId: CAPABILITY_D },
          { href: "/tmp/unsigned.txt", capabilityId: "not-a-valid-capability" },
          { href: "https://example.com/archive.zip", capabilityId: CAPABILITY_C },
        ]}
        onDownloadFile={onDownloadFile}
      >
        {[
          "[report](/tmp/report.txt)",
          "[encoded report](/tmp/report%20final.txt:12:4)",
          "[spaced report](</tmp/report final.txt:8>)",
          "[other local file](/tmp/other.txt)",
          "[unsigned local file](/tmp/unsigned.txt)",
          "[external archive](https://example.com/archive.zip)",
        ].join(" ")}
      </Markdown>,
    );

    expect(screen.getByRole("button", { name: "Download report.txt" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download report final.txt" })).toHaveLength(2);
    expect(screen.getByText("other local file")).toHaveClass("markdown-local-file-reference");
    expect(screen.getByText("unsigned local file")).toHaveClass("markdown-local-file-reference");
    expect(screen.queryByRole("link", { name: "other local file" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "unsigned local file" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "external archive" })).toHaveAttribute(
      "href",
      "https://example.com/archive.zip",
    );
    expect(screen.queryByRole("button", { name: "Download external archive" })).not.toBeInTheDocument();
  });

  it("uses the first CommonMark reference definition for download matching", () => {
    const onDownloadFile = vi.fn().mockResolvedValue(undefined);
    render(
      <Markdown
        fileDownloads={[
          { href: "/tmp/report.txt", capabilityId: CAPABILITY_A },
          { href: "/tmp/not-selected.txt", capabilityId: CAPABILITY_B },
        ]}
        onDownloadFile={onDownloadFile}
      >
        {[
          "[report][local] [website][external]",
          "",
          "[local]: /tmp/report.txt",
          "[local]: https://example.com/ignored",
          "[external]: https://example.com/",
          "[external]: /tmp/not-selected.txt",
        ].join("\n")}
      </Markdown>,
    );

    expect(screen.getByRole("button", { name: "Download report.txt" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "website" })).toHaveAttribute(
      "href",
      "https://example.com/",
    );
    expect(screen.queryByRole("button", { name: "Download website" })).not.toBeInTheDocument();
  });

  it("confirms a file download and exposes its pending, started, and consumed states", async () => {
    vi.useFakeTimers();
    let finishDownload: (() => void) | undefined;
    const onDownloadFile = vi.fn(() => new Promise<void>((resolve) => {
      finishDownload = resolve;
    }));
    const { rerender, unmount } = render(
      <Markdown
        fileDownloads={[{ href: "/tmp/report.txt", capabilityId: CAPABILITY_A }]}
        onDownloadFile={onDownloadFile}
      >
        {"[report](/tmp/report.txt)"}
      </Markdown>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
    expect(onDownloadFile).not.toHaveBeenCalled();
    expect(screen.getByText("Download report.txt?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm download report.txt" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Cancel download report.txt" }));
    expect(screen.getByRole("button", { name: "Download report.txt" })).toHaveFocus();
    expect(onDownloadFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm download report.txt" }));
    expect(onDownloadFile).toHaveBeenCalledWith({ href: "/tmp/report.txt", capabilityId: CAPABILITY_A });
    expect(screen.getByRole("button", { name: "Downloading report.txt" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Downloading report.txt" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Downloading");

    await act(async () => {
      finishDownload?.();
      await Promise.resolve();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Download started");
    const started = screen.getByRole("button", { name: "Download started report.txt" });
    expect(started).toHaveAttribute("aria-disabled", "true");
    expect(started).toHaveFocus();
    expect(started).toHaveTextContent("Download started");
    expect(started.querySelector(".lucide-check")).toBeInTheDocument();
    fireEvent.click(started);
    expect(onDownloadFile).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Confirm download report.txt" })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.getByRole("button", { name: "Download started report.txt" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    const consumed = screen.getByRole("button", { name: "Download already started report.txt" });
    expect(consumed).toHaveTextContent("report");
    expect(consumed).toHaveAttribute("aria-disabled", "true");
    expect(consumed.querySelector(".lucide-check")).toBeInTheDocument();
    expect(consumed).toHaveFocus();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(consumed);
    expect(onDownloadFile).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Confirm download report.txt" })).not.toBeInTheDocument();

    rerender(
      <Markdown
        fileDownloads={[{ href: "/tmp/report.txt", capabilityId: CAPABILITY_B }]}
        onDownloadFile={onDownloadFile}
      >
        {"[report](/tmp/report.txt)"}
      </Markdown>,
    );
    expect(screen.getByRole("button", { name: "Download report.txt" })).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm download report.txt" }));
    const timersBeforeStarted = vi.getTimerCount();
    await act(async () => {
      finishDownload?.();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Download started report.txt" })).toBeInTheDocument();
    const timersWithStartedFeedback = vi.getTimerCount();
    expect(timersWithStartedFeedback).toBe(timersBeforeStarted + 1);
    unmount();
    expect(vi.getTimerCount()).toBeLessThan(timersWithStartedFeedback);
  });

  it("reports download failures accessibly and allows retrying", async () => {
    const onDownloadFile = vi.fn().mockRejectedValue(new Error("Connection closed"));
    render(
      <Markdown
        fileDownloads={[{ href: "/tmp/report.txt", capabilityId: CAPABILITY_A }]}
        onDownloadFile={onDownloadFile}
      >
        {"[report](/tmp/report.txt)"}
      </Markdown>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm download report.txt" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Download failed: Connection closed");
    expect(screen.getByRole("button", { name: "Download report.txt" })).toBeEnabled();
  });

  it("shows the signed target name instead of trusting a misleading link label", () => {
    render(
      <Markdown
        fileDownloads={[{ href: "/tmp/run.sh", capabilityId: CAPABILITY_A }]}
        onDownloadFile={vi.fn().mockResolvedValue(undefined)}
      >
        {"[quarterly-report.pdf](/tmp/run.sh)"}
      </Markdown>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download run.sh" }));
    expect(screen.getByText("Download run.sh?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm download run.sh" })).toBeInTheDocument();
  });

  it("shares one-shot capability state across repeated links", async () => {
    vi.useFakeTimers();
    let finishDownload: (() => void) | undefined;
    const onDownloadFile = vi.fn(() => new Promise<void>((resolve) => {
      finishDownload = resolve;
    }));
    render(
      <Markdown
        fileDownloads={[{ href: "/tmp/report.txt", capabilityId: CAPABILITY_A }]}
        onDownloadFile={onDownloadFile}
      >
        {"[first](/tmp/report.txt) [second](/tmp/report.txt)"}
      </Markdown>,
    );

    const downloads = screen.getAllByRole("button", { name: "Download report.txt" });
    expect(downloads).toHaveLength(2);
    fireEvent.click(downloads[0]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm download report.txt" }));
    expect(onDownloadFile).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("button", { name: "Downloading report.txt" })).toHaveLength(2);

    await act(async () => {
      finishDownload?.();
      await Promise.resolve();
    });
    expect(screen.getAllByRole("button", { name: "Download started report.txt" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Download started report.txt" })[1]);
    expect(onDownloadFile).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(2_000));
    const consumed = screen.getAllByRole("button", { name: "Download already started report.txt" });
    expect(consumed).toHaveLength(2);
    expect(consumed[0]).toHaveTextContent("first");
    expect(consumed[1]).toHaveTextContent("second");
    expect(consumed[0].querySelector(".lucide-check")).toBeInTheDocument();
    expect(consumed[1].querySelector(".lucide-check")).toBeInTheDocument();
    expect(consumed[0]).toHaveAttribute("aria-disabled", "true");
    expect(consumed[1]).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(consumed[1]);
    expect(onDownloadFile).toHaveBeenCalledOnce();
  });

  it("bounds the target filename used by download controls", () => {
    const longTarget = `${"r".repeat(180)}.txt`;
    const boundedTarget = `${"r".repeat(117)}...`;
    render(
      <Markdown
        fileDownloads={[{ href: `/tmp/${longTarget}`, capabilityId: CAPABILITY_A }]}
        onDownloadFile={vi.fn().mockResolvedValue(undefined)}
      >
        {`[report](/tmp/${longTarget})`}
      </Markdown>,
    );

    const download = screen.getByRole("button", { name: `Download ${boundedTarget}` });
    expect(download).toHaveAttribute("title", `Download ${boundedTarget}`);
    fireEvent.click(download);
    expect(screen.getByRole("button", { name: `Confirm download ${boundedTarget}` })).toBeInTheDocument();
  });
});
