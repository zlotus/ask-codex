import { useEffect, useState } from "react";
import { Gauge, Maximize2, Minimize2, RefreshCw, ShieldAlert } from "lucide-react";
import type { ConnectionState, ThreadSettings } from "../types/protocol";
import { MobileMenuButton } from "./Sidebar";

interface ToolbarProps {
  sandbox: ThreadSettings["sandbox"];
  title: string;
  connection: ConnectionState;
  connectionDetail: string;
  running: boolean;
  syncing: boolean;
  syncError: string | null;
  retryAttempt: number;
  onUsage: () => void;
  onReconnect: () => void;
  onResync: () => void;
  onMenu: () => void;
}

function sandboxStatus(sandbox: ThreadSettings["sandbox"]): string | null {
  if (sandbox === "danger-full-access") return "Full access";
  if (sandbox === "read-only") return "Read only";
  if (sandbox === "external") return "External sandbox";
  return null;
}

export function Toolbar({
  sandbox,
  title,
  connection,
  connectionDetail,
  running,
  syncing,
  syncError,
  retryAttempt,
  onUsage,
  onReconnect,
  onResync,
  onMenu,
}: ToolbarProps) {
  const sandboxLabel = sandboxStatus(sandbox);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen({
        navigationUI: "hide",
      });
    }
  };
  const connectedStatus = syncing ? (
    <><span className="toolbar-status-prefix">Connected · </span>Syncing</>
  ) : running ? "Working" : "Ready";
  const retryStatus = retryAttempt > 0
    ? `${connection === "connecting" ? "Reconnecting" : "Retrying"} · attempt ${retryAttempt}`
    : connectionDetail;
  const retryShortStatus = retryAttempt > 0 ? `Retry ${retryAttempt}` : connection === "connecting" ? "Connecting" : "Retry";
  const retryTitle = `${connectionDetail}${retryAttempt > 0 ? ` · attempt ${retryAttempt}` : ""}. Retry connection now`;
  return (
    <header className="toolbar">
      <div className="toolbar-title">
        <MobileMenuButton onClick={onMenu} />
        <strong title={title}>{title}</strong>
      </div>
      <div className="toolbar-actions">
        {connection === "connected" && syncError ? (
          <button
            className="toolbar-status toolbar-status-button toolbar-status--error"
            type="button"
            title={`${syncError}. Retry live state sync`}
            aria-label={`${syncError}. Retry live state sync`}
            onClick={onResync}
          >
            <RefreshCw size={13} aria-hidden="true" />
            <span className="toolbar-status-label toolbar-status-label--long">Sync failed · Retry</span>
            <span className="toolbar-status-label toolbar-status-label--short" aria-hidden="true">Sync retry</span>
          </button>
        ) : connection === "connected" ? (
          <span
            className={`toolbar-status toolbar-status--connected${syncing ? " toolbar-status--syncing" : ""}`}
            title={syncing ? "Connected · syncing current thread" : connectionDetail}
            role="status"
            aria-live="polite"
          >
            {syncing && <RefreshCw className="spin" size={13} aria-hidden="true" />}
            <span className="toolbar-status-label">{connectedStatus}</span>
          </span>
        ) : (
          <button
            className={`toolbar-status toolbar-status-button toolbar-status--${connection}`}
            type="button"
            title={retryTitle}
            aria-label={retryTitle}
            onClick={onReconnect}
          >
            <RefreshCw className={connection === "connecting" ? "spin" : undefined} size={13} aria-hidden="true" />
            <span className="toolbar-status-label toolbar-status-label--long">{retryStatus}</span>
            <span className="toolbar-status-label toolbar-status-label--short" aria-hidden="true">{retryShortStatus}</span>
          </button>
        )}
        {sandboxLabel && (
          <span className={`toolbar-risk toolbar-risk--${sandbox}`} title={`Sandbox: ${sandboxLabel}`}>
            <ShieldAlert size={13} aria-hidden="true" />
            <span>{sandboxLabel}</span>
          </span>
        )}
        <button
        className="icon-button toolbar-fullscreen-button"
        type="button"
        title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        onClick={() => void toggleFullscreen()}
      >
        {fullscreen ? (
          <Minimize2 size={16} aria-hidden="true" />
        ) : (
          <Maximize2 size={16} aria-hidden="true" />
        )}
      </button>
        <button
          className="icon-button toolbar-usage-button"
          type="button"
          title="Usage and limits"
          aria-label="Usage and limits"
          onClick={onUsage}
        >
          <Gauge size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
