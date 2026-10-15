// The Android app on a real Android system (an emulator in CI, or a device on
// USB): the APK installed, documents handed to it the way other apps do, and
// the WebView driven over its DevTools socket — the only test that runs the
// native half (PdfFilesPlugin.java) at all. See docs/ANDROID.md.
//
// What it proves, in order: the WebView is new enough to draw a page; two
// documents opened with «Open with» become two tabs; the two-document split;
// fullscreen hides the system bars, the tab strip and the toolbar, and BACK
// leaves it (the system bars come back); a pen stroke saved IN PLACE reaches
// the file (an /Ink in its bytes); turning the device keeps the split and a
// toolbar that fits; a third document and the three-document mosaic, upright
// and turned, every tile drawing with a toolbar that fits it; a cold restart
// brings all three tabs back. The three are DIFFERENT documents
// (scripts/fixtures/android: title, page count, page shape and font differ),
// and every tab, column and tile is checked for showing its own — a view
// that showed the wrong one would pass a test of copies. Screenshots of each
// state land in android-shots/ (CI uploads them).
//
// Needs adb on PATH and one device/emulator attached, and a debug APK (the
// WebView is only inspectable in a debuggable build).
// Run: node scripts/test-android-device.mjs <path/to/app-debug.apk>
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PKG = 'io.github.crnunezzzz.pdfscholar'
const APK = process.argv[2] ?? 'android/app/build/outputs/apk/debug/app-debug.apk'
const FIXTURES = fileURLToPath(new URL('fixtures/android/', import.meta.url))
/** Each document: the title its first page prints, and its page count */
const DOCS = { 'economia.pdf': ['Economía General II', 3], 'calculo.pdf': ['Matemáticas II', 8], 'historia.pdf': ['Historia del Perú', 2] }
const SHOTS = 'android-shots'
mkdirSync(SHOTS, { recursive: true })

const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!ok) failures++
}
const shot = (name) => {
  writeFileSync(`${SHOTS}/${name}.png`, execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }))
}

// ---------- device ----------

const size = adb('shell', 'wm', 'size')
const density = adb('shell', 'wm', 'density')
console.log(`device: ${adb('shell', 'getprop', 'ro.product.model')}, Android ${adb('shell', 'getprop', 'ro.build.version.release')}, ${size.split('\n').pop()}, ${density.split('\n').pop()}`)
/** Lock the display at a rotation (0..3). `wm user-rotation` is the
 *  supported way on Android 12+; the settings pair is the older one. A tablet's
 *  natural orientation is landscape, so 0 is landscape there and 1 upright. */
function rotate(r) {
  try {
    adb('shell', 'wm', 'user-rotation', 'lock', String(r))
  } catch {
    adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
    adb('shell', 'settings', 'put', 'system', 'user_rotation', String(r))
  }
}
// The tablet's natural landscape first, held still (the test turns it later)
rotate(0)

// Android shows a one-time «Viewing full screen» notice the first time an app
// goes immersive, and that system window holds the key focus until it is
// tapped away — every Back went to it (the tablet runs' window dump:
// mCurrentFocus=ImmersiveModeConfirmation). A person taps «Got it» once; the
// test marks it seen, as Android's own UI tests do.
adb('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed')
adb('install', '-r', '-g', APK)
// The documents in the app's own storage: readable through a file:// intent
// without any storage permission, and writable, so «Save» goes in place
for (const name of Object.keys(DOCS)) {
  adb('push', FIXTURES + name, `/data/local/tmp/${name}`)
  adb('shell', 'run-as', PKG, 'mkdir', '-p', 'files')
  adb('shell', 'run-as', PKG, 'cp', `/data/local/tmp/${name}`, `files/${name}`)
}
const fileUri = (name) => `file:///data/data/${PKG}/files/${name}`
const openWith = (name) =>
  adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-t', 'application/pdf', '-d', fileUri(name), '-n', `${PKG}/.MainActivity`)

// ---------- DevTools over adb ----------

let ws = null
let nextId = 0
const pending = new Map()

