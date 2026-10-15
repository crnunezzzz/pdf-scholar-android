// Android implementation of the PdfxApi platform surface (docs/ANDROID.md).
//
// The Android app is the renderer running in a Capacitor WebView. Like the
// browser extension (extension-api.ts) it is an OVERLAY on the web fallback
// (`base`): annotations already go through the in-browser EmbedPDF engine
// (annotation-engine-browser.ts — the same pdfium the desktop uses), settings,
// positions and bookmarks already live in localStorage. What this module adds
// is everything that needs the device:
//
// - documents: the system file picker (Storage Access Framework). A picked
//   document is identified by its `content://` URI, which is what the tabs,
//   recents and reading positions key on. The native side takes a persistable
//   grant, so a recent stays reopenable — and saveable in place — after a
//   restart. Bytes travel through a cache file the WebView fetches, not
//   through the JS bridge (a 40 MB paper as base64 would stall it).
// - «Open with» from other apps: an ACTION_VIEW intent becomes onOpenPath.
// - saving: in place over the picked document, or a «Save as» picker.
// - the tab strip's session, recents and the library's grid pictures.
// - printing through Android's print service, fullscreen as immersive mode.
// - real AI with the user's own key, the same core as the extension
//   (extension-ai.ts; keys sealed with WebCrypto, stored in localStorage).
//
// The native half is android/app/src/main/java/.../PdfFilesPlugin.java.
import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle } from '@capacitor/core'
import type {
  FileError,
  FilePayload,
  PdfxApi,
  ReadingPosition,
  RecentFile,
  RecentThumbView,
  SessionWindow,
  Settings
} from '../../shared/types'
import {
  normalizeRecents,
  pinRecent,
  recordRecent as recordRecentRule,
  removeRecent,
  restoreRecent,
  trimRecents
} from '../../shared/recents'
import {
  RECENT_THUMB_READ_MAX_BYTES,
  sanitizeRecentThumb,
  staleThumbPaths
} from '../../shared/recent-thumbs'
import { restorePlan, sanitizeSessionWindow } from '../../shared/session'
import { cleanAttachmentName } from '../../shared/attachments'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { forgetRecentThumbs, loadRecentThumbs, saveRecentThumb } from './extension-recent-thumbs'
import { createExtensionAi } from './extension-ai'
import { store } from './extension-store'
import { browserCurrentBytes } from './annotation-engine-browser'

/** True inside the Android app (Capacitor's native bridge is present) */
export function isAndroidContext(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

interface PickResult {
  cancelled?: boolean
  uri?: string
  name?: string
  /** Absolute path of the cache copy the WebView reads the bytes from */
  file?: string
  /** The grant covers writing back to `uri` */
  writable?: boolean
}

interface PdfFilesPlugin {
  /** ACTION_OPEN_DOCUMENT for PDFs; copies the pick into the cache */
  pick(): Promise<PickResult>
  /** Copy an already-granted URI into the cache */
  read(opts: { uri: string }): Promise<PickResult>
  /** Overwrite `uri` with the bytes (base64) */
  write(opts: { uri: string; data: string }): Promise<void>
  /** ACTION_CREATE_DOCUMENT, then write the bytes there */
  create(opts: { name: string; mime: string; data: string }): Promise<PickResult>
  /** Hand the bytes to another app (share sheet) */
  share(opts: { name: string; mime: string; data: string }): Promise<void>
  /** Android's print service, with the PDF bytes as the document */
  print(opts: { name: string; data: string }): Promise<void>
  /** Open a URL in the user's browser */
  openUrl(opts: { url: string }): Promise<void>
  /** The document the app was launched to open (ACTION_VIEW), handed out once */
  takePendingUri(): Promise<{ uri?: string }>
  /** Immersive mode: status and navigation bars hidden, a swipe from the
   *  edge shows them for a moment and they hide again by themselves */
  setImmersive(opts: { on: boolean }): Promise<void>
  addListener(event: 'openUri', cb: (e: { uri: string }) => void): Promise<{ remove(): Promise<void> }>
  /** The back button ended immersive mode */
  addListener(event: 'fullscreenExit', cb: () => void): Promise<{ remove(): Promise<void> }>
}

const PdfFiles = registerPlugin<PdfFilesPlugin>('PdfFiles')

const K_RECENTS = 'pdfx-android-recents'
const K_NAMES = 'pdfx-android-names'
const K_SESSION = 'pdfx-android-session'
const K_POSITIONS_WEB = 'pdfx-web-state'

/** Paths the native picker hands out (and the app keys documents on) */
const isDeviceUri = (path: string): boolean => /^(content|file):\/\//.test(path)

// ---------- small helpers ----------

function toBase64(data: Uint8Array): string {
  // Chunked: String.fromCharCode(...bigArray) overflows the call stack
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < data.length; i += step) {
    binary += String.fromCharCode(...data.subarray(i, i + step))
  }
  return btoa(binary)
}

