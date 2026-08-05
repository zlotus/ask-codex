import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalPanel } from "./ApprovalPanel";

describe("ApprovalPanel", () => {
  it("uses modern decisions for file approvals, including session approval", () => {
    const onResolve = vi.fn();
    render(
      <ApprovalPanel
        requests={[{
          id: 1,
          method: "item/fileChange/requestApproval",
          params: { grantRoot: "/workspace" },
          receivedAt: 1,
        }]}
        onResolve={onResolve}
        onReject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "For session" }));
    expect(onResolve).toHaveBeenCalledWith(1, { decision: "acceptForSession" });
  });

  it("does not mistake granular permission requests for command approvals", () => {
    const onResolve = vi.fn();
    const onReject = vi.fn();
    render(
      <ApprovalPanel
        requests={[{
          id: "permissions-1",
          method: "item/permissions/requestApproval",
          params: { reason: "Needs a broader profile" },
          receivedAt: 1,
        }]}
        onResolve={onResolve}
        onReject={onReject}
      />,
    );

    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onResolve).toHaveBeenCalledWith("permissions-1", {
      permissions: {},
      scope: "turn",
    });
    expect(onReject).not.toHaveBeenCalled();
  });

  it("declines unsupported MCP elicitations with the schema response", () => {
    const onResolve = vi.fn();
    render(
      <ApprovalPanel
        requests={[{
          id: "mcp-1",
          method: "mcpServer/elicitation/request",
          params: { mode: "form", message: "Provide credentials" },
          receivedAt: 1,
        }]}
        onResolve={onResolve}
        onReject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onResolve).toHaveBeenCalledWith("mcp-1", {
      action: "decline",
      content: null,
      _meta: null,
    });
  });

  it("uses legacy review decisions for legacy command approvals", () => {
    const onResolve = vi.fn();
    render(
      <ApprovalPanel
        requests={[{
          id: "legacy-1",
          method: "execCommandApproval",
          params: {
            command: ["npm", "test"],
            availableDecisions: ["approved", "abort"],
          },
          receivedAt: 1,
        }]}
        onResolve={onResolve}
        onReject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onResolve).toHaveBeenCalledWith("legacy-1", { decision: "approved" });

    onResolve.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onResolve).toHaveBeenCalledWith("legacy-1", { decision: "abort" });
  });

  it("shows security-relevant approval context", () => {
    render(
      <ApprovalPanel
        requests={[{
          id: "command-context",
          method: "item/commandExecution/requestApproval",
          params: {
            command: "curl https://api.example.com",
            cwd: "/workspace/project",
            networkApprovalContext: { host: "api.example.com", protocol: "https" },
            proposedExecpolicyAmendment: ["curl"],
          },
          receivedAt: 1,
        }]}
        onResolve={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByText(/workspace\/project/)).toBeInTheDocument();
    expect(screen.getAllByText(/api\.example\.com/)).toHaveLength(2);
    expect(screen.getByText(/proposedExecpolicyAmendment/)).toBeInTheDocument();
  });

  it("only offers decisions declared available by app-server", () => {
    const onResolve = vi.fn();
    const onReject = vi.fn();
    render(
      <ApprovalPanel
        requests={[{
          id: "limited-command",
          method: "item/commandExecution/requestApproval",
          params: { command: "true", availableDecisions: ["accept", "decline"] },
          receivedAt: 1,
        }]}
        onResolve={onResolve}
        onReject={onReject}
      />,
    );

    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "For session" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onResolve).toHaveBeenCalledWith("limited-command", { decision: "decline" });
    expect(onReject).not.toHaveBeenCalled();
  });

  it("uses cancel or a fail-closed error when no decline decision is offered", () => {
    const onResolve = vi.fn();
    const onReject = vi.fn();
    const { rerender } = render(
      <ApprovalPanel
        requests={[{
          id: "cancel-only",
          method: "item/commandExecution/requestApproval",
          params: { command: "true", availableDecisions: ["cancel"] },
          receivedAt: 1,
        }]}
        onResolve={onResolve}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResolve).toHaveBeenCalledWith("cancel-only", { decision: "cancel" });
    onResolve.mockClear();

    rerender(
      <ApprovalPanel
        requests={[{
          id: "unsupported-only",
          method: "item/commandExecution/requestApproval",
          params: {
            command: "true",
            availableDecisions: [{
              acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git"] },
            }],
          },
          receivedAt: 1,
        }]}
        onResolve={onResolve}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reject request" }));
    expect(onReject).toHaveBeenCalledWith(
      "unsupported-only",
      "Ask Codex cannot return any offered decision for item/commandExecution/requestApproval",
    );
    expect(onResolve).not.toHaveBeenCalled();
  });
});
