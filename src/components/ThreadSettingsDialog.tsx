import { MessageSquarePlus, Settings2, X } from "lucide-react";
import { useState } from "react";
import type { ThreadSettings } from "../types/protocol";

interface ThreadSettingsDialogProps {
  open: boolean;
  mode: "new" | "existing";
  settings: ThreadSettings;
  onConfirm: (settings: ThreadSettings) => void;
  onClose: () => void;
}

export function ThreadSettingsDialog({
  open,
  mode,
  settings,
  onConfirm,
  onClose,
}: ThreadSettingsDialogProps) {
  const [cwd, setCwd] = useState(settings.cwd);
  if (!open) return null;

  const existing = mode === "existing";

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="thread-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="thread-settings-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (existing) {
            onClose();
            return;
          }
          const nextCwd = cwd.trim();
          if (!nextCwd) return;
          onConfirm({ ...settings, cwd: nextCwd, sandbox: "workspace-write" });
        }}
      >
        <div className="dialog-heading">
          {existing
            ? <Settings2 size={19} aria-hidden="true" />
            : <MessageSquarePlus size={19} aria-hidden="true" />}
          <div>
            <strong id="thread-settings-title">{existing ? "Thread settings" : "New thread"}</strong>
            <span>{existing ? "Current workspace" : "Choose a workspace"}</span>
          </div>
          <button className="icon-button" type="button" title="Close" aria-label="Close" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>

        <label className={`dialog-field ${existing ? "dialog-field--readonly" : ""}`}>
          <span>Working directory</span>
          <input
            aria-label="Working directory"
            autoFocus={!existing}
            required
            readOnly={existing}
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
          />
        </label>

        <div className="dialog-actions">
          {existing ? (
            <button className="button button--primary" type="button" onClick={onClose}>Close</button>
          ) : (
            <>
              <button className="button button--quiet" type="button" onClick={onClose}>Cancel</button>
              <button className="button button--primary" type="submit" disabled={!cwd.trim()}>
                Create thread
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
