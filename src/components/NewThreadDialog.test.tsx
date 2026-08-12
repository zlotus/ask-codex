import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewThreadDialog } from "./NewThreadDialog";

const settings = {
  cwd: "/workspace/project",
  model: "gpt-5",
  effort: "high",
  sandbox: "workspace-write" as const,
};

describe("NewThreadDialog", () => {
  it("requires a workspace for a new thread and uses the writable default", () => {
    const onConfirm = vi.fn();
    render(
      <NewThreadDialog
        open
        settings={{ ...settings, cwd: "" }}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    const submit = screen.getByRole("button", { name: "Create thread" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Working directory"), { target: { value: " /new/project " } });
    expect(screen.queryByLabelText("Sandbox")).not.toBeInTheDocument();
    fireEvent.click(submit);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/new/project",
      sandbox: "workspace-write",
    }));
  });

  it("closes without configuring a draft", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <NewThreadDialog
        open
        settings={settings}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