async function connect() {
  ws?.close()
  let socket = null
  for (let i = 0; i < 60 && !socket; i++) {
    const unix = adb('shell', 'cat', '/proc/net/unix')
    const pid = adb('shell', 'pidof', PKG)
    socket = new RegExp(`@(webview_devtools_remote_${pid})\\b`).exec(unix)?.[1] ?? null
    if (!socket) await sleep(1000)
  }
  if (!socket) throw new Error('no WebView DevTools socket — is this a debug build?')
  adb('forward', '--remove-all')
  adb('forward', 'tcp:9222', `localabstract:${socket}`)
  let target = null
  for (let i = 0; i < 30 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* not listening yet */
    }
    if (!target) await sleep(1000)
  }
  if (!target) throw new Error('no page target on the DevTools socket')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
  }
}
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
async function ev(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
async function waitFor(expression, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ev(expression).catch(() => false)) return true
    await sleep(300)
  }
  return false
}
/** Centre of the first element matching `selector`, in CSS px, or null */
const centre = (selector) =>
  ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null })()`)
async function touch(points) {
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] })
  for (const p of points.slice(1)) {
    await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] })
    await sleep(16)
  }
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}
async function tap(selector) {
  const c = await centre(selector)
  if (!c) throw new Error(`nothing to tap: ${selector}`)
  await touch([c])
  await sleep(500)
}
const ACTIVE = '.tab-view.active'
const tabNames = () => ev(`[...document.querySelectorAll('.tab-label')].map((e) => e.textContent.trim())`)
const docKeys = () => ev(`[...new Set([...document.querySelectorAll('${ACTIVE} [data-dockey]')].map((e) => e.dataset.dockey))]`)
const toolbarFits = () => ev(`(() => { const t = document.querySelector('${ACTIVE} .toolbar'); return t.scrollWidth <= t.clientWidth + 1 ? true : t.scrollWidth + '>' + t.clientWidth })()`)
const inkDrawn = () =>
  ev(`(() => { const c = [...document.querySelectorAll('${ACTIVE} canvas')].find((x) => x.width > 100); if (!c) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] < 200) n++; return n })()`)
async function waitInk(ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (((await inkDrawn().catch(() => 0)) ?? 0) > 20) return true
    await sleep(400)
  }
  return false
}
/** Does `scope` show `file` — its title in the text of its first pane's pages,
 *  no other document's title there, and its page count in the toolbar? */
async function shows(scope, file) {
  const got = await ev(`(() => { const el = document.querySelector(${JSON.stringify(scope)}); if (!el) return null; const pane = el.querySelector('[data-pane="a"]') ?? el; return { text: [...pane.querySelectorAll('.textLayer')].map((t) => t.textContent).join(' '), count: (el.querySelector('.page-indicator > span')?.textContent ?? '').replace(/\\D/g, '') } })()`)
  const ok = !!got && got.text.includes(DOCS[file][0]) && !Object.entries(DOCS).some(([f, [title]]) => f !== file && got.text.includes(title)) && got.count === String(DOCS[file][1])
  return [ok, got ? `${got.count} pages; «${got.text.slice(0, 24)}»` : 'not there']
}
const showsWhen = async (scope, file, ms = 15000) => {
  await waitFor(`[...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll('.textLayer') ?? [])].some((t) => t.textContent.includes(${JSON.stringify(DOCS[file][0])}))`, ms)
  return shows(scope, file)
}
const nativeLog = () =>
  adb('logcat', '-d', '-s', 'PdfFiles:I').split('\n').filter((l) => /PdfFiles/.test(l)).map((l) => l.replace(/^.*PdfFiles\s*:\s*/, '')).join(' | ')
const fileHas = (name, needle) => {
  try {
    return Number(adb('shell', 'run-as', PKG, 'grep', '-c', needle, `files/${name}`)) > 0
  } catch {
    return false // grep exits 1 on no match
  }
}

// ---------- 1. open with, two tabs ----------

adb('shell', 'am', 'force-stop', PKG)
openWith('economia.pdf')
await connect()
const ua = await ev('navigator.userAgent')
console.log('WebView:', /Chrome\/[\d.]+/.exec(ua)?.[0] ?? ua)
check('the app loaded (not the «update WebView» page)', await waitFor(`!!document.querySelector('.app')`, 30000))
const firstTab = await waitFor(`document.querySelectorAll('.tab-label').length === 1`)
check('«Open with» opened the document as a tab', firstTab, (await tabNames()).join(' | '))
if (!firstTab) {
  // What the native half saw of the launch, and what the page said
  console.log('native:', nativeLog() || '(nothing)')
  console.log('console:', adb('logcat', '-d', '-s', 'Capacitor/Console:*', 'Capacitor:*').split('\n').slice(-25).join('\n'))
}
check('the first page is drawn', await waitInk())
check('the tab shows economia.pdf (3 pages)', ...(await showsWhen(ACTIVE, 'economia.pdf')))
openWith('calculo.pdf')
check('a second «Open with» adds a second tab', await waitFor(`document.querySelectorAll('.tab-label').length === 2`), (await tabNames()).join(' | '))
check('…and it shows calculo.pdf (8 pages), not the first one', ...(await showsWhen(ACTIVE, 'calculo.pdf')))
await waitFor(`!!document.querySelector('${ACTIVE} canvas')`)
await sleep(1500)
const [lw, lh] = await ev('[window.innerWidth, window.innerHeight]')
check('landscape: the WebView is landscape', lw > lh, `${lw}x${lh}`)
check('landscape: the toolbar fits', (await toolbarFits()) === true, String(await toolbarFits()))
shot('1-landscape-two-tabs')

// ---------- 2. two-document split ----------

await tap(`${ACTIVE} .theme-menu-anchor > .tb-btn[title="Zoom and page layout"]`)
const cand = await ev(`(() => { const b = [...document.querySelectorAll('${ACTIVE} .view-menu .menu-action')].find((x) => x.textContent.includes('economia.pdf')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
check('the layout menu offers the other tab for the split', !!cand)
if (cand) {
  await touch([cand])
  await waitFor(`new Set([...document.querySelectorAll('${ACTIVE} [data-dockey]')].map((e) => e.dataset.dockey)).size === 2`)
}
await sleep(1500)
check('split shows the two documents side by side', (await docKeys()).length === 2, (await docKeys()).map((k) => k.split('/').pop()).join(' + '))
const paneShows = async (pane, file) => {
  await waitFor(`[...(document.querySelector('${ACTIVE} [data-pane="${pane}"]')?.querySelectorAll('.textLayer') ?? [])].some((t) => t.textContent.includes(${JSON.stringify(DOCS[file][0])}))`, 15000)
  return ev(`[...(document.querySelector('${ACTIVE} [data-pane="${pane}"]')?.querySelectorAll('.textLayer') ?? [])].map((t) => t.textContent).join(' ').slice(0, 40)`)
}
const paneA = await paneShows('a', 'calculo.pdf'), paneB = await paneShows('b', 'economia.pdf')
check('split: calculo in the left column', paneA.includes(DOCS['calculo.pdf'][0]) && !paneA.includes(DOCS['economia.pdf'][0]), paneA)
check('split: economia in the right column', paneB.includes(DOCS['economia.pdf'][0]) && !paneB.includes(DOCS['calculo.pdf'][0]), paneB)
check('split: the toolbar fits', (await toolbarFits()) === true, String(await toolbarFits()))
shot('2-landscape-split')

// ---------- 3. fullscreen, and Back out of it ----------

const heightBefore = await ev('window.innerHeight')
await tap(`${ACTIVE} .toolbar .tb-btn[title^="Full screen ("]`)
await sleep(1500)
const heightFull = await ev('window.innerHeight')
check('fullscreen: the system bars are gone (the WebView grew)', heightFull > heightBefore, `${heightBefore} → ${heightFull} px`)
check('fullscreen: tab strip and toolbar tucked away', await ev(`document.querySelector('.tab-bar').classList.contains('tucked') && !!document.querySelector('${ACTIVE} .toolbar-wrap.tucked')`))
check('fullscreen: the split stays', (await docKeys()).length === 2)
shot('3-fullscreen')
const top = await ev(`(() => { const r = document.querySelector('${ACTIVE} .pages').getBoundingClientRect(); return { x: r.left + r.width / 3, y: r.top + 30 } })()`)
await touch([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ x: top.x, y: top.y + i * 15 })))
await sleep(600)
check('fullscreen: a swipe down from the top shows the toolbar', await ev(`!document.querySelector('${ACTIVE} .toolbar-wrap.tucked')`))
shot('4-fullscreen-toolbar-revealed')
// What could swallow the first Back: a focused field with the keyboard up
// (Android's first Back only closes the keyboard — the same on a phone)
const focused = await ev(`document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : 'none'`)
const imeShown = /mInputShown=true/.test(adb('shell', 'dumpsys', 'input_method'))
console.log(`before Back: focus ${focused}, keyboard ${imeShown ? 'shown' : 'hidden'}`)
// Which window holds the key focus: a system overlay (the one-time «viewing
// full screen» notice) would take the Back key before the app ever sees it
const focusLines = () => adb('shell', 'dumpsys', 'window').split('\n').filter((l) => /mCurrentFocus|mFocusedApp|mFocusedWindow/.test(l)).map((l) => l.trim()).join(' ; ')
console.log('window focus:', focusLines())
adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
await waitFor(`window.innerHeight === ${heightBefore}`, 6000)
console.log('native:', adb('logcat', '-d', '-s', 'PdfFiles:I').split('\n').filter((l) => /PdfFiles/.test(l)).map((l) => l.replace(/^.*PdfFiles\s*:\s*/, '')).join(' | ') || '(nothing)')
console.log('after Back: resumed', /mResumedActivity.*pdfscholar|topResumedActivity.*pdfscholar/.test(adb('shell', 'dumpsys', 'activity', 'activities')), ', page', await ev('document.visibilityState'), ', fullscreen class', await ev(`document.querySelector('.tab-bar').className`))
const heightAfter = await ev('window.innerHeight')
if (heightAfter !== heightBefore) {
  // What the window manager thinks the bars are doing, for the log
  console.log(adb('shell', 'dumpsys', 'window', 'windows').split('\n').filter((l) => /requestedVisib|mRequestedVisibleTypes|InsetsSource.*(statusBars|navigationBars|tappableElement).*visible/i.test(l)).slice(0, 12).join('\n'))
}
check('Back leaves fullscreen: system bars back', heightAfter === heightBefore, `${heightAfter} px`)
if (heightAfter !== heightBefore) {
  // An experiment for the log, not a check: does a SECOND Back get through
  // (the first one spent on a system overlay)?
  console.log('window focus after Back:', focusLines())
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
  const second = await waitFor(`window.innerHeight === ${heightBefore}`, 6000)
  console.log('second Back:', second ? 'left fullscreen' : 'still fullscreen', '| native:', adb('logcat', '-d', '-s', 'PdfFiles:I').split('\n').filter((l) => /PdfFiles/.test(l)).map((l) => l.replace(/^.*PdfFiles\s*:\s*/, '')).join(' | ') || '(nothing)')
}
check('Back leaves fullscreen: tabs and toolbar back', await ev(`!document.querySelector('.tab-bar').classList.contains('tucked') && !document.querySelector('${ACTIVE} .toolbar-wrap.tucked')`))
check('Back did not leave the app', adb('shell', 'dumpsys', 'activity', 'activities').includes(`${PKG}/.MainActivity`) && (await ev('document.visibilityState')) === 'visible')

// ---------- 4. a pen stroke, saved in place ----------

// The split's own button closes it (inline, or in «…» when the toolbar is
// full): calculo is one document again, its own page count back
const splitBtn = await centre(`${ACTIVE} .toolbar .tb-btn[title^="Split view"]`)
if (splitBtn) await touch([splitBtn])
else {
  await tap(`${ACTIVE} .toolbar button[title="More tools"]`)
  const item = await ev(`(() => { const b = [...document.querySelectorAll('${ACTIVE} .overflow-menu button')].find((x) => x.textContent.trim().startsWith('Split view')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (item) await touch([item])
}
await waitFor(`!document.querySelector('${ACTIVE} [data-pane="b"]')`, 6000)
check('the split closes: calculo alone again (8 pages)', ...(await shows(ACTIVE, 'calculo.pdf')))
// Economia's own tab, so the stroke lands in that file
await tap(`.tab-label`) // economia's tab
await waitFor(`new Set([...document.querySelectorAll('${ACTIVE} [data-dockey]')].map((e) => e.dataset.dockey)).size === 1`)
await sleep(800)
check('economia\'s tab shows economia again', ...(await showsWhen(ACTIVE, 'economia.pdf')))
check('before: no ink annotation in economia.pdf', !fileHas('economia.pdf', '/Ink'))
const pen = await centre(`${ACTIVE} .toolbar .tb-btn[title^="Pen ("]`)
check('the pen is in the toolbar', !!pen)
if (pen) {
  await touch([pen])
  await sleep(400)
  const page = await ev(`(() => { const r = document.querySelector('${ACTIVE} .pdf-page').getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.3, w: r.width } })()`)
  await touch(Array.from({ length: 20 }, (_, i) => ({ x: page.x + i * (page.w / 60), y: page.y + Math.sin(i / 3) * 30 })))
  await sleep(1200)
  await tap(`${ACTIVE} .toolbar .tb-btn[title^="Save changes"]`)
  await sleep(2500)
}
check('Save wrote the stroke into the file itself (/Ink)', fileHas('economia.pdf', '/Ink'))
check('…and into no other file', !fileHas('calculo.pdf', '/Ink') && !fileHas('historia.pdf', '/Ink'))
check('the tab is clean after saving', await ev(`!document.querySelector('.tab-dirty-dot')`))
shot('5-pen-saved')

// ---------- 5. turned upright ----------

rotate(1)
await waitFor('window.innerHeight > window.innerWidth', 8000)
await sleep(1000)
const [w, h] = await ev('[window.innerWidth, window.innerHeight]')
check('portrait: the WebView turned', h > w, `${w}x${h}`)
check('portrait: the toolbar fits', (await toolbarFits()) === true, String(await toolbarFits()))
check('portrait: the page is drawn', await waitInk())
shot('6-portrait')

// ---------- 5b. three documents at once (the mosaic) ----------

openWith('historia.pdf')
check('a third «Open with» adds a third tab', await waitFor(`document.querySelectorAll('.tab-label').length === 3`))
await waitInk()
check('…showing historia.pdf (2 pages)', ...(await showsWhen(ACTIVE, 'historia.pdf')))
await tap(`${ACTIVE} .theme-menu-anchor > .tb-btn[title="Zoom and page layout"]`)
const showThree = await ev(`(() => { const b = [...document.querySelectorAll('${ACTIVE} .view-menu .menu-action')].find((x) => x.textContent.includes('Show three documents')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
check('the layout menu offers «Show three documents»', !!showThree)
const TILES = `.tab-views.mosaic .tab-view[class*="tile-"]`
const tileInk = () =>
  ev(`[...document.querySelectorAll('${TILES}')].map((t) => { const c = [...t.querySelectorAll('canvas')].find((x) => x.width > 50); if (!c) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] < 200) n++; return n })`)
const tileBoxes = () =>
  ev(`Object.fromEntries([...document.querySelectorAll('${TILES}')].map((e) => { const r = e.getBoundingClientRect(); return [[...e.classList].find((c) => /^tile-(main|top|bottom)$/.test(c)), [r.left, r.top, r.width, r.height].map(Math.round)] }))`)
const tilesFit = () => ev(`[...document.querySelectorAll('${TILES} .toolbar')].every((t) => t.scrollWidth <= t.clientWidth + 1)`)
if (showThree) {
  await touch([showThree])
  await waitFor(`document.querySelectorAll('${TILES}').length === 3`)
  await sleep(2500)
  check('mosaic: three documents on screen', (await ev(`document.querySelectorAll('${TILES}').length`)) === 3)
  check('mosaic: every tile draws its page', (await tileInk()).every((n) => n > 10), (await tileInk()).join(','))
  check('mosaic (upright): every toolbar fits its tile', await tilesFit())
  // This tab on the large tile, the strip's next two (wrapping) on the quarters
  for (const [role, file] of [['main', 'historia.pdf'], ['top', 'economia.pdf'], ['bottom', 'calculo.pdf']])
    check(`mosaic: the ${role} tile shows ${file}`, ...(await showsWhen(`.tab-views.mosaic .tile-${role}`, file)))
  const up = await tileBoxes()
  check('mosaic (upright): one on the top half, two quarters below', up['tile-main'][1] < up['tile-top'][1] && up['tile-top'][1] === up['tile-bottom'][1] && up['tile-top'][0] < up['tile-bottom'][0], JSON.stringify(up))
  shot('6b-mosaic-upright')
  rotate(0)
  await waitFor('window.innerWidth > window.innerHeight', 8000)
  await sleep(2000)
  const flat = await tileBoxes()
  check('mosaic (landscape): one on the left half, two quarters on the right', flat['tile-main'][0] < flat['tile-top'][0] && flat['tile-top'][0] === flat['tile-bottom'][0] && flat['tile-top'][1] < flat['tile-bottom'][1], JSON.stringify(flat))
  check('mosaic (landscape): every toolbar fits its tile', await tilesFit())
  check('mosaic (landscape): every tile draws its page', (await tileInk()).every((n) => n > 10))
  shot('6c-mosaic-landscape')
  // A finger drags calculo's tab onto the large tile: calculo and historia
  // trade places (tab-touch-drag.ts on a real touch screen)
  const from = await ev(`(() => { const r = [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('calculo.pdf')).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const to = await centre('.tab-views.mosaic .tile-main')
  await touch(Array.from({ length: 21 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / 20, y: from.y + ((to.y - from.y) * i) / 20 })))
  await sleep(2500)
  for (const [role, file] of [['main', 'calculo.pdf'], ['top', 'economia.pdf'], ['bottom', 'historia.pdf']])
    check(`after a finger drags calculo's tab onto the large tile: ${role} shows ${file}`, ...(await showsWhen(`.tab-views.mosaic .tile-${role}`, file)))
  shot('6d-mosaic-dragged')
  await tap(`.tab-view.focused .theme-menu-anchor > .tb-btn[title="Zoom and page layout"]`)
  const back = await ev(`(() => { const b = [...document.querySelectorAll('.tab-view.focused .view-menu .menu-action')].find((x) => x.textContent.includes('Back to one document')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (back) await touch([back])
  await sleep(1000)
  check('«Back to one document» ends the mosaic', (await ev(`document.querySelectorAll('.tab-views.mosaic').length`)) === 0)
}

// ---------- 6. a cold start brings the tabs back ----------

await sleep(1000) // the strip is reported 300 ms after it changes
adb('shell', 'am', 'force-stop', PKG)
adb('shell', 'am', 'start', '-W', '-n', `${PKG}/.MainActivity`)
await connect()
check('after a restart all three tabs are back', await waitFor(`document.querySelectorAll('.tab-label').length === 3`, 30000), (await tabNames()).join(' | '))
check('…with their names', [...(await tabNames())].join() === 'economia.pdf,calculo.pdf,historia.pdf', (await tabNames()).join(' | '))
check('…and the shown one draws its page', await waitInk(30000))
const shown = (await ev(`document.querySelector('.tab.active .tab-label')?.textContent.trim()`)) ?? ''
if (DOCS[shown]) check(`…its own document (${shown})`, ...(await showsWhen(ACTIVE, shown, 30000)))
else check('…a tab is shown', false, shown)
shot('7-restarted')

// ---------- the WebView's own console ----------

// console.error from the page, as Capacitor relays it (the emulator's own
// GPU chatter under the chromium tag is not ours)
const logcat = adb('logcat', '-d', '-s', 'Capacitor/Console:E')
const errors = logcat.split('\n').filter((l) => /\sE\s/.test(l))
check('no errors in the WebView console', errors.length === 0, errors.slice(0, 3).join(' || '))

ws.close()
try {
  adb('shell', 'wm', 'user-rotation', 'free')
} catch {
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1')
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