function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    bib: 'application/x-bibtex',
    ris: 'application/x-research-info-systems',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  return map[ext] ?? 'application/octet-stream'
}

function failure(err: unknown): FileError {
  const message = err instanceof Error ? err.message : String(err)
  return { error: message }
}

const isCancel = (err: unknown): boolean =>
  /cancel/i.test(err instanceof Error ? err.message : String(err))

/** Read the cache copy the native side wrote, through the WebView's local server */
async function readCacheFile(file: string, max = Infinity): Promise<Uint8Array | null> {
  const res = await fetch(Capacitor.convertFileSrc(file))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  if (buf.byteLength > max) return null
  return new Uint8Array(buf)
}

// ---------- names, recents, session ----------

/** Display names by URI: a content URI carries no readable file name, and the
 *  recents row, the tab and a restored session all need one before the file is
 *  read again. */
async function nameOf(path: string): Promise<string> {
  const names = await store.get<Record<string, string>>(K_NAMES, {})
  if (names[path]) return names[path]
  const tail = decodeURIComponent(path.split('/').pop() ?? path)
  return tail.split(':').pop() || tail
}

async function rememberName(path: string, name: string): Promise<void> {
  const names = await store.get<Record<string, string>>(K_NAMES, {})
  if (names[path] === name) return
  store.set(K_NAMES, { ...names, [path]: name })
}

async function loadRecents(): Promise<RecentFile[]> {
  return normalizeRecents(await store.get<unknown>(K_RECENTS, []))
}

async function updateRecents(change: (list: RecentFile[]) => RecentFile[]): Promise<RecentFile[]> {
  const next = change(await loadRecents())
  store.set(K_RECENTS, next)
  return next
}

function recordRecent(path: string, name: string): void {
  void rememberName(path, name)
  void updateRecents((list) => recordRecentRule(list, path, name, Date.now()))
}

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(K_POSITIONS_WEB) ?? '{}')
    return { ...DEFAULT_SETTINGS, ...raw.settings }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function loadPositions(): Record<string, ReadingPosition> {
  try {
    return JSON.parse(localStorage.getItem(K_POSITIONS_WEB) ?? '{}').positions ?? {}
  } catch {
    return {}
  }
}

// ---------- the API ----------

