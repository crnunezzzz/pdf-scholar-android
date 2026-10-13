// End-to-end test for a document that changes ON DISK while it is open
// (issue #41: «This should reload the PDF when it changes on disk»).
//
//   npm run test:disk-reload        (needs `npm run build` first)
//
// The cases a reader meets: a LaTeX build writes the PDF they are reading, a
// sync client pulls a newer copy, another program saves over it. main watches
// every open document's folder (src/main/index.ts, «Files changing on disk»),
// waits for the write to finish and tells the windows holding the path; App.tsx
// decides what that means for the tab. Driven through the real app because the
// claim spans the watcher, the IPC, the tab model and the viewer at once:
//
//   1. A tab WITHOUT unsaved marks reloads in place — the page count follows
//      the file — and says so in a notice.
//   2. Our OWN save is not a change: after Save, nothing reloads and the mark
//      is still there (the fingerprint recorded after saveDraft is what keeps
//      the watcher quiet).
//   3. A tab WITH unsaved marks is never reloaded under the reader: a bar
//      offers the reload and «Behold min versjon» puts it away, the marks and
//      the old bytes intact.
//
// The reload-with-marks path ends in a native dialog (Save a copy / Don't save /
// Cancel — the same one re-opening a stale path uses) which CDP cannot drive,
// so it stays a hand check; the dialog itself is older than this feature.
import { existsSync, copyFileSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9341
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
// Its own folder: the watcher is on the FOLDER, and a shared temp dir sees
// writes from everything else on the machine
const DIR = join(tmpdir(), 'pdfx-disk-reload-test')
const FILE = join(DIR, 'watched.pdf')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

/** A one-page PDF with one line of text — a different page count from the
 *  sample, so «reloaded» is a number, not a guess. */
function onePagePdf(line) {
  const text = `BT /F1 14 Tf 72 700 Td (${line}) Tj ET\n`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let body = '%PDF-1.7\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

// ------------------------------------------------------- in-page UI helpers
const PRELUDE = `
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const ui = {
  settle,
  state() {
    const toast = document.querySelector('.app-toast');
    const bar = document.querySelector('.disk-change-bar');
    const save = document.querySelector('.tb-save');
    return {
      pages: document.querySelectorAll('.pdf-page').length,
      rendered: document.querySelectorAll('.pdf-page canvas').length,
      toast: toast ? toast.textContent : null,
      bar: bar ? bar.textContent : null,
      dirty: !!save && !save.disabled,
      marks: document.querySelectorAll('.annotation-marks .annot-mark, .annot-list .margin-note-card').length
    };
  },
  /** Highlight one on-screen line through the real selection menu */
  async highlightFirst() {
    const pages = document.querySelector('.pages[data-pane="a"]');
    const box = pages.getBoundingClientRect();
    const span = [...pages.querySelectorAll('.pdf-page .text-host .textLayer > span')]
      .filter((s) => (s.textContent || '').trim().length > 12)
      .find((s) => {
        const r = s.getBoundingClientRect();
        return r.top > box.top + 40 && r.bottom < box.bottom - 40 && r.width > 60;
      });
    if (!span) throw new Error('no on-screen text to mark up');
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await settle(150);
    const r = sel.getRangeAt(0).getBoundingClientRect();
    pages.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, button: 0, clientX: Math.round(r.right), clientY: Math.round(r.bottom)
    }));
    await settle(400);
    const menu = document.querySelector('.selection-menu');
    if (!menu) throw new Error('selection menu did not open');
    const swatch = menu.querySelector('.menu-color-group .color-dot, .menu-color-group .color-bar');
    if (!swatch) throw new Error('no colour swatch in the selection menu');
    click(swatch);
    await settle(700);
    window.getSelection()?.removeAllRanges();
    return (span.textContent || '').trim().slice(0, 30);
  },
  async save() {
    const b = document.querySelector('.tb-save');
    if (!b || b.disabled) throw new Error('nothing to save');
    click(b);
    await settle(1200);
  },
  async keepMine() {
    const b = [...document.querySelectorAll('.disk-change-bar button')].at(-1);
    if (!b) throw new Error('no bar to dismiss');
    click(b);
    await settle(200);
  }
};
`
const evalIn = (send, body) => evaluate(send, body, PRELUDE)

async function waitUntil(send, ready, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalIn(send, 'return ui.state()')
    if (ready(last)) return last
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`)
}

/** Watch for the notice while something else is awaited: it stays 2.6 s */
async function catchToast(send, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await evalIn(send, 'return ui.state()')
    if (s.toast) return s.toast
    await sleep(120)
  }
  return null
}

async function run() {
  if (!existsSync(SAMPLE)) throw new Error(`missing ${SAMPLE} — run npm run sample`)
  mkdirSync(DIR, { recursive: true })
  copyFileSync(SAMPLE, FILE)
  const samplePages = (readFileSync(SAMPLE, 'latin1').match(/\/Type\s*\/Page[^s]/g) || []).length

  const app = launchApp({
    root: ROOT,
    mainJs: join(ROOT, 'out', 'main', 'index.js'),
    args: [FILE],
    port: PORT
  })
  try {
    const [target] = await waitForPageTargets(PORT, 1)
    const send = cdp(await openSocket(target.webSocketDebuggerUrl))
    await send('Runtime.enable')

    const opened = await waitUntil(send, (s) => s.pages > 0 && s.rendered > 0, 'the document to open')
    check('the sample opens', opened.pages === samplePages, `pages=${opened.pages}, expected ${samplePages}`)

    // ---- 1. clean tab: the file changes → the tab follows it
    // Written the way most programs write: a temp file renamed over the
    // original (LaTeX writes in place, but the fingerprint covers both)
    writeFileSync(`${FILE}.tmp`, onePagePdf('Rebuilt by the test'))
    const toastP = catchToast(send)
    const { renameSync } = await import('node:fs')
    renameSync(`${FILE}.tmp`, FILE)
    const reloaded = await waitUntil(send, (s) => s.pages === 1, 'the clean tab to reload')
    check('a clean tab reloads to what the file now holds', reloaded.pages === 1, `pages=${reloaded.pages}`)
    const toast = await toastP
    check('…and says so', !!toast && /watched\.pdf/.test(toast), toast ?? 'no notice')
    check('no bar for a clean tab', reloaded.bar === null, reloaded.bar ?? '')

    // ---- 2. our own save is not a change
    await waitUntil(send, (s) => s.rendered > 0, 'the one page to render')
    const marked = await evalIn(send, 'return await ui.highlightFirst()')
    const dirty = await evalIn(send, 'return ui.state()')
    check('a highlight makes the tab dirty', dirty.dirty, `marked "${marked}"`)
    await evalIn(send, 'await ui.save()')
    // The watcher's debounce is 300 ms and the wait for a whole file up to 2 s
    await sleep(3000)
    const afterSave = await evalIn(send, 'return ui.state()')
    check('after Save the tab is clean', !afterSave.dirty)
    check('our own save raises no bar', afterSave.bar === null, afterSave.bar ?? '')
    check('our own save raises no notice', afterSave.toast === null, afterSave.toast ?? '')
    check('the page is still the one we had', afterSave.pages === 1, `pages=${afterSave.pages}`)
    // mupdf, not our writer, reads the result: one page, one highlight
    const saved = mupdf.Document.openDocument(readFileSync(FILE), 'application/pdf')
    const savedAnnots = saved.loadPage(0).getAnnotations().length
    check('the saved file is the one-page document, with our mark', saved.countPages() === 1 && savedAnnots === 1, `pages=${saved.countPages()}, annots=${savedAnnots}`)

    // ---- 3. a tab with unsaved marks is offered the reload, never forced
    await evalIn(send, 'return await ui.highlightFirst()')
    check('a second highlight: dirty again', (await evalIn(send, 'return ui.state()')).dirty)
    copyFileSync(SAMPLE, FILE)
    const offered = await waitUntil(send, (s) => s.bar !== null, 'the bar to appear')
    check('a dirty tab gets the bar instead', /watched\.pdf/.test(offered.bar ?? ''), offered.bar ?? '')
    check('…and keeps the version it shows', offered.pages === 1, `pages=${offered.pages}`)
    check('…still dirty', offered.dirty)
    await evalIn(send, 'await ui.keepMine()')
    const kept = await evalIn(send, 'return ui.state()')
    check('«Behold min versjon» puts the bar away', kept.bar === null && kept.pages === 1 && kept.dirty)
  } finally {
    await app.cleanup()
    try {
      unlinkSync(FILE)
    } catch {
      /* leftover temp file is harmless */
    }
  }
}

run()
  .then(() => {
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('\ntest-disk-reload failed:', err)
    process.exit(1)
  })
