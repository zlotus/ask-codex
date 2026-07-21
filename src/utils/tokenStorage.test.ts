import { beforeEach, describe, expect, it } from "vitest";
import { loadStoredToken, saveStoredToken } from "./tokenStorage";

describe("token storage", () => {
  beforeEach(() => sessionStorage.clear());

  it("migrates the legacy browser key exactly once", () => {
    sessionStorage.setItem("ASK_AGENT_TOKEN", "legacy-secret");

    expect(loadStoredToken()).toBe("legacy-secret");
    expect(sessionStorage.getItem("ASK_CODEX_TOKEN")).toBe("legacy-secret");
    expect(sessionStorage.getItem("ASK_AGENT_TOKEN")).toBeNull();
    expect(loadStoredToken()).toBe("legacy-secret");
  });

  it("saves and clears the current token key", () => {
    saveStoredToken("current-secret");
    expect(loadStoredToken()).toBe("current-secret");

    saveStoredToken("");
    expect(loadStoredToken()).toBe("");
  });
});
