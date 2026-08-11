import {
  FileText,
  FileUp,
  Gauge,
  ImagePlus,
  ListPlus,
  LoaderCircle,
  Plus,
  RotateCcw,
  Send,
  ShieldOff,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelInfo, ThreadSettings } from "../types/protocol";
import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
  formatAttachmentSize,
  isPotentialImageFile,
  isValidAttachmentFileName,
} from "../utils/attachments";
import { errorMessage } from "../utils/protocol";
import { modelForSelection, normalizeEffortForModel } from "../utils/threadSettings";

const MAX_COMPOSER_CHARACTERS = 250_000;
const MIN_TEXTAREA_HEIGHT = 32;
const MAX_TEXTAREA_HEIGHT = 128;

interface ComposerProps {
  activeTurnId?: string | null;
  autoRunAvailable?: boolean;
  autoRunNextTurn?: boolean;
  disabled: boolean;
  running: boolean;
  settings: ThreadSettings;
  models: ModelInfo[];
  onSettingsChange: (settings: Partial<ThreadSettings>) => void;
  onSend: (
    text: string,
    images: readonly File[],
    files: readonly File[],
  ) => Promise<void> | void;
  onEnqueue?: (text: string) => Promise<void> | void;
  onAutoRunNextTurnChange?: (enabled: boolean) => void;
  onSteer?: (text: string, expectedTurnId: string) => Promise<void> | void;
  onStop: () => Promise<void> | void;
}

interface DraftImage {
  id: number;
  file: File;
  previewUrl: string;
}

interface DraftFile {
  id: number;
  file: File;
}

