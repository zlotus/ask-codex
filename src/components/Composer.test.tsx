import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const models = [
  {
    model: "model-a",
    displayName: "Model A",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    isDefault: true,
  },
  {
    model: "model-b",
    displayName: "Model B",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    defaultReasoningEffort: "low",
  },
];

describe("Composer", () => {
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
    expect(onSend).toHaveBeenCalledWith("hello");

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
});
