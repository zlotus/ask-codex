import { describe, expect, it } from "vitest";
import { sandboxMode } from "./protocol";

describe("sandboxMode", () => {
  it("maps every current app-server sandbox policy", () => {
    expect(sandboxMode({ type: "workspaceWrite" })).toBe("workspace-write");
    expect(sandboxMode({ type: "readOnly" })).toBe("read-only");
    expect(sandboxMode({ type: "dangerFullAccess" })).toBe("danger-full-access");
    expect(sandboxMode({ type: "externalSandbox" })).toBe("external");
  });
});
