const TOKEN_KEY = "ASK_CODEX_TOKEN";

export function loadStoredToken(storage: Storage = sessionStorage): string {
  return storage.getItem(TOKEN_KEY) ?? "";
}

export function saveStoredToken(token: string, storage: Storage = sessionStorage): void {
  if (token) storage.setItem(TOKEN_KEY, token);
  else storage.removeItem(TOKEN_KEY);
}
