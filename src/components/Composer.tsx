import { Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const MAX_COMPOSER_CHARACTERS = 250_000;

interface ComposerProps {
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => Promise<void> | void;
  onStop: () => Promise<void> | void;
}

export function Composer({ disabled, running, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 48), 168)}px`;
  }, [value]);

  const submit = async () => {
    const text = value.trim();
    if (!text || disabled || running || sending) return;
    setSending(true);
    try {
      await onSend(text);
      setValue("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={running ? "Codex is working…" : "Ask Codex to work in this repository"}
          aria-label="Message Codex"
          disabled={disabled || running}
          maxLength={MAX_COMPOSER_CHARACTERS}
          rows={1}
        />
        {running ? (
          <button type="button" className="composer-action composer-action--stop" title="Stop turn" onClick={() => void onStop()}>
            <Square size={15} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="composer-action"
            title="Send message"
            disabled={disabled || sending || !value.trim()}
            onClick={() => void submit()}
          >
            <Send size={17} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
