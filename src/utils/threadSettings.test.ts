import { describe, expect, it } from "vitest";
import type { ModelInfo, ThreadSettings } from "../types/protocol";
import {
  configuredTurnSettings,
  existingThreadResumeParams,
  newThreadSettings,
  nextTurnOverrides,
  normalizeEffortForModel,
} from "./threadSettings";

const models: ModelInfo[] = [{
  model: "gpt-5",
  displayName: "GPT-5",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
  defaultReasoningEffort: "high",
  isDefault: true,
}];

const current: ThreadSettings = {
  cwd: "/current",
  model: "gpt-5",
  effort: "high",
  sandbox: "danger-full-access",
};

describe("thread settings helpers", () => {
  it("starts every new-thread dialog in workspace-write without losing next-turn model settings", () => {
    expect(newThreadSettings("/default", current)).toEqual({
      cwd: "/default",
      model: "gpt-5",
      effort: "high",
      sandbox: "workspace-write",
    });
    expect(newThreadSettings("", current)).toEqual({
      cwd: "",
      model: "gpt-5",
      effort: "high",
      sandbox: "workspace-write",
    });
  });

  it("only sends an explicitly selected sandbox when resuming an existing thread", () => {
    expect(existingThreadResumeParams("thread-1", null, "workspace-write")).toEqual({
      threadId: "thread-1",
      excludeTurns: true,
      approvalPolicy: "on-request",
    });
    expect(existingThreadResumeParams("thread-1", "read-only", "workspace-write")).toEqual({
      threadId: "thread-1",
      excludeTurns: true,
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(existingThreadResumeParams("thread-1", "workspace-write", "external")).not.toHaveProperty("sandbox");
  });

  it("keeps supported effort and selects a real fallback for a new model", () => {
    expect(normalizeEffortForModel(models, "gpt-5", "high")).toBe("high");
    expect(normalizeEffortForModel(models, "gpt-5", "xhigh")).toBe("high");
  });

  it("prefers configured values and falls back to explicit catalog values", () => {
    expect(configuredTurnSettings({ model: "configured", effort: "max" }, models)).toEqual({
      model: "configured",
      effort: "max",
    });
    expect(configuredTurnSettings({ model: null, effort: null }, models)).toEqual({
      model: "gpt-5",
      effort: "high",
    });
  });

  it("sends only the explicit selections held by the UI", () => {
    expect(nextTurnOverrides({ model: " gpt-5 ", effort: " low " })).toEqual({
      model: "gpt-5",
      effort: "low",
    });
    expect(nextTurnOverrides({ model: "", effort: "" })).toEqual({});
  });
});
