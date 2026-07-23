import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "./CodeBlock";
import { Markdown } from "./Markdown";

afterEach(() => {
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
});
