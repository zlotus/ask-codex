import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../types/protocol";
import { Composer } from "./Composer";

const createObjectURL = vi.fn((file: File) => `blob:${file.name}`);
const revokeObjectURL = vi.fn();

const models: ModelInfo[] = [
  {
    model: "model-a",
    displayName: "Model A",
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    isDefault: true,
  },
  {
    model: "model-b",
    displayName: "Model B",
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    defaultReasoningEffort: "low",
  },
];

describe("Composer", () => {
  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  });

  it("normalizes effort when selecting a model for the next turn", () => {
    const onSettingsChange = vi.fn();
    render(
      <Composer
        disabled={false}
        running={false}
        settings={{ cwd: "/workspace", model: "model-a", effort: "high", sandbox: "workspace-write" }}
        models={models}
        onSettingsChange={onSettingsChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Model for next turn"), { target: { value: "model-b" } });
    expect(onSettingsChange).toHaveBeenCalledWith({ model: "model-b", effort: "low" });
    expect(screen.queryByText(/default/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Codex")).toHaveAttribute("rows", "1");
  });

  it("keeps configured values that are absent from the model catalog", () => {
    render(
      <Composer
        disabled={false}
        running={false}
        settings={{ cwd: "/workspace", model: "custom-model", effort: "max", sandbox: "workspace-write" }}
        models={models}
        onSettingsChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Model for next turn")).toHaveValue("custom-model");
    expect(screen.getByRole("option", { name: "custom-model" })).toBeInTheDocument();
    expect(screen.getByLabelText("Reasoning effort for next turn")).toHaveValue("max");
    expect(screen.getByRole("option", { name: "max" })).toBeInTheDocument();
  });

  it("submits a trimmed message and exposes stop while a turn is active", () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <Composer
        disabled={false}
        running={false}
        settings={{ cwd: "/workspace", model: "model-a", effort: "high", sandbox: "workspace-write" }}
        models={models}
        onSettingsChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "  hello  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("hello", []);

    rerender(
      <Composer
        disabled={false}
        running
        settings={{ cwd: "/workspace", model: "model-a", effort: "high", sandbox: "workspace-write" }}
        models={models}
        onSettingsChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Stop turn" })).toBeInTheDocument();
    expect(screen.getByLabelText("Model for next turn")).toBeDisabled();
    expect(screen.getByLabelText("Reasoning effort for next turn")).toBeDisabled();
  });

  it("selects, previews, removes, and sends image-only drafts", async () => {
    const onSend = vi.fn();
    render(
      <Composer
        disabled={false}
        running={false}
        settings={{ cwd: "/workspace", model: "model-a", effort: "high", sandbox: "workspace-write" }}
        models={models}
        onSettingsChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );
    const first = new File([new Uint8Array([1, 2, 3])], "first.png", { type: "image/png" });
    const second = new File([new Uint8Array([4, 5, 6])], "second.webp", { type: "image/webp" });
    const fileInput = screen.getByLabelText("Choose images");

    expect(fileInput).toHaveAttribute("hidden");
    expect(fileInput).toHaveAttribute("tabindex", "-1");
    expect(fileInput).not.toBeVisible();

    fireEvent.change(fileInput, { target: { files: [first, second] } });
    expect(screen.getByRole("list", { name: "Selected images" })).toBeInTheDocument();
    expect(screen.getByText("first.png")).toBeInTheDocument();
    expect(screen.getByText("second.webp")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove first.png" }));
    expect(screen.queryByText("first.png")).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first.png");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("", [second]));
    await waitFor(() => expect(screen.queryByText("second.webp")).not.toBeInTheDocument());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second.webp");
  });

  it("adds pasted images without discarding pasted text behavior", () => {
    render(
      <Composer
        disabled={false}
        running={false}
        settings={{ cwd: "/workspace", model: "model-a", effort: "high", sandbox: "workspace-write" }}
        models={models}
        onSettingsChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const pasted = new File([new Uint8Array([1])], "pasted.jpg", { type: "image/jpeg" });
    const preventDefault = vi.fn();

    fireEvent.paste(screen.getByLabelText("Message Codex"), {
      clipboardData: { files: [pasted] },
      preventDefault,
    });

    expect(screen.getByText("pasted.jpg")).toBeInTheDocument();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("keeps the draft after send failure and reports invalid image choices", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("Upload failed"));
    render(
      <Composer
        disabled={false}
        running={false}
        settings={{ cwd: "/workspace", model: "model-a", effort: "high", sandbox: "workspace-write" }}
        models={models}
        onSettingsChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Choose images"), {
      target: { files: [new File(["svg"], "vector.svg", { type: "image/svg+xml" })] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("PNG, JPEG, or WebP");

    const valid = new File([new Uint8Array([1])], "retry.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose images"), { target: { files: [valid] } });
    fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("keep me", [valid]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    expect(screen.getByLabelText("Message Codex")).toHaveValue("keep me");
    expect(screen.getByText("retry.png")).toBeInTheDocument();
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:retry.png");
  });

  it("disables image selection when the selected model declares text-only input", () => {
    const onSend = vi.fn();
    render(
      <Composer
        disabled={false}
        running={false}
        settings={{ cwd: "/workspace", model: "model-a", effort: "high", sandbox: "workspace-write" }}
        models={[{ ...models[0], inputModalities: ["text"] }]}
        onSettingsChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Add images" })).toBeDisabled();
    expect(screen.getByTitle("Selected model does not support images")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "text still works" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("text still works", []);
  });

  it("requires explicit image capability without blocking text for an unknown model", () => {
    const onSend = vi.fn();
    render(
      <Composer
        disabled={false}
        running={false}
        settings={{ cwd: "/workspace", model: "uncatalogued-model", effort: "high", sandbox: "workspace-write" }}
        models={models}
        onSettingsChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Add images" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "fallback to text" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith("fallback to text", []);
  });
});
