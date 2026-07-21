// @vitest-environment node

import { describe, expect, it } from "vitest";
import { sanitizeBrowserRpcParams } from "./rpc-policy.js";

describe("browser RPC policy", () => {
  it("preserves opaque pagination cursors for list methods", () => {
    expect(sanitizeBrowserRpcParams("thread/list", {
      cursor: "next-thread-page",
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: [],
    })).toEqual({
      cursor: "next-thread-page",
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: [],
    });
    expect(sanitizeBrowserRpcParams("model/list", {
      cursor: "next-model-page",
      limit: 100,
    })).toEqual({ cursor: "next-model-page", limit: 100 });
  });

  it("still rejects unrecognized list parameters", () => {
    expect(() => sanitizeBrowserRpcParams("thread/list", { config: {} }))
      .toThrow("does not allow param: config");
  });
});