export function createAndroidApi(base: PdfxApi): PdfxApi {
  const openListeners = new Set<(path: string) => void>()
  const fullscreenListeners = new Set<(on: boolean) => void>()
  /** URIs whose grant does not cover writing (a file another app shared to us
   *  read-only): saving one goes through «Save as» instead */
  const readOnly = new Set<string>()

  const notifyFullscreen = (on: boolean): void => {
    // Never synchronously: setFullscreen is called from inside a React state
    // updater, where another component's setState must not run
    queueMicrotask(() => {
      for (const cb of fullscreenListeners) cb(on)
    })
  }

  void PdfFiles.addListener('openUri', ({ uri }) => {
    for (const cb of openListeners) cb(uri)
  }).catch(() => {})
  void PdfFiles.addListener('fullscreenExit', () => notifyFullscreen(false)).catch(() => {})

  const payloadFrom = async (res: PickResult): Promise<FilePayload | FileError | null> => {
    if (res.cancelled || !res.uri || !res.file) return null
    const data = await readCacheFile(res.file)
    if (!data) return { error: 'read failed' }
    const name = res.name || (await nameOf(res.uri))
    if (res.writable === false) readOnly.add(res.uri)
    else readOnly.delete(res.uri)
    recordRecent(res.uri, name)
    return { path: res.uri, name, data }
  }

  /** Save `data` to a new document the reader picks; null when they cancel */
  const createDocument = async (
    name: string,
    data: Uint8Array
  ): Promise<{ path: string } | FileError | null> => {
    try {
      const res = await PdfFiles.create({ name, mime: mimeFor(name), data: toBase64(data) })
      if (res.cancelled || !res.uri) return null
      if (res.name) void rememberName(res.uri, res.name)
      return { path: res.uri }
    } catch (err) {
      return isCancel(err) ? null : failure(err)
    }
  }

  const setFullscreen = (on: boolean): void => {
    void PdfFiles.setImmersive({ on }).catch(() => {})
    notifyFullscreen(on)
  }

  return {
    ...base,

    // Real multi-provider AI with the reader's own key — the extension's
    // implementation, whose storage shim falls back to localStorage here.
    // Provider calls go straight from the WebView (CORS-open APIs only; see
    // docs/ANDROID.md).
    ...createExtensionAi(),

    // ---------- Documents ----------

    openFileDialog: async () => {
      try {
        return await payloadFrom(await PdfFiles.pick())
      } catch (err) {
        return isCancel(err) ? null : failure(err)
      }
    },

    readFile: async (path) => {
      if (!isDeviceUri(path)) return base.readFile(path)
      try {
        const res = await PdfFiles.read({ uri: path })
        const payload = await payloadFrom({ ...res, uri: path })
        return payload ?? { error: 'not found' }
      } catch (err) {
        return failure(err)
      }
    },

    getPendingPath: async () => {
      try {
        return (await PdfFiles.takePendingUri()).uri ?? null
      } catch {
        return null
      }
    },

    onOpenPath: (cb) => {
      openListeners.add(cb)
      return () => {
        openListeners.delete(cb)
      }
    },

    // One window on a phone: «new window» opens the document as a tab instead
    newWindow: (path) => {
      if (path) for (const cb of openListeners) cb(path)
    },

    // ---------- Session (the tab strip across launches) ----------

    getPendingSession: async () => {
      const stored = sanitizeSessionWindow(await store.get<unknown>(K_SESSION, null))
      if (!stored) return null
      const [plan] = restorePlan({ windows: [stored] }, loadSettings().restoreSession, isDeviceUri)
      if (!plan) return null
      // A restored tab shows its name before its file is read: hand the names
      // back through the recents store the tab strip reads them from
      return { tabs: plan.tabs, active: plan.active } satisfies SessionWindow
    },
    setSessionTabs: (session) => store.set(K_SESSION, session),

    // ---------- Recents and the library grid ----------

    getRecents: async () => trimRecents(await loadRecents()),
    removeRecent: async (path) => {
      const next = await updateRecents((list) => removeRecent(list, path))
      void forgetRecentThumbs([path])
      return next
    },
    restoreRecent: async (entry, index) => {
      const [clean] = normalizeRecents([entry])
      return clean ? updateRecents((list) => restoreRecent(list, clean, index)) : loadRecents()
    },
    pinRecent: (path, pinned) => updateRecents((list) => pinRecent(list, path, pinned, Date.now())),

    getRecentThumbs: async () => {
      const [recents, stored] = await Promise.all([loadRecents(), loadRecentThumbs()])
      const positions = loadPositions()
      const paths = recents.map((r) => r.path)
      void forgetRecentThumbs(staleThumbPaths(Object.keys(stored), paths))
      const out: Record<string, RecentThumbView> = {}
      for (const path of paths) {
        const thumb = stored[path]
        if (!thumb) continue
        const page = positions[path]?.page
        out[path] = page === undefined ? thumb : { ...thumb, page }
      }
      return out
    },
    setRecentThumb: (path, thumb) => {
      const clean = sanitizeRecentThumb(thumb)
      if (!clean) return
      void loadRecents().then((recents) => {
        if (recents.some((r) => r.path === path)) void saveRecentThumb(path, clean)
      })
    },
    // Read without filing the document as just opened (readFile would)
    readRecentForThumb: async (path) => {
      if (!isDeviceUri(path)) return null
      const recents = await loadRecents()
      if (!recents.some((r) => r.path === path)) return null
      try {
        const res = await PdfFiles.read({ uri: path })
        return res.file ? await readCacheFile(res.file, RECENT_THUMB_READ_MAX_BYTES) : null
      } catch {
        return null // moved, deleted, or the grant is gone
      }
    },

    // ---------- Saving ----------

    saveDocumentBytes: async (path, name, data) => {
      if (isDeviceUri(path) && !readOnly.has(path)) {
        try {
          await PdfFiles.write({ uri: path, data: toBase64(data) })
          return { path }
        } catch {
          // The grant does not cover writing after all: offer a copy instead
          readOnly.add(path)
        }
      }
      return createDocument(name, data)
    },
    saveFileAs: (defaultName, data) => createDocument(defaultName, data),
    saveTextFile: (defaultName, content) =>
      createDocument(
        defaultName,
        typeof content === 'string' ? new TextEncoder().encode(content) : content
      ),

    // Embedded files: «save» picks a place for it, «open» hands it to the
    // app the reader chooses (the share sheet — Android decides who may)
    saveAttachment: (name, data) => createDocument(cleanAttachmentName(name), data),
    saveAttachments: async (files) => {
      let count = 0
      for (const file of files) {
        const res = await createDocument(cleanAttachmentName(file.name), file.data)
        if (!res) break
        if ('error' in res) return res
        count++
      }
      return count ? { folder: '', count } : null
    },
    openAttachment: async (name, data) => {
      try {
        const clean = cleanAttachmentName(name)
        await PdfFiles.share({ name: clean, mime: mimeFor(clean), data: toBase64(data) })
        return { ok: true }
      } catch (err) {
        return failure(err)
      }
    },

    // The live document, annotations included — the same bytes a save writes
    printFile: async (path) => {
      try {
        const bytes = (await browserCurrentBytes(path)) ?? null
        let data = bytes
        if (!data) {
          const res = await PdfFiles.read({ uri: path })
          data = res.file ? await readCacheFile(res.file) : null
        }
        if (!data) return { error: 'nothing to print' }
        await PdfFiles.print({ name: await nameOf(path), data: toBase64(data) })
        return { ok: true }
      } catch (err) {
        return failure(err)
      }
    },

    openExternal: (url) => {
      if (!/^(https?|mailto):/i.test(url)) return
      void PdfFiles.openUrl({ url }).catch(() => {})
    },

    // ---------- Window chrome ----------

    setFullscreen,
    onFullScreen: (cb) => {
      fullscreenListeners.add(cb)
      return () => {
        fullscreenListeners.delete(cb)
      }
    },
    // The status bar follows the app's chrome: light icons on a dark theme
    setTitleBarColors: (color) => {
      void SystemBars.setStyle({
        style: isDarkColor(color) ? SystemBarsStyle.Dark : SystemBarsStyle.Light
      }).catch(() => {})
    },

    // No detached windows on a phone: the assistant stays docked
    openAssistant: () => {}
  }
}

/** Relative luminance below the midpoint, for a #rrggbb / rgb() colour */
function isDarkColor(color: string): boolean {
  let r = 255
  let g = 255
  let b = 255
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())
  const rgb = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color)
  if (hex) {
    const n = parseInt(hex[1], 16)
    r = n >> 16
    g = (n >> 8) & 255
    b = n & 255
  } else if (rgb) {
    r = Number(rgb[1])
    g = Number(rgb[2])
    b = Number(rgb[3])
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}
