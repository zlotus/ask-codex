import { beforeEach, describe, expect, it } from "vitest";
import { loadStoredToken, saveStoredToken } from "./tokenStorage";

describe("token storage", () => {
  beforeEach(() => sessionStorage.clear());

  it("loads the current token key", () => {
    sessionStorage.setItem("ASK_CODEX_TOKEN", "current-secret");

    expect(loadStoredToken()).toBe("current-secret");
  });

  it("saves and clears the current token key", () => {
    saveStoredToken("current-secret");
    expect(loadStoredToken()).toBe("current-secret");

    saveStoredToken("");
    expect(loadStoredToken()).toBe("");
  });
});