interface DraftSubmission {
  error?: string;
  files: DraftFile[];
  images: DraftImage[];
  mode: "queue" | "start" | "steer";
  expectedTurnId?: string;
  text: string;
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
  activeTurnId = null,
  autoRunAvailable = true,
  autoRunNextTurn = false,
  disabled,
  running,
  settings,
  models,
  onSettingsChange,
  onSend,
  onEnqueue,
  onAutoRunNextTurnChange = () => {},
  onSteer,
  onStop,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [inFlightSubmission, setInFlightSubmission] = useState<DraftSubmission | null>(null);
  const [failedSubmission, setFailedSubmission] = useState<DraftSubmission | null>(null);
  const [images, setImages] = useState<DraftImage[]>([]);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const addControlRef = useRef<HTMLDivElement>(null);
  const imagesRef = useRef<DraftImage[]>([]);
  const failedSubmissionRef = useRef<DraftSubmission | null>(null);
  const inFlightSubmissionRef = useRef<DraftSubmission | null>(null);
  const nextAttachmentIdRef = useRef(0);
  const selectedModel = modelForSelection(models, settings.model);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  const effortKnown = !settings.effort || efforts.some((option) => option.reasoningEffort === settings.effort);
  const imageInputSupported = selectedModel?.inputModalities?.includes("image") === true;
  const sending = inFlightSubmission !== null;
  const controlsDisabled = disabled || sending || failedSubmission !== null;
  const turnControlsDisabled = controlsDisabled || running;
  const canSteer = running && Boolean(activeTurnId) && Boolean(onSteer);
  const canSubmit = !controlsDisabled && (canSteer
    ? Boolean(value.trim())
    : !running &&
      (Boolean(value.trim()) || images.length > 0 || files.length > 0) &&
      (images.length === 0 || imageInputSupported));
  const canEnqueue = !controlsDisabled && Boolean(onEnqueue) && Boolean(value.trim()) &&
    images.length === 0 && files.length === 0;
  const autoRunSandboxAvailable = settings.sandbox !== "external";
  const autoRunDisabled = running || sending || !autoRunAvailable || !autoRunSandboxAvailable;

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    failedSubmissionRef.current = failedSubmission;
  }, [failedSubmission]);

  useEffect(() => {
    inFlightSubmissionRef.current = inFlightSubmission;
  }, [inFlightSubmission]);

  useEffect(() => () => {
    const ownedImages = [
      ...imagesRef.current,
      ...(failedSubmissionRef.current?.images ?? []),
      ...(inFlightSubmissionRef.current?.images ?? []),
    ];
    for (const previewUrl of new Set(ownedImages.map((image) => image.previewUrl))) {
      revokePreview(previewUrl);
    }
  }, []);

  useEffect(() => {
    if (!addMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!addControlRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const height = Math.min(Math.max(textarea.scrollHeight, MIN_TEXTAREA_HEIGHT), MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [value]);

  const addAttachments = (
    selectedFiles: readonly File[],
    mode: "auto" | "files" | "images",
  ): number => {
    if (turnControlsDisabled || selectedFiles.length === 0) return 0;
    const accepted: DraftImage[] = [];
    const acceptedFiles: DraftFile[] = [];
    let error = "";
    let attachmentCount = images.length + files.length;
    for (const file of selectedFiles) {
      if (attachmentCount >= MAX_ATTACHMENTS_PER_TURN) {
        error = `A turn can include at most ${MAX_ATTACHMENTS_PER_TURN} attachments`;
        break;
      }
      const asImage = mode === "images" || (mode === "auto" && isPotentialImageFile(file));
      if (!asImage) {
        if (!isValidAttachmentFileName(file.name)) {
          error ||= "File name is invalid";
          continue;
        }
        if (file.size === 0) {
          error ||= `${file.name} is empty`;
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          error ||= `${file.name} exceeds the 10 MiB file limit`;
          continue;
        }
        acceptedFiles.push({ id: ++nextAttachmentIdRef.current, file });
        attachmentCount += 1;
        continue;
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
          id: ++nextAttachmentIdRef.current,
          file,
          previewUrl: URL.createObjectURL(file),
        });
        attachmentCount += 1;
      } catch {
        for (const image of accepted) revokePreview(image.previewUrl);
        accepted.length = 0;
        error = "This browser could not preview the selected images";
        break;
      }
    }
    if (accepted.length > 0) setImages((current) => [...current, ...accepted]);
    if (acceptedFiles.length > 0) setFiles((current) => [...current, ...acceptedFiles]);
    setAttachmentError(error);
    return accepted.length + acceptedFiles.length;
  };

  const removeImage = (id: number) => {
    if (sending) return;
    setImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed) revokePreview(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
    setAttachmentError("");
  };

  const removeFile = (id: number) => {
    if (sending) return;
    setFiles((current) => current.filter((file) => file.id !== id));
    setAttachmentError("");
  };

  const sendSubmission = async (submission: DraftSubmission) => {
    setInFlightSubmission(submission);
    try {
      if (submission.mode === "queue") {
        if (!onEnqueue) throw new Error("Choose an existing thread before saving a message for later");
        await onEnqueue(submission.text);
      } else if (submission.mode === "steer") {
        if (!submission.expectedTurnId || !onSteer) {
          throw new Error("The active turn is no longer available; nothing was sent");
        }
        await onSteer(submission.text, submission.expectedTurnId);
      } else {
        await onSend(
          submission.text,
          submission.images.map((image) => image.file),
          submission.files.map((file) => file.file),
        );
      }
      for (const image of submission.images) revokePreview(image.previewUrl);
      setFailedSubmission((current) => current === submission ? null : current);
      setAttachmentError("");
    } catch (error) {
      // Keep a failed send separate so it cannot overwrite typing that started in the meantime.
      setFailedSubmission({ ...submission, error: errorMessage(error) });
    } finally {
      setInFlightSubmission(null);
    }
  };

  const submit = async () => {
    const text = value.trim();
    if (!canSubmit) return;
    const submission: DraftSubmission = canSteer
      ? { mode: "steer", text, images: [], files: [], expectedTurnId: activeTurnId! }
      : { mode: "start", text, images, files };
    setValue("");
    if (submission.mode === "start") {
      setImages([]);
      setFiles([]);
      setAddMenuOpen(false);
    }
    await sendSubmission(submission);
  };

  const enqueue = async () => {
    const text = value.trim();
    if (!canEnqueue) return;
    const submission: DraftSubmission = { mode: "queue", text, images: [], files: [] };
    setValue("");
    await sendSubmission(submission);
  };

  const discardFailedSubmission = () => {
    if (!failedSubmission || sending) return;
    for (const image of failedSubmission.images) revokePreview(image.previewUrl);
    setFailedSubmission(null);
  };

  return (
    <div className="composer-wrap">
      <div className={`composer${images.length + files.length > 0 ? " composer--with-attachments" : ""}`}>
        {images.length + files.length > 0 && (
          <div className="composer-attachments" role="list" aria-label="Selected attachments">
            {images.map((image) => (
              <div className="composer-attachment" role="listitem" key={image.id}>
                <img src={image.previewUrl} alt="" />
                <span title={image.file.name}>{image.file.name || "Pasted image"}</span>
                <button
                  type="button"
                  className="composer-attachment-remove"
                  title={`Remove ${image.file.name || "image"}`}
                  aria-label={`Remove ${image.file.name || "image"}`}
                  disabled={sending}
                  onClick={() => removeImage(image.id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
            {files.map((file) => (
              <div
                className="composer-attachment composer-attachment--file"
                role="listitem"
                key={file.id}
              >
                <span className="composer-file-icon" aria-hidden="true">
                  <FileText size={20} />
                </span>
                <span className="composer-file-copy">
                  <strong title={file.file.name}>{file.file.name}</strong>
                  <small>{formatAttachmentSize(file.file.size)}</small>
                </span>
                <button
                  type="button"
                  className="composer-attachment-remove"
                  title={`Remove ${file.file.name}`}
                  aria-label={`Remove ${file.file.name}`}
                  disabled={sending}
                  onClick={() => removeFile(file.id)}
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
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              (!event.ctrlKey && !event.metaKey) ||
              event.nativeEvent.isComposing ||
              !canSubmit
            ) return;
            event.preventDefault();
            void submit();
          }}
          onPaste={(event) => {
            const pastedFiles = clipboardFiles(event.clipboardData);
            if (pastedFiles.length === 0) return;
            event.preventDefault();
            if (running) {
              setAttachmentError("Attachments cannot be added while a turn is running");
              return;
            }
            addAttachments(pastedFiles, "auto");
          }}
          placeholder={running
            ? "Guide active turn (Ctrl+Enter to steer)"
            : "Ask Codex (Ctrl+Enter to send)"}
          aria-label="Message Codex"
          maxLength={MAX_COMPOSER_CHARACTERS}
          rows={1}
        />
        <span className="sr-only" aria-live="polite">
          {sending
              ? inFlightSubmission?.mode === "steer"
                ? "Steering active turn"
                : inFlightSubmission?.mode === "queue"
                  ? "Saving message for later"
                  : inFlightSubmission && inFlightSubmission.images.length + inFlightSubmission.files.length > 0
                    ? "Uploading attachments"
                    : "Sending message"
            : images.length + files.length > 0
              ? `${images.length + files.length} attachment${images.length + files.length === 1 ? "" : "s"} selected`
              : ""}
        </span>
        <div className="composer-footer" aria-label={running ? "Active turn controls" : "Next turn settings"}>
          <input
            ref={imageInputRef}
            hidden
            type="file"
            accept={SUPPORTED_IMAGE_TYPES.join(",")}
            multiple
            disabled={turnControlsDisabled || !imageInputSupported}
            aria-label="Choose images"
            tabIndex={-1}
            onChange={(event) => {
              addAttachments(Array.from(event.target.files ?? []), "images");
              event.target.value = "";
            }}
          />
          <input
            ref={attachmentInputRef}
            hidden
            type="file"
            multiple
            disabled={turnControlsDisabled}
            aria-label="Choose files"
            tabIndex={-1}
            onChange={(event) => {
              addAttachments(Array.from(event.target.files ?? []), "files");
              event.target.value = "";
            }}
          />
          {running ? (
            <button
              type="button"
              className="composer-image-action composer-action--stop"
              title="Stop turn"
              aria-label="Stop turn"
              disabled={disabled || sending}
              onClick={() => void onStop()}
            >
              <Square size={14} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <div className="composer-add-control" ref={addControlRef}>
              <button
                type="button"
                className="composer-image-action"
                title="Add attachment"
                aria-label="Add attachment"
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                disabled={turnControlsDisabled}
                onClick={() => setAddMenuOpen((open) => !open)}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
              {addMenuOpen && (
                <div className="composer-add-menu" role="menu" aria-label="Add attachment">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!imageInputSupported}
                    title={imageInputSupported ? "Add images" : "Selected model does not support images"}
                    onClick={() => {
                      setAddMenuOpen(false);
                      imageInputRef.current?.click();
                    }}
                  >
                    <ImagePlus size={15} aria-hidden="true" />
                    Add images
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAddMenuOpen(false);
                      attachmentInputRef.current?.click();
                    }}
                  >
                    <FileUp size={15} aria-hidden="true" />
                    Add files
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className="composer-image-action composer-queue-action"
            title={images.length + files.length > 0
              ? "Remove attachments to save for later"
              : "Save for later"}
            aria-label="Save for later"
            disabled={!canEnqueue}
            onClick={() => void enqueue()}
          >
            {sending && inFlightSubmission?.mode === "queue"
              ? <LoaderCircle className="composer-spinner" size={15} aria-hidden="true" />
              : <ListPlus size={15} aria-hidden="true" />}
          </button>
          <label
            className={`composer-approval-toggle${autoRunNextTurn ? " composer-approval-toggle--active" : ""}`}
            title={!autoRunAvailable
              ? "Choose an idle thread or finish configuring a new one before enabling one-turn auto mode"
              : settings.sandbox === "external"
                ? "This thread uses an externally managed sandbox"
                : autoRunNextTurn && running
                  ? "Run without workspace restrictions; ask only when confirmation is still required"
                  : "Run the next turn without workspace restrictions; ask only when confirmation is still required"}
          >
            <ShieldOff size={13} aria-hidden="true" />
            <input
              type="checkbox"
              aria-label="Automatic mode for next turn"
              checked={autoRunNextTurn}
              disabled={autoRunDisabled}
              onChange={(event) => onAutoRunNextTurnChange(event.target.checked)}
            />
            <span className="composer-approval-toggle__track" aria-hidden="true">
              <span />
            </span>
          </label>
          <label className="composer-setting" title="Model for the next turn">
            <Sparkles size={12} aria-hidden="true" />
            <select
              aria-label="Model for next turn"
              disabled={turnControlsDisabled || (!settings.model && models.length === 0)}
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
              disabled={turnControlsDisabled || (!settings.effort && efforts.length === 0)}
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
        <button
          type="button"
          className="composer-action"
          title={running ? "Steer active turn" : "Send message"}
          aria-label={running ? "Steer active turn" : "Send message"}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {sending
            ? <LoaderCircle className="composer-spinner" size={16} aria-hidden="true" />
            : <Send size={16} aria-hidden="true" />}
        </button>
      </div>
      {failedSubmission && (
        <div className="composer-failed-submission" role="alert">
          <span className="composer-failed-copy">
            <strong>{failedSubmission.mode === "steer"
              ? "Guidance not confirmed"
              : failedSubmission.mode === "queue"
                ? "Message not saved"
                : "Message not confirmed"}</strong>
            {failedSubmission.error && <span className="composer-failed-error">{failedSubmission.error}</span>}
            {failedSubmission.mode === "steer" && (
              !running || activeTurnId !== failedSubmission.expectedTurnId
            ) && (
              <span className="composer-failed-error">
                The original turn is no longer active; this guidance cannot be retried.
              </span>
            )}
            <span className="composer-failed-preview">
              {failedSubmission.text
                ? `${failedSubmission.text.slice(0, 160)}${failedSubmission.text.length > 160 ? "..." : ""}`
                : "Attachment-only message"}
              {failedSubmission.images.length > 0 && (
                ` · ${failedSubmission.images.length} image${failedSubmission.images.length === 1 ? "" : "s"}`
              )}
              {failedSubmission.files.length > 0 && (
                ` · ${failedSubmission.files.length} file${failedSubmission.files.length === 1 ? "" : "s"}`
              )}
            </span>
          </span>
          <button
            type="button"
            className="composer-failed-action"
            title={failedSubmission.mode === "steer"
              ? "Retry unconfirmed guidance"
              : failedSubmission.mode === "queue"
                ? "Retry saving message"
                : "Retry unconfirmed message"}
            aria-label={failedSubmission.mode === "steer"
              ? "Retry unconfirmed guidance"
              : failedSubmission.mode === "queue"
                ? "Retry saving message"
                : "Retry unconfirmed message"}
            disabled={disabled || sending || (failedSubmission.mode === "start"
              ? running
              : failedSubmission.mode === "steer"
                ? !running || activeTurnId !== failedSubmission.expectedTurnId
                : !onEnqueue)}
            onClick={() => void sendSubmission(failedSubmission)}
          >
            {sending
              ? <LoaderCircle className="composer-spinner" size={15} aria-hidden="true" />
              : <RotateCcw size={15} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="composer-failed-action"
            title={failedSubmission.mode === "steer"
              ? "Discard unconfirmed guidance"
              : failedSubmission.mode === "queue"
                ? "Discard unsaved message"
                : "Discard unconfirmed message"}
            aria-label={failedSubmission.mode === "steer"
              ? "Discard unconfirmed guidance"
              : failedSubmission.mode === "queue"
                ? "Discard unsaved message"
                : "Discard unconfirmed message"}
            disabled={sending}
            onClick={discardFailedSubmission}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {(attachmentError || (images.length > 0 && !imageInputSupported)) && (
        <div className="composer-error" role="alert">
          {attachmentError || "Selected model does not support image input"}
        </div>
      )}
    </div>
  );
}
