import { describe, expect, it } from "vitest";
import { MAX_CLIENT_MESSAGE_BYTES, serializeClientMessage } from "./messageSize";

describe("client message size", () => {
  it("serializes ordinary protocol messages", () => {
    expect(serializeClientMessage({ type: "rpc", id: "1", params: {} }))
      .toBe('{"type":"rpc","id":"1","params":{}}');
  });

  it("measures UTF-8 bytes before using the WebSocket", () => {
    const multibyte = "你".repeat(Math.ceil(MAX_CLIENT_MESSAGE_BYTES / 3));

    expect(() => serializeClientMessage({ text: multibyte }))
      .toThrow("Request is too large to send to Ask Codex");
  });
});
