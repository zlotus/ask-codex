import { describe, expect, it } from "vitest";
import {
  SessionFileAttachmentRegistry,
  sessionFileAttachmentKey,
  type LocalFileAttachment,
} from "./sessionFileAttachments";

function localFile(name: string, contents = name): LocalFileAttachment {
  const blob = new Blob([contents], { type: "text/plain" });
  return {
    blob,
    mediaType: "text/plain",
    name,
    size: blob.size,
  };
}

describe("SessionFileAttachmentRegistry", () => {
  it("keeps ordered file groups and removes only the selected thread", () => {
    const registry = new SessionFileAttachmentRegistry();
    const firstKey = sessionFileAttachmentKey("thread-one", "turn-one");
    const secondKey = sessionFileAttachmentKey("thread-two", "turn-two");

    registry.remember(firstKey, [localFile("first.txt"), localFile("second.txt")]);
    registry.remember(secondKey, [localFile("retained.txt")]);

    expect(registry.removeThread("thread-one")).toEqual({
      [secondKey]: [expect.objectContaining({ name: "retained.txt" })],
    });
  });

  it("rejects malformed groups and evicts the oldest complete group at the file limit", () => {
    const registry = new SessionFileAttachmentRegistry();
    const invalidKey = sessionFileAttachmentKey("thread", "invalid");
    expect(registry.remember(invalidKey, [{
      ...localFile("invalid.txt"),
      size: 999,
    }])).toEqual({});

    for (let index = 0; index < 9; index += 1) {
      registry.remember(
        sessionFileAttachmentKey("thread", `turn-${index}`),
        [localFile(`${index}.txt`, "x")],
      );
    }
    const snapshot = registry.snapshot();
    expect(Object.keys(snapshot)).toHaveLength(8);
    expect(snapshot[sessionFileAttachmentKey("thread", "turn-0")]).toBeUndefined();
    expect(snapshot[sessionFileAttachmentKey("thread", "turn-8")]).toHaveLength(1);
  });
});
