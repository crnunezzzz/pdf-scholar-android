// Small async key/value store for the browser-extension target: chrome.storage
// .local when running as a real extension, localStorage otherwise (plain-page
// dev). Shared by extension-api.ts (settings/positions/recents) and
// extension-ai.ts (AI config + keys) so there is one storage shim, not two —
// and by the Android app (android-api.ts), whose WebView has no `chrome` global
// at all: a bare `chrome?.storage` would throw a ReferenceError there, hence
// the typeof guard in front of each.
export const store = {
  async get<T>(key: string, fallback: T): Promise<T> {
    if (typeof chrome !== 'undefined' && chrome?.storage) {
      const got = await chrome.storage.local.get(key)
      return (got[key] as T) ?? fallback
    }
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown): void {
    if (typeof chrome !== 'undefined' && chrome?.storage) {
      void chrome.storage.local.set({ [key]: value })
    } else {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* ignore quota/serialization errors — parity with web fallback */
      }
    }
  }
}
