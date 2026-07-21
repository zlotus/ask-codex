import { KeyRound, X } from "lucide-react";
import { useState } from "react";

interface TokenDialogProps {
  open: boolean;
  required: boolean;
  token: string;
  error?: string;
  onSave: (token: string) => void;
  onClose: () => void;
}

export function TokenDialog({ open, required, token, error, onSave, onClose }: TokenDialogProps) {
  const [value, setValue] = useState(token);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="token-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(value.trim());
        }}
      >
        <div className="dialog-heading">
          <KeyRound size={19} aria-hidden="true" />
          <div><strong>Connection token</strong><span>ASK_CODEX_TOKEN</span></div>
          {!required && (
            <button className="icon-button" type="button" title="Close" onClick={onClose}>
              <X size={17} aria-hidden="true" />
            </button>
          )}
        </div>
        <label className="dialog-field">
          <span>Token</span>
          <input type="password" autoFocus value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" />
        </label>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {token && <button className="button button--quiet" type="button" onClick={() => onSave("")}>Clear</button>}
          <button className="button button--primary" type="submit">Connect</button>
        </div>
      </form>
    </div>
  );
}
