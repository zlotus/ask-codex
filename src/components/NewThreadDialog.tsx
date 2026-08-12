import { MessageSquarePlus, X } from "lucide-react";
import { useState } from "react";
import type { ThreadSettings } from "../types/protocol";

interface NewThreadDialogProps {
  open: boolean;
  settings: ThreadSettings;
  onConfirm: (settings: ThreadSettings) => void;
  onClose: () => void;
}

export function NewThreadDialog({
  open,
  settings,
  onConfirm,
  onClose,
}: NewThreadDialogProps) {
  const [cwd, setCwd] = useState(settings.cwd);
  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="new-thread-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-thread-title"
        onSubmit={(event) => {
          event.preventDefault();
          const nextCwd = cwd.trim();
          if (!nextCwd) return;
          onConfirm({ ...settings, cwd: nextCwd, sandbox: "workspace-write" });
        }}
      >
        <div className="dialog-heading">
          <MessageSquarePlus size={19} aria-hidden="true" />
          <div>
            <strong id="new-thread-title">New thread</strong>
            <span>Choose a workspace</span>
          </div>
          <button className="icon-button" type="button" title="Close" aria-label="Close" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>

        <label className="dialog-field">
          <span>Working directory</span>
          <input
            aria-label="Working directory"
            autoFocus
            required
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
          />
        </label>

        <div className="dialog-actions">
          <button className="button button--quiet" type="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={!cwd.trim()}>
            Create thread
          </button>
        </div>
      </form>
    </div>
  );
}
