import type { ModelInfo, ThreadSettings } from "../types/protocol";
import { isRecord, readString } from "./protocol";

export function modelForSelection(models: ModelInfo[], modelId: string): ModelInfo | undefined {
  return models.find((model) => model.model === modelId)
    ?? (modelId === "" ? models.find((model) => model.isDefault) : undefined);
}

export function normalizeEffortForModel(
  models: ModelInfo[],
  modelId: string,
  effort: string,
): string {
  const model = modelForSelection(models, modelId);
  if (!model || model.supportedReasoningEfforts.length === 0) return effort;
  return model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)
    ? effort
    : model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0]?.reasoningEffort ?? "";
}

export function configuredTurnSettings(
  result: unknown,
  models: ModelInfo[],
): Pick<ThreadSettings, "model" | "effort"> {
  const config = isRecord(result) ? result : {};
  const configuredModel = readString(config.model)?.trim() ?? "";
  const configuredEffort = readString(config.effort)?.trim() ?? "";
  const fallbackModel = modelForSelection(models, "") ?? models[0];
  const model = configuredModel || fallbackModel?.model || "";
  const selectedModel = modelForSelection(models, model);
  const effort = configuredEffort ||
    selectedModel?.defaultReasoningEffort ||
    selectedModel?.supportedReasoningEfforts[0]?.reasoningEffort ||
    "";
  return { model, effort };
}

export function newThreadSettings(
  initialCwd: string,
  current: ThreadSettings,
): ThreadSettings {
  return {
    cwd: initialCwd,
    model: current.model,
    effort: current.effort,
    sandbox: "workspace-write",
  };
}

export function existingThreadResumeParams(
  threadId: string,
  sandboxOverride: ThreadSettings["sandbox"] | null,
  currentSandbox: ThreadSettings["sandbox"],
): Record<string, unknown> {
  return {
    threadId,
    excludeTurns: true,
    approvalPolicy: "on-request",
    ...(sandboxOverride && sandboxOverride !== "external" && currentSandbox !== "external"
      ? { sandbox: sandboxOverride }
      : {}),
  };
}

export function nextTurnOverrides(
  settings: Pick<ThreadSettings, "model" | "effort">,
): { model?: string; effort?: string } {
  const model = settings.model.trim();
  const effort = settings.effort.trim();
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}
