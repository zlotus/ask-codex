import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
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
    expect(screen.getByLabelText("Message Codex")).toBeEnabled();
    expect(screen.getByLabelText("Model for next turn")).toBeDisabled();
    expect(screen.getByLabelText("Reasoning effort for next turn")).toBeDisabled();
  });

  it("keeps text editable while actions are disabled and never sends from Enter", () => {
    const onSend = vi.fn();
    render(
      <Composer
        disabled
        running={false}
        settings={{ cwd: "/workspace", model: "model-a", effort: "high", sandbox: "workspace-write" }}
        models={models}
        onSettingsChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    const textarea = screen.getByLabelText("Message Codex");
    expect(textarea).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add images" })).toBeDisabled();
    expect(screen.getByLabelText("Model for next turn")).toBeDisabled();
    expect(screen.getByLabelText("Reasoning effort for next turn")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "first line" } });
    const enter = createEvent.keyDown(textarea, { key: "Enter" });
    fireEvent(textarea, enter);
    expect(enter.defaultPrevented).toBe(false);
    const shortcut = createEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent(textarea, shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
    fireEvent.change(textarea, { target: { value: "first line\nsecond line" } });
    expect(textarea).toHaveValue("first line\nsecond line");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("uses Enter for newlines even when sending is available", () => {
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

    const textarea = screen.getByLabelText("Message Codex");
    fireEvent.change(textarea, { target: { value: "first line" } });
    for (const isComposing of [false, true]) {
      const enter = createEvent.keyDown(textarea, { key: "Enter", isComposing });
      fireEvent(textarea, enter);
      expect(enter.defaultPrevented).toBe(false);
    }
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each(["ctrlKey", "metaKey"] as const)("sends with %s and Enter", async (modifier) => {
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

    const textarea = screen.getByLabelText("Message Codex");
    expect(textarea).toHaveAttribute("placeholder", "Ask Codex (Ctrl+Enter to send)");
    fireEvent.change(textarea, { target: { value: "  send this  " } });
    const shortcut = createEvent.keyDown(textarea, { key: "Enter", [modifier]: true });
    fireEvent(textarea, shortcut);

    expect(shortcut.defaultPrevented).toBe(true);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("send this", []));
  });

  it("does not send a shortcut while an input method is composing", () => {
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

    const textarea = screen.getByLabelText("Message Codex");
    fireEvent.change(textarea, { target: { value: "still composing" } });
    const shortcut = createEvent.keyDown(textarea, {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    fireEvent(textarea, shortcut);

    expect(shortcut.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps new typing separate while a send is in flight", async () => {
    let resolveSend!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));
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

    const textarea = screen.getByLabelText("Message Codex");
    fireEvent.change(textarea, { target: { value: "send this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(textarea).toBeEnabled();
    expect(textarea).toHaveValue("");
    fireEvent.change(textarea, { target: { value: "next draft" } });

    await act(async () => resolveSend());

    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    expect(textarea).toHaveValue("next draft");
  });

  it("keeps a failed submission separate from typing that started in flight", async () => {
    let rejectSend!: (error: Error) => void;
    const onSend = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectSend = reject;
      }))
      .mockResolvedValueOnce(undefined);
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

    const textarea = screen.getByLabelText("Message Codex");
    fireEvent.change(textarea, { target: { value: "first message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    fireEvent.change(textarea, { target: { value: "next draft" } });

    await act(async () => rejectSend(new Error("Connection closed")));

    expect(textarea).toHaveValue("next draft");
    expect(screen.getByRole("alert")).toHaveTextContent("first message");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry unconfirmed message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Message not confirmed")).not.toBeInTheDocument());
    expect(onSend).toHaveBeenLastCalledWith("first message", []);
    expect(textarea).toHaveValue("next draft");
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

  it("adds pasted images and suppresses the browser's duplicate default paste", () => {
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
    const textarea = screen.getByLabelText("Message Codex");
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: { files: [pasted] },
    });

    fireEvent(textarea, pasteEvent);

    expect(screen.getByText("pasted.jpg")).toBeInTheDocument();
    expect(pasteEvent.defaultPrevented).toBe(true);
  });

  it("accepts Android image MIME aliases and generic binary metadata", () => {
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
    const alias = new File([new Uint8Array([1])], "alias.jpg", { type: "image/jpg" });
    const generic = new File([new Uint8Array([2])], "generic.jpeg", {
      type: "application/octet-stream",
    });

    fireEvent.change(screen.getByLabelText("Choose images"), {
      target: { files: [alias, generic] },
    });

    expect(screen.getByText("alias.jpg")).toBeInTheDocument();
    expect(screen.getByText("generic.jpeg")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to clipboard items for generic Android image files", () => {
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
    const pasted = new File([new Uint8Array([1])], "clipboard.jpg", {
      type: "application/octet-stream",
    });
    const textarea = screen.getByLabelText("Message Codex");
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => pasted }],
      },
    });

    fireEvent(textarea, pasteEvent);

    expect(screen.getByText("clipboard.jpg")).toBeInTheDocument();
    expect(pasteEvent.defaultPrevented).toBe(true);
  });

  it("preserves default paste behavior when no image is accepted", () => {
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
    const textarea = screen.getByLabelText("Message Codex");
    const textPaste = createEvent.paste(textarea, {
      clipboardData: { files: [] },
    });
    const invalidPaste = createEvent.paste(textarea, {
      clipboardData: {
        files: [new File(["svg"], "vector.svg", { type: "image/svg+xml" })],
      },
    });

    fireEvent(textarea, textPaste);
    fireEvent(textarea, invalidPaste);

    expect(textPaste.defaultPrevented).toBe(false);
    expect(invalidPaste.defaultPrevented).toBe(false);
    expect(screen.queryByText("vector.svg")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("PNG, JPEG, or WebP");
  });

  it("preserves default paste behavior when the image limit is already full", () => {
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
    const selected = Array.from({ length: 4 }, (_, index) =>
      new File([new Uint8Array([index])], `selected-${index}.png`, { type: "image/png" }));
    fireEvent.change(screen.getByLabelText("Choose images"), { target: { files: selected } });
    const textarea = screen.getByLabelText("Message Codex");
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        files: [new File([new Uint8Array([5])], "extra.png", { type: "image/png" })],
      },
    });

    fireEvent(textarea, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(screen.queryByText("extra.png")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("at most 4 images");
  });

  it("keeps an image submission available for retry after send failure", async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error("Upload failed"))
      .mockResolvedValueOnce(undefined);
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry unconfirmed message" })).toBeEnabled());
    expect(screen.getByLabelText("Message Codex")).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("keep me");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:retry.png");

    fireEvent.click(screen.getByRole("button", { name: "Retry unconfirmed message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenLastCalledWith("keep me", [valid]);
    await waitFor(() => expect(screen.queryByText("Message not confirmed")).not.toBeInTheDocument());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:retry.png");
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
