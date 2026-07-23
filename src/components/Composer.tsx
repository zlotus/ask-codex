import { Gauge, Send, Sparkles, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelInfo, ThreadSettings } from "../types/protocol";
import { modelForSelection, normalizeEffortForModel } from "../utils/threadSettings";

const MAX_COMPOSER_CHARACTERS = 250_000;
const MIN_TEXTAREA_HEIGHT = 32;
const MAX_TEXTAREA_HEIGHT = 128;

interface ComposerProps {
  disabled: boolean;
  running: boolean;
  settings: ThreadSettings;
  models: ModelInfo[];
  onSettingsChange: (settings: Partial<ThreadSettings>) => void;
  onSend: (text: string) => Promise<void> | void;
  onStop: () => Promise<void> | void;
}

export function Composer({
  disabled,
  running,
  settings,
  models,
  onSettingsChange,
  onSend,
  onStop,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectedModel = modelForSelection(models, settings.model);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  const effortKnown = !settings.effort || efforts.some((option) => option.reasoningEffort === settings.effort);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const height = Math.min(Math.max(textarea.scrollHeight, MIN_TEXTAREA_HEIGHT), MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
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
          placeholder={running ? "Codex is working…" : "Ask Codex"}
          aria-label="Message Codex"
          disabled={disabled || running}
          maxLength={MAX_COMPOSER_CHARACTERS}
          rows={1}
        />
        <div className="composer-footer" aria-label="Next turn settings">
          <label className="composer-setting" title="Model for the next turn">
            <Sparkles size={12} aria-hidden="true" />
            <select
              aria-label="Model for next turn"
              disabled={disabled || running || (!settings.model && models.length === 0)}
              value={settings.model}
              onChange={(event) => {
                const model = event.target.value;
                onSettingsChange({
                  model,
                  effort: normalizeEffortForModel(models, model, settings.effort),
                });
              }}
            >
              {!settings.model && <option value="">Model unavailable</option>}
              {settings.model && !selectedModel && <option value={settings.model}>{settings.model}</option>}
              {models.map((model) => (
                <option key={model.model} value={model.model}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="composer-setting" title="Reasoning effort for the next turn">
            <Gauge size={12} aria-hidden="true" />
            <select
              aria-label="Reasoning effort for next turn"
              disabled={disabled || running || (!settings.effort && efforts.length === 0)}
              value={settings.effort}
              onChange={(event) => onSettingsChange({ effort: event.target.value })}
            >
              {!settings.effort && <option value="">Effort unavailable</option>}
              {!effortKnown && <option value={settings.effort}>{settings.effort}</option>}
              {efforts.map((effort) => (
                <option key={effort.reasoningEffort} value={effort.reasoningEffort} title={effort.description}>
                  {effort.reasoningEffort.replace(/^./, (character) => character.toUpperCase())}
                </option>
              ))}
            </select>
          </label>
        </div>
        {running ? (
          <button type="button" className="composer-action composer-action--stop" title="Stop turn" aria-label="Stop turn" onClick={() => void onStop()}>
            <Square size={14} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="composer-action"
            title="Send message"
            aria-label="Send message"
            disabled={disabled || sending || !value.trim()}
            onClick={() => void submit()}
          >
            <Send size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
