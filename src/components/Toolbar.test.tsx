import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toolbar } from "./Toolbar";

describe("Toolbar", () => {
  it("keeps the header compact and delegates detailed settings to the dialog", () => {
    const onSettings = vi.fn();
    render(
      <Toolbar
        settings={{ cwd: "/workspace", model: "", effort: "", sandbox: "workspace-write" }}
        title="Thread title"
        connection="connected"
        connectionDetail="Ready"
        running={false}
        onSettings={onSettings}
        onMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("Thread title")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Thread settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it("surfaces non-default sandbox risk", () => {
    render(
      <Toolbar
        settings={{ cwd: "/workspace", model: "", effort: "", sandbox: "danger-full-access" }}
        title="Thread"
        connection="connected"
        connectionDetail="Ready"
        running
        onSettings={vi.fn()}
        onMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("Full access")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
  });
});
