import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AskCodexServer, loadConfig } from "./server.js";

export { CodexAppServer, CodexRpcError } from "./codex-app-server.js";
export { AskCodexServer, loadConfig } from "./server.js";
export * from "./file-downloads.js";
export * from "./rpc-policy.js";
export * from "./server-request-policy.js";
export * from "./security.js";
export * from "./thread-ownership.js";
export * from "./types.js";

function isEntrypoint(): boolean {
  const script = process.argv[1];
  return Boolean(script) && resolve(script) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  let service: AskCodexServer;
  try {
    service = new AskCodexServer(loadConfig());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    throw error;
  }

  service.start().then(({ url }) => {
    console.log(`Ask Codex listening at ${url}`);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

  const shutDown = (): void => {
    void service.close().finally(() => process.exit());
  };
  process.once("SIGINT", shutDown);
  process.once("SIGTERM", shutDown);
}
