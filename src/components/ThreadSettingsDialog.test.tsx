import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadSettingsDialog } from "./ThreadSettingsDialog";

const settings = {
  cwd: "/workspace/project",
  model: "gpt-5",
  effort: "high",
  sandbox: "workspace-write" as const,
};

describe("ThreadSettingsDialog", () => {
  it("requires a workspace for a new thread and uses the writable default", () => {
    const onConfirm = vi.fn();
    render(
      <ThreadSettingsDialog
        open
        mode="new"
        settings={{ ...settings, cwd: "" }}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    const submit = screen.getByRole("button", { name: "Create thread" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Working directory"), { target: { value: "/new/project" } });
    expect(screen.queryByLabelText("Sandbox")).not.toBeInTheDocument();
    fireEvent.click(submit);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/new/project",
      sandbox: "workspace-write",
    }));
  });

  it("shows an existing workspace without exposing sandbox controls", () => {
    render(
      <ThreadSettingsDialog
        open
        mode="existing"
        settings={settings}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Working directory")).toHaveAttribute("readonly");
    expect(screen.queryByLabelText("Sandbox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
  });
});
