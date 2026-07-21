import { Folder, Gauge, HardDrive, Sparkles } from "lucide-react";
import type { ModelInfo, ThreadSettings } from "../types/protocol";
import { MobileMenuButton } from "./Sidebar";

interface ToolbarProps {
  settings: ThreadSettings;
  title: string;
  connectionDetail: string;
  models: ModelInfo[];
  onChange: (settings: Partial<ThreadSettings>) => void;
  onMenu: () => void;
}

export function Toolbar({ settings, title, connectionDetail, models, onChange, onMenu }: ToolbarProps) {
  const selectedModel = models.find((model) => model.model === settings.model)
    ?? (settings.model === "" ? models.find((model) => model.isDefault) : undefined);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  return (
    <header className="toolbar">
      <div className="toolbar-title">
        <MobileMenuButton onClick={onMenu} />
        <div><strong>{title}</strong><span>{connectionDetail}</span></div>
      </div>
      <div className="toolbar-controls">
        <label className="toolbar-control toolbar-control--model" title="Model">
          <Sparkles size={14} aria-hidden="true" />
          <select
            aria-label="Model"
            value={settings.model}
            onChange={(event) => {
              onChange({
                model: event.target.value,
                effort: "",
              });
            }}
          >
            <option value="">Codex default</option>
            {settings.model && !selectedModel && <option value={settings.model}>{settings.model}</option>}
            {models.map((model) => (
              <option key={model.model} value={model.model}>
                {model.displayName}{model.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="toolbar-control" title="Reasoning effort">
          <Gauge size={14} aria-hidden="true" />
          <select aria-label="Reasoning effort" value={settings.effort} onChange={(event) => onChange({ effort: event.target.value })}>
            <option value="">
              Default{selectedModel?.defaultReasoningEffort ? ` (${selectedModel.defaultReasoningEffort})` : ""}
            </option>
            {efforts.length > 0 ? efforts.map((effort) => (
              <option key={effort.reasoningEffort} value={effort.reasoningEffort} title={effort.description}>
                {effort.reasoningEffort.replace(/^./, (character) => character.toUpperCase())}
              </option>
            )) : (
              <>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
              </>
            )}
          </select>
        </label>
        <label className="toolbar-control" title="Sandbox">
          <HardDrive size={14} aria-hidden="true" />
          <select
            aria-label="Sandbox"
            value={settings.sandbox}
            onChange={(event) => onChange({ sandbox: event.target.value as ThreadSettings["sandbox"] })}
          >
            <option value="workspace-write">Workspace write</option>
            <option value="read-only">Read only</option>
            <option value="danger-full-access">Full access</option>
            {settings.sandbox === "external" && <option value="external" disabled>External sandbox</option>}
          </select>
        </label>
        <label className="toolbar-control toolbar-control--cwd" title="Working directory">
          <Folder size={14} aria-hidden="true" />
          <input aria-label="Working directory" value={settings.cwd} onChange={(event) => onChange({ cwd: event.target.value })} />
        </label>
      </div>
    </header>
  );
}
