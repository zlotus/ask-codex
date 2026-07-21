const TOKEN_KEY = "ASK_CODEX_TOKEN";
const LEGACY_TOKEN_KEY = "ASK_AGENT_TOKEN";

export function loadStoredToken(storage: Storage = sessionStorage): string {
  const current = storage.getItem(TOKEN_KEY);
  const legacy = storage.getItem(LEGACY_TOKEN_KEY);
  if (!current && legacy) storage.setItem(TOKEN_KEY, legacy);
  storage.removeItem(LEGACY_TOKEN_KEY);
  return current ?? legacy ?? "";
}

export function saveStoredToken(token: string, storage: Storage = sessionStorage): void {
  if (token) storage.setItem(TOKEN_KEY, token);
  else storage.removeItem(TOKEN_KEY);
}
