import { AlertCircle, Settings2, ShieldAlert } from "lucide-react";
import type { ConnectionState, ThreadSettings } from "../types/protocol";
import { MobileMenuButton } from "./Sidebar";

interface ToolbarProps {
  settings: ThreadSettings;
  title: string;
  connection: ConnectionState;
  connectionDetail: string;
  running: boolean;
  onSettings: () => void;
  onMenu: () => void;
}

function sandboxStatus(sandbox: ThreadSettings["sandbox"]): string | null {
  if (sandbox === "danger-full-access") return "Full access";
  if (sandbox === "read-only") return "Read only";
  if (sandbox === "external") return "External sandbox";
  return null;
}

export function Toolbar({
  settings,
  title,
  connection,
  connectionDetail,
  running,
  onSettings,
  onMenu,
}: ToolbarProps) {
  const sandbox = sandboxStatus(settings.sandbox);
  const status = connection === "connected" ? (running ? "Working" : "Ready") : connectionDetail;
  return (
    <header className="toolbar">
      <div className="toolbar-title">
        <MobileMenuButton onClick={onMenu} />
        <strong title={title}>{title}</strong>
      </div>
      <div className="toolbar-actions">
        <span className={`toolbar-status toolbar-status--${connection}`} title={connectionDetail}>
          {connection !== "connected" && <AlertCircle size={13} aria-hidden="true" />}
          {status}
        </span>
        {sandbox && (
          <span className={`toolbar-risk toolbar-risk--${settings.sandbox}`} title={`Sandbox: ${sandbox}`}>
            <ShieldAlert size={13} aria-hidden="true" />
            <span>{sandbox}</span>
          </span>
        )}
        <button
          className="icon-button toolbar-settings-button"
          type="button"
          title="Thread settings"
          aria-label="Thread settings"
          onClick={onSettings}
        >
          <Settings2 size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
