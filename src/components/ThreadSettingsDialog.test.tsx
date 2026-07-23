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
  it("requires a workspace for a new thread and returns the selected sandbox", () => {
    const onConfirm = vi.fn();
    render(
      <ThreadSettingsDialog
        open
        mode="new"
        settings={{ ...settings, cwd: "" }}
        running={false}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    const submit = screen.getByRole("button", { name: "Create thread" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Working directory"), { target: { value: "/new/project" } });
    fireEvent.change(screen.getByLabelText("Sandbox"), { target: { value: "danger-full-access" } });
    expect(screen.getByRole("alert")).toHaveTextContent("removes workspace sandbox restrictions");
    fireEvent.click(submit);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/new/project",
      sandbox: "danger-full-access",
    }));
  });

  it("keeps an existing cwd fixed and locks sandbox during an active turn", () => {
    render(
      <ThreadSettingsDialog
        open
        mode="existing"
        settings={settings}
        running
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Working directory")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Sandbox")).toBeDisabled();
    expect(screen.getByText(/after the active turn finishes/)).toBeInTheDocument();
  });
});
