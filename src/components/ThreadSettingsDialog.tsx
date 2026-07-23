import { MessageSquarePlus, Settings2, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import type { ThreadSettings } from "../types/protocol";

interface ThreadSettingsDialogProps {
  open: boolean;
  mode: "new" | "existing";
  settings: ThreadSettings;
  running: boolean;
  onConfirm: (settings: ThreadSettings) => void;
  onClose: () => void;
}

export function ThreadSettingsDialog({
  open,
  mode,
  settings,
  running,
  onConfirm,
  onClose,
}: ThreadSettingsDialogProps) {
  const [cwd, setCwd] = useState(settings.cwd);
  const [sandbox, setSandbox] = useState<ThreadSettings["sandbox"]>(settings.sandbox);
  if (!open) return null;

  const existing = mode === "existing";
  const sandboxLocked = existing && (running || settings.sandbox === "external");
  const nonDefaultSandbox = sandbox !== "workspace-write";

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="thread-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="thread-settings-title"
        onSubmit={(event) => {
          event.preventDefault();
          const nextCwd = cwd.trim();
          if (!nextCwd) return;
          onConfirm({ ...settings, cwd: nextCwd, sandbox });
        }}
      >
        <div className="dialog-heading">
          {existing
            ? <Settings2 size={19} aria-hidden="true" />
            : <MessageSquarePlus size={19} aria-hidden="true" />}
          <div>
            <strong id="thread-settings-title">{existing ? "Thread settings" : "New thread"}</strong>
            <span>{existing ? "Settings for the next turn" : "Choose a workspace"}</span>
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

        <label className="dialog-field">
          <span>Sandbox</span>
          <select
            aria-label="Sandbox"
            disabled={sandboxLocked}
            value={sandbox}
            onChange={(event) => setSandbox(event.target.value as ThreadSettings["sandbox"])}
          >
            <option value="workspace-write">Workspace write</option>
            <option value="read-only">Read only</option>
            <option value="danger-full-access">Full access</option>
            {sandbox === "external" && <option value="external">External sandbox</option>}
          </select>
        </label>

        {nonDefaultSandbox && (
          <div className={`dialog-warning dialog-warning--${sandbox}`} role="alert">
            <ShieldAlert size={16} aria-hidden="true" />
            <span>
              {sandbox === "danger-full-access"
                ? "Full access removes workspace sandbox restrictions."
                : sandbox === "read-only"
                  ? "Read-only mode prevents workspace changes."
                  : "This thread uses an externally managed sandbox."}
            </span>
          </div>
        )}
        {existing && running && <p className="dialog-note">Sandbox can be changed after the active turn finishes.</p>}

        <div className="dialog-actions">
          <button className="button button--quiet" type="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={!cwd.trim()}>
            {existing ? "Apply" : "Create thread"}
          </button>
        </div>
      </form>
    </div>
  );
}
