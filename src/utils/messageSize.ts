export const MAX_CLIENT_MESSAGE_BYTES = 900 * 1024;

export function serializeClientMessage(message: unknown): string {
  const serialized = JSON.stringify(message);
  if (serialized === undefined) throw new Error("Client message could not be serialized");
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > MAX_CLIENT_MESSAGE_BYTES) {
    throw new Error("Request is too large to send to Ask Codex");
  }
  return serialized;
}
