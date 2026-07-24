import { Gauge, ImagePlus, LoaderCircle, Send, Sparkles, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelInfo, ThreadSettings } from "../types/protocol";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
  SUPPORTED_IMAGE_TYPES,
  isPotentialImageFile,
} from "../utils/attachments";
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
  onSend: (text: string, images: readonly File[]) => Promise<void> | void;
  onStop: () => Promise<void> | void;
}

interface DraftImage {
  id: number;
  file: File;
  previewUrl: string;
}

function revokePreview(url: string): void {
  if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
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
  const [images, setImages] = useState<DraftImage[]>([]);
  const [imageError, setImageError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<DraftImage[]>([]);
  const nextImageIdRef = useRef(0);
  const selectedModel = modelForSelection(models, settings.model);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  const effortKnown = !settings.effort || efforts.some((option) => option.reasoningEffort === settings.effort);
  const imageInputSupported = selectedModel?.inputModalities?.includes("image") === true;
  const controlsDisabled = disabled || running || sending;

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => () => {
    for (const image of imagesRef.current) revokePreview(image.previewUrl);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const height = Math.min(Math.max(textarea.scrollHeight, MIN_TEXTAREA_HEIGHT), MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [value]);

  const addImages = (files: readonly File[]): number => {
    if (controlsDisabled || files.length === 0) return 0;
    const accepted: DraftImage[] = [];
    let error = "";
    for (const file of files) {
      if (images.length + accepted.length >= MAX_IMAGES_PER_TURN) {
        error = `A turn can include at most ${MAX_IMAGES_PER_TURN} images`;
        break;
      }
      if (!isPotentialImageFile(file)) {
        error ||= `${file.name || "Image"} must be a PNG, JPEG, or WebP image`;
        continue;
      }
      if (file.size === 0) {
        error ||= `${file.name || "Image"} is empty`;
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        error ||= `${file.name || "Image"} exceeds the 10 MiB image limit`;
        continue;
      }
      if (typeof URL.createObjectURL !== "function") {
        error ||= "This browser cannot preview local images";
        continue;
      }
      try {
        accepted.push({
          id: ++nextImageIdRef.current,
          file,
          previewUrl: URL.createObjectURL(file),
        });
      } catch {
        for (const image of accepted) revokePreview(image.previewUrl);
        accepted.length = 0;
        error = "This browser could not preview the selected images";
        break;
      }
    }
    if (accepted.length > 0) setImages((current) => [...current, ...accepted]);
    setImageError(error);
    return accepted.length;
  };

  const removeImage = (id: number) => {
    if (running || sending) return;
    setImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed) revokePreview(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
    setImageError("");
  };

  const submit = async () => {
    const text = value.trim();
    if (
      (!text && images.length === 0) ||
      controlsDisabled ||
      (images.length > 0 && !imageInputSupported)
    ) return;
    setSending(true);
    try {
      await onSend(text, images.map((image) => image.file));
      setValue("");
      for (const image of images) revokePreview(image.previewUrl);
      setImages([]);
      setImageError("");
    } catch {
      // App owns the user-facing RPC/upload error; retain the draft for retry.
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer-wrap">
      <div className={`composer${images.length > 0 ? " composer--with-attachments" : ""}`}>
        {images.length > 0 && (
          <div className="composer-attachments" role="list" aria-label="Selected images">
            {images.map((image) => (
              <div className="composer-attachment" role="listitem" key={image.id}>
                <img src={image.previewUrl} alt="" />
                <span title={image.file.name}>{image.file.name || "Pasted image"}</span>
                <button
                  type="button"
                  className="composer-attachment-remove"
                  title={`Remove ${image.file.name || "image"}`}
                  aria-label={`Remove ${image.file.name || "image"}`}
                  disabled={running || sending}
                  onClick={() => removeImage(image.id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onPaste={(event) => {
            const pastedImages = clipboardFiles(event.clipboardData)
              .filter((file) => (
                file.type.trim().toLowerCase().startsWith("image/") ||
                isPotentialImageFile(file)
              ));
            if (addImages(pastedImages) > 0) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={running ? "Codex is working…" : "Ask Codex"}
          aria-label="Message Codex"
          disabled={controlsDisabled}
          maxLength={MAX_COMPOSER_CHARACTERS}
          rows={1}
        />
        <span className="sr-only" aria-live="polite">
          {sending
            ? images.length > 0 ? "Uploading images" : "Sending message"
            : images.length > 0
              ? `${images.length} image${images.length === 1 ? "" : "s"} selected`
              : ""}
        </span>
        <div className="composer-footer" aria-label="Next turn settings">
          <input
            ref={fileInputRef}
            hidden
            type="file"
            accept={SUPPORTED_IMAGE_TYPES.join(",")}
            multiple
            disabled={controlsDisabled || !imageInputSupported}
            aria-label="Choose images"
            tabIndex={-1}
            onChange={(event) => {
              addImages(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="composer-image-action"
            title={imageInputSupported ? "Add images" : "Selected model does not support images"}
            aria-label="Add images"
            disabled={controlsDisabled || !imageInputSupported}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={15} aria-hidden="true" />
          </button>
          <label className="composer-setting" title="Model for the next turn">
            <Sparkles size={12} aria-hidden="true" />
            <select
              aria-label="Model for next turn"
              disabled={controlsDisabled || (!settings.model && models.length === 0)}
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
              disabled={controlsDisabled || (!settings.effort && efforts.length === 0)}
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
            disabled={
              controlsDisabled ||
              (!value.trim() && images.length === 0) ||
              (images.length > 0 && !imageInputSupported)
            }
            onClick={() => void submit()}
          >
            {sending
              ? <LoaderCircle className="composer-spinner" size={16} aria-hidden="true" />
              : <Send size={16} aria-hidden="true" />}
          </button>
        )}
      </div>
      {(imageError || (images.length > 0 && !imageInputSupported)) && (
        <div className="composer-error" role="alert">
          {imageError || "Selected model does not support image input"}
        </div>
      )}
    </div>
  );
}
