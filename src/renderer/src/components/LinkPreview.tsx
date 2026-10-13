// Hover previews of in-document links (issue #31): rest the pointer on a
// citation, a «Figure 3» or an «(2.4)» and a window onto the destination opens
// beside it — the reference entry, the figure, the equation — without moving
// the page you are reading. Click inside it to go there (Ctrl/Cmd+click: the
// other column, exactly like the link itself). The wheel scrolls the window,
// not the page under it.
//
// The pointer choreography lives here; where the window looks and how large it
// is are the pure rules in ../link-preview.ts. The component never touches
// PdfPage's props: PdfPage records each internal anchor in LINK_RECORDS and
// this listens on the viewer root, so a split column showing another file
// previews against ITS document with no extra wiring.
//
// Touch has no hover, so a long-press on a link opens the same window (the
// tap still follows the link); a pen's hover works like the mouse's.
//
// On a citation the footer offers «Sammendrag»: the cited paper's abstract,
// fetched on that click and never before (src/shared/abstract.ts — the app is
// offline unless you ask). The click is in the WINDOW, so the link itself
// still goes to the reference list. Once asked, the window stays put when the
// pointer leaves — it is being read — and grows away from the link.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useDismissable } from '../useDismissable'
import { useResizable } from '../useResizable'
import type { BoxSize } from '../useResizable'
import { t } from '../i18n'
import { bridge } from '../bridge'
import type { CitationAbstract, FileError } from '../../../shared/types'
import { AbstractBody, AbstractSource } from './AbstractView'
import type { AbstractState } from './AbstractView'
import {
  citationEntryText,
  citedRange,
  destLabel,
  destOnFigureCaption,
  entryBox,
  entryLines,
  familySiblings,
  LINK_RECORDS,
  placeExpanded,
  placePreview,
  previewScale,
  previewScroll,
  previewSize,
  rangeEnd,
  resolvePreviewTarget,
  textExtent,
  textLines
} from '../link-preview'
import type { LinkKind, LinkRecord, PreviewTarget } from '../link-preview'

interface Props {
  /** The viewer's root: only links inside it are this component's */
  hostRef: React.RefObject<HTMLElement | null>
  enabled: boolean
  delayMs: number
}

interface Open {
  anchor: HTMLElement
  rec: LinkRecord
  target: PreviewTarget
  pageIndex: number
  kind: LinkKind
  canvas: HTMLCanvasElement
  /** CSS size of the page image */
  pageW: number
  pageH: number
  /** The destination in the image's CSS pixels (null = unnamed) */
  vx: number | null
  vy: number | null
  scroll: { left: number; top: number }
  box: { w: number; h: number }
  at: { left: number; top: number; below: boolean }
  /** The page image's scale — Ctrl+wheel over the window changes it */
  scale: number
  /** The works a cited range («5–9») names: the window holds them all, and
   *  the abstract button stands down (one abstract for five works would be
   *  a guess about which) */
  range: [number, number] | null
  /** Cut to the reference entry itself (a citation whose entry could be
   *  read off the page): no neighbours, no marker, and no scrolling unless
   *  the entry is taller than the window may be */
  entry: boolean
  entryFits: boolean
}

/** What «Sammendrag» found, per document and destination — a second hover on
 *  the same citation shows it again without asking anyone */
const abstractCache = new WeakMap<PDFDocumentProxy, Map<string, CitationAbstract>>()
const destKey = (dest: unknown): string => (typeof dest === 'string' ? dest : JSON.stringify(dest))


/** How long the pointer may be between the link and the window (or off both)
 *  before the window goes: long enough to cross the gap, short enough that
 *  leaving reads as leaving. */
const CLOSE_GRACE_MS = 220
const LONG_PRESS_MS = 450
/** The footer line under the page window, borders included (app.css) */
const FOOT_PX = 27
/** The page part's height once an abstract is in: the whole entry when it
 *  is short (it usually is — the window is cut to it), at most this share
 *  of the screen for a long range, so the abstract gets the rest. The
 *  entry is never compacted to a band (Emil, 2026-10-13: it read as the
 *  abstract covering the reference). */
const PAGE_SHARE_WITH_PANEL = 0.4
const pagePartHeight = (o: Open, hasPanel: boolean, winH: number): number =>
  hasPanel ? Math.min(o.box.h, Math.round(winH * PAGE_SHARE_WITH_PANEL)) : o.box.h
/** Rendered pages kept per document. A paper's citations land on its one to
 *  three reference pages, so a handful makes every hover after the first one
 *  on a page instant. */
const CACHE_PAGES = 4
const MAX_CANVAS_PX = 1 << 24

const pageCache = new WeakMap<PDFDocumentProxy, Map<string, HTMLCanvasElement>>()

async function renderPage(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  scale: number,
  rotation: number
): Promise<{ canvas: HTMLCanvasElement; w: number; h: number; viewport: import('pdfjs-dist').PageViewport }> {
  const page = await pdf.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 })
  const key = `${pageIndex}@${scale.toFixed(3)}r${rotation}`
  let cache = pageCache.get(pdf)
  if (!cache) pageCache.set(pdf, (cache = new Map()))
  const hit = cache.get(key)
  if (hit) {
    // LRU: a hit moves to the back
    cache.delete(key)
    cache.set(key, hit)
    return { canvas: hit, w: viewport.width, h: viewport.height, viewport }
  }
  let dpr = window.devicePixelRatio || 1
  const px = viewport.width * viewport.height * dpr * dpr
  if (px > MAX_CANVAS_PX) dpr *= Math.sqrt(MAX_CANVAS_PX / px)
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width * dpr)
  canvas.height = Math.floor(viewport.height * dpr)
  canvas.className = 'link-preview-canvas'
  await page.render({
    canvas,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
  }).promise
  cache.set(key, canvas)
  while (cache.size > CACHE_PAGES) cache.delete(cache.keys().next().value!)
  return { canvas, w: viewport.width, h: viewport.height, viewport }
}

export default function LinkPreview({ hostRef, enabled, delayMs }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState<Open | null>(null)
  const openRef = useRef<Open | null>(null)
  openRef.current = open
  const boxRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const armTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  /** Bumps on every arm/close so a slow render for an old link never opens */
  const seq = useRef(0)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const delayRef = useRef(delayMs)
  delayRef.current = delayMs
  const [abs, setAbs] = useState<AbstractState>({ state: 'idle' })
  /** Asked for the abstract: the window no longer closes on pointer leave */
  const pinnedRef = useRef(false)
  /** Where the window stands once it has been placed for an abstract or
   *  dragged; null = the hover placement from `open.at` */
  const [placed, setPlaced] = useState<{ left: number; top: number; height: number | null } | null>(null)
  /** Dragged by the reader: their position wins from then on */
  const draggedRef = useRef(false)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /** The corner grip (Emil, 2026-10-13: a figure can be bigger than the
   *  window): sizes the page part; null = the size the rules gave it. A
   *  resized window is being read, so it stays when the pointer leaves. */
  const [size, setSize] = useState<BoxSize | null>(null)
  const { gripProps } = useResizable(
    scrollerRef,
    size,
    (s) => {
      setSize(s)
      pinnedRef.current = true
      clearClose()
    },
    { axis: 'both', minW: 160, minH: 60 }
  )

  const clearArm = (): void => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current)
    armTimer.current = null
  }
  const clearClose = (): void => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const close = useCallback((): void => {
    clearArm()
    clearClose()
    seq.current++
    pinnedRef.current = false
    setOpen(null)
  }, [])
  const scheduleClose = (): void => {
    if (pinnedRef.current) return
    clearClose()
    closeTimer.current = window.setTimeout(close, CLOSE_GRACE_MS)
  }

  /** Resolve, render and place the window for one anchor */
  const show = useCallback(async (anchor: HTMLElement, pointerX: number): Promise<void> => {
    const rec = LINK_RECORDS.get(anchor)
    if (!rec || !anchor.isConnected) return
    const mine = ++seq.current
    const target = await resolvePreviewTarget(rec.pdf, rec.dest)
    if (!target || mine !== seq.current) return
    // The link's own words: a cited range («5–9») shows every entry it names
    const range = target.kind === 'citation' && target.y !== null ? citedRange(linkText(anchor)) : null
    const box = previewSize(target.kind, window.innerWidth, window.innerHeight)
    // Read at the scale that fits the page's column into the window —
    // independent of the document's zoom, which made a fit-width page's
    // window a keyhole onto one column and a fit-page window unreadably small
    // (issue #31, second round). The page's text is measured for it; the
    // same page gives the range its last entry.
    const dstPage = await rec.pdf.getPage(target.pageIndex + 1).catch(() => null)
    let scale = 1.25
    let rangeEndY: number | null = null
    /** The text block's right edge, so the window never starts so far right
     *  that it loses the end of the lines (the destination's x is the
     *  entry's indent, not the block's edge) */
    let blockRight: number | null = null
    /** A citation's own entry (and a range's last one): the window is cut
     *  to exactly these lines */
    let entryRect: { top: number; bottom: number; x0: number; x1: number } | null = null
    if (dstPage) {
      const content = await dstPage.getTextContent().catch(() => null)
      const pageWidth = (dstPage.view[2] ?? 612) - (dstPage.view[0] ?? 0)
      const lines = content ? textLines(content.items) : []
      if (content) {
        const extent = textExtent(lines, pageWidth)
        scale = previewScale(extent.columnW, box.w)
        blockRight = extent.x1
        // A two-column page: the window is one column wide, not two
        if (extent.twoColumn) box.w = Math.max(200, Math.min(box.w, Math.ceil(extent.columnW * scale) + 36))
      }
      if (target.kind === 'citation' && target.y !== null) {
        const siblings = await familySiblings(rec.pdf, target, dstPage)
        const label = destLabel(target.name)
        const count = range ? range[1] - range[0] + 1 : 1
        if (range) rangeEndY = rangeEnd({ x: target.x, y: target.y, n: label }, siblings, count)
        const first = entryLines(lines, { x: target.x, y: target.y }, siblings, label, pageWidth)
        const last =
          range && rangeEndY !== null
            ? entryLines(
                lines,
                { x: target.x, y: rangeEndY },
                siblings,
                label === null ? null : label + count - 1,
                pageWidth
              )
            : []
        entryRect = entryBox([...first, ...last])
        // The entry's own width is what has to fit — a reference list's
        // lines are often wider than the page's measured text block
        if (entryRect) scale = previewScale(entryRect.x1 - entryRect.x0, box.w)
      }
    }
    if (mine !== seq.current) return
    const [img, captionAbove] = await Promise.all([
      renderPage(rec.pdf, target.pageIndex, scale, rec.rotation),
      target.kind === 'figure' && target.y !== null
        ? destOnFigureCaption(rec.pdf, target.pageIndex, target.y)
        : Promise.resolve(false)
    ])
    if (mine !== seq.current || !anchor.isConnected) return
    let vx: number | null = null
    let vy: number | null = null
    if (target.x !== null || target.y !== null) {
      const [px, py] = img.viewport.convertToViewportPoint(target.x ?? 0, target.y ?? img.viewport.viewBox[3])
      vx = target.x === null ? null : px
      vy = target.y === null ? null : py
    }
    const maxH = Math.round(window.innerHeight * 0.6)
    let scroll: { left: number; top: number }
    let entry = false
    let entryFits = false
    if (entryRect) {
      // Cut to the entry: its lines, a little air, nothing of the neighbours
      const [l, t] = img.viewport.convertToViewportPoint(entryRect.x0, entryRect.top)
      const [r, b] = img.viewport.convertToViewportPoint(entryRect.x1, entryRect.bottom)
      const need = Math.ceil(b - t) + 12
      // As wide as the entry needs, within the screen: the 600 px default is
      // a ceiling for page windows, not for a line that must come out whole
      box.w = Math.min(window.innerWidth - 24, Math.ceil(r - l) + 24)
      box.h = Math.max(40, Math.min(need, maxH))
      scroll = { left: Math.max(0, Math.floor(l) - 12), top: Math.max(0, Math.floor(t) - 6) }
      entry = true
      entryFits = need <= maxH
    } else {
      if (range && target.y !== null && vy !== null) {
        // The entry could not be read off the page: a window tall enough for
        // the range, from the first entry to where the last one starts plus
        // a few lines of it; a range past the page shows to the page's foot
        const lastY = rangeEndY ?? (img.viewport.viewBox[1] ?? 0)
        const [, pyLast] = img.viewport.convertToViewportPoint(target.x ?? 0, lastY)
        box.h = Math.max(box.h, Math.min(maxH, Math.ceil(pyLast - vy) + Math.round(52 * scale)))
      }
      // A page narrower than the window: the window narrows to it
      box.w = Math.min(box.w, Math.ceil(img.w))
      scroll = previewScroll(target.kind, vx, vy, box, { w: img.w, h: img.h }, captionAbove)
      // …but never so far right that the lines' ends fall outside it
      if (blockRight !== null) {
        const [edge] = img.viewport.convertToViewportPoint(blockRight, 0)
        scroll.left = Math.max(0, Math.min(scroll.left, Math.ceil(edge) + 12 - box.w))
      }
    }
    const r = anchor.getBoundingClientRect()
    // Placed by its whole height: the page window plus the footer line
    const at = placePreview(r, pointerX, { w: box.w, h: box.h + FOOT_PX }, { w: window.innerWidth, h: window.innerHeight })
    const known = abstractCache.get(rec.pdf)?.get(destKey(rec.dest))
    pinnedRef.current = false
    draggedRef.current = false
    setPlaced(null)
    setSize(null)
    setAbs(known ? { state: 'done', result: known } : { state: 'idle' })
    setOpen({
      anchor,
      rec,
      target,
      pageIndex: target.pageIndex,
      kind: target.kind,
      canvas: img.canvas,
      pageW: img.w,
      pageH: img.h,
      vx,
      vy,
      scroll,
      box,
      scale,
      range,
      entry,
      entryFits,
      at
    })
  }, [])

  // The canvas is cached and shared, so it is mounted by hand, and the
  // window scrolled to the destination once it is in
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!open || !scroller) return
    scroller.querySelector('.link-preview-canvas-host')?.replaceChildren(open.canvas)
    scroller.scrollLeft = open.scroll.left
    scroller.scrollTop = open.scroll.top
  }, [open])

  /** Ctrl+wheel (a pinch, too) over the window: the window's own scale, the
   *  point under its top-left corner kept. «Cropped and no way to zoom out»
   *  was the second-round report on issue #31. */
  const rescale = async (o: Open | null, factor: number): Promise<void> => {
    if (!o) return
    const scale = Math.round(Math.min(3, Math.max(0.5, o.scale * factor)) * 20) / 20
    if (scale === o.scale) return
    const img = await renderPage(o.rec.pdf, o.pageIndex, scale, o.rec.rotation)
    if (openRef.current !== o) return
    const k = scale / o.scale
    const sc = scrollerRef.current
    // Zooming is reading: the window stays when the pointer leaves it
    pinnedRef.current = true
    setOpen({
      ...o,
      scale,
      canvas: img.canvas,
      pageW: img.w,
      pageH: img.h,
      vx: o.vx === null ? null : o.vx * k,
      vy: o.vy === null ? null : o.vy * k,
      scroll: { left: (sc?.scrollLeft ?? o.scroll.left) * k, top: (sc?.scrollTop ?? o.scroll.top) * k }
    })
  }
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !open) return
    // Native and non-passive: preventDefault keeps the page's own ctrl+wheel
    // zoom (and the browser's) out of it, stopPropagation keeps the viewer's
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      rescale(openRef.current, e.deltaY < 0 ? 1.15 : 1 / 1.15).catch(previewFailed)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ---- Pointer choreography, delegated from the viewer root ----
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let press: { anchor: HTMLElement; x: number; y: number; timer: number } | null = null
    /** A long-press that opened the window must not ALSO follow the link */
    let swallowClickUntil = 0

    const anchorOf = (el: EventTarget | null): HTMLElement | null => {
      const a = (el as Element | null)?.closest?.('a.pdf-link.internal') as HTMLElement | null
      return a && LINK_RECORDS.has(a) ? a : null
    }
    const inBox = (el: EventTarget | null): boolean =>
      !!boxRef.current && el instanceof Node && boxRef.current.contains(el)

    const onOver = (e: PointerEvent): void => {
      const a = anchorOf(e.target)
      if (!a) return
      if (!enabledRef.current) {
        // Off: give the link its tooltip back if an earlier hover took it
        if (!a.title && a.dataset.tip) a.title = a.dataset.tip
        return
      }
      // The native tooltip would sit on top of the window
      if (a.title) {
        a.dataset.tip = a.title
        a.setAttribute('aria-label', a.title)
        a.removeAttribute('title')
      }
      if (e.pointerType === 'touch') return
      clearClose()
      if (openRef.current?.anchor === a) return
      clearArm()
      const x = e.clientX
      armTimer.current = window.setTimeout(() => {
        armTimer.current = null
        show(a, x).catch(previewFailed)
      }, delayRef.current)
    }
    const onOut = (e: PointerEvent): void => {
      const a = anchorOf(e.target)
      if (!a || e.pointerType === 'touch') return
      if (anchorOf(e.relatedTarget) === a || inBox(e.relatedTarget)) return
      clearArm()
      if (openRef.current) scheduleClose()
      else seq.current++ // a render still in flight for this link
    }
    const onDown = (e: PointerEvent): void => {
      const a = anchorOf(e.target)
      if (e.pointerType === 'touch' && a && enabledRef.current) {
        const timer = window.setTimeout(() => {
          press = null
          swallowClickUntil = performance.now() + 900
          show(a, e.clientX).catch(previewFailed)
        }, LONG_PRESS_MS)
        press = { anchor: a, x: e.clientX, y: e.clientY, timer }
        return
      }
      // A click on a link follows it — the window has served its purpose
      if (a && !inBox(e.target)) close()
    }
    const endPress = (): void => {
      if (press) window.clearTimeout(press.timer)
      press = null
    }
    const onMove = (e: PointerEvent): void => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) endPress()
    }
    const onClickCapture = (e: MouseEvent): void => {
      // isTrusted: the window's own «go there» is a dispatched click
      if (e.isTrusted && performance.now() < swallowClickUntil && anchorOf(e.target)) {
        e.preventDefault()
        e.stopPropagation()
        swallowClickUntil = 0
      }
    }
    const onContextMenu = (e: MouseEvent): void => {
      // The long-press's own context menu, once it has opened the window
      if (performance.now() < swallowClickUntil && anchorOf(e.target)) e.preventDefault()
    }
    // The page moving under the window detaches it from its link
    const onScroll = (e: Event): void => {
      if (openRef.current && !inBox(e.target)) close()
    }
    host.addEventListener('pointerover', onOver)
    host.addEventListener('pointerout', onOut)
    host.addEventListener('pointerdown', onDown, true)
    host.addEventListener('pointermove', onMove, { passive: true })
    host.addEventListener('pointerup', endPress)
    host.addEventListener('pointercancel', endPress)
    host.addEventListener('click', onClickCapture, true)
    host.addEventListener('contextmenu', onContextMenu, true)
    host.addEventListener('scroll', onScroll, true)
    return () => {
      endPress()
      host.removeEventListener('pointerover', onOver)
      host.removeEventListener('pointerout', onOut)
      host.removeEventListener('pointerdown', onDown, true)
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerup', endPress)
      host.removeEventListener('pointercancel', endPress)
      host.removeEventListener('click', onClickCapture, true)
      host.removeEventListener('contextmenu', onContextMenu, true)
      host.removeEventListener('scroll', onScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostRef, show, close])

  useEffect(() => {
    if (!enabled) close()
  }, [enabled, close])
  useEffect(() => () => {
    clearArm()
    clearClose()
  }, [])

  useDismissable(boxRef, !!open, close)

  // The abstract is in: place the whole window ONCE by what it now needs —
  // before paint, so it never shows at the old size first. Loading changes
  // nothing; this is the single move.
  const hasPanel = abs.state === 'done' || abs.state === 'error'
  useLayoutEffect(() => {
    const panel = panelRef.current
    const box = boxRef.current
    if (!open || !hasPanel || !panel || !box) return
    const need = pagePartHeight(open, true, window.innerHeight) + panel.scrollHeight + FOOT_PX
    const winH = window.innerHeight
    const left = box.getBoundingClientRect().left
    if (draggedRef.current) {
      const top = box.getBoundingClientRect().top
      setPlaced({ left, top, height: Math.min(need, winH - top - 12) })
      return
    }
    const at = placeExpanded(open.anchor.getBoundingClientRect(), need, { h: winH })
    setPlaced({ left, top: at.top, height: at.height })
  }, [open, abs, hasPanel])

  /** The footer is the handle: drag the window aside to read what is under
   *  it. A dragged window stays — leaving it no longer closes it. */
  const footHandle = {
    onPointerDown: (e: React.PointerEvent): void => {
      if ((e.target as Element).closest('button, a')) return
      const r = boxRef.current?.getBoundingClientRect()
      if (!r) return
      dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* a synthetic event has no pointer to capture */
      }
      e.preventDefault()
    },
    onPointerMove: (e: React.PointerEvent): void => {
      const d = dragRef.current
      const r = boxRef.current?.getBoundingClientRect()
      if (!d || !r) return
      draggedRef.current = true
      pinnedRef.current = true
      clearClose()
      const left = Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - r.width - 8))
      const top = Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - r.height - 8))
      setPlaced((p) => ({ left, top, height: p?.height ?? null }))
    },
    onPointerUp: (): void => {
      dragRef.current = null
    }
  }

  /** «Sammendrag»: read the entry off the page, hand its text over */
  const askAbstract = async (o: Open): Promise<void> => {
    pinnedRef.current = true
    clearClose()
    setAbs({ state: 'loading' })
    const entry = await citationEntryText(o.rec.pdf, o.target)
    const result: CitationAbstract | FileError = entry
      ? await bridge.citationAbstract(entry)
      : { error: 'no entry text at the destination', code: 'abstract-unidentified' }
    if (openRef.current !== o) return // the window moved on meanwhile
    if ('error' in result) {
      setAbs({ state: 'error', error: result })
      return
    }
    let cache = abstractCache.get(o.rec.pdf)
    if (!cache) abstractCache.set(o.rec.pdf, (cache = new Map()))
    cache.set(destKey(o.rec.dest), result)
    setAbs({ state: 'done', result })
  }

  if (!open) return null

  /** Go there: the anchor's own click, with the modifiers carried over, so
   *  every rule the link follows (back-stack, Ctrl → other column) holds */
  const follow = (e: React.MouseEvent): void => {
    const a = open.anchor
    close()
    if (!a.isConnected) return
    a.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey })
    )
  }

  const markTop =
    open.vy !== null && !open.entry && open.kind !== 'figure' && open.kind !== 'table' ? open.vy : null
  // Before it is placed for an abstract (or dragged), the hover placement.
  // Opened above its link, the window is held by its BOTTOM, so the footer's
  // «Henter …» never moves it toward the citation.
  const winH = window.innerHeight
  const width = size?.w ?? open.box.w
  const place: React.CSSProperties = placed
    ? { left: placed.left, top: placed.top, width }
    : open.at.below
      ? { left: open.at.left, top: open.at.top, width }
      : { left: open.at.left, bottom: winH - (open.at.top + open.box.h + FOOT_PX), width }
  const pageH = size?.h ?? pagePartHeight(open, hasPanel, winH)
  const panelMax = placed?.height != null ? Math.max(80, placed.height - pageH - FOOT_PX) : undefined
  const canAsk = open.kind === 'citation' && open.target.y !== null && !open.range
  return (
    <div
      ref={boxRef}
      className={`link-preview kind-${open.kind}${open.entry && open.entryFits && !size ? ' is-entry' : ''}`}
      style={place}
      onPointerEnter={clearClose}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'touch' && anchorOfTarget(e.relatedTarget) !== open.anchor) scheduleClose()
      }}
      role="dialog"
      aria-label={t('linkPreview.label', { page: open.pageIndex + 1 })}
    >
      <div
        ref={scrollerRef}
        className="link-preview-scroll"
        style={{ height: pageH }}
        onClick={follow}
        title={t('linkPreview.tip')}
      >
        <div className="link-preview-content" style={{ width: open.pageW, height: open.pageH }}>
          <div className="link-preview-sheet">
            <div className="link-preview-canvas-host" />
          </div>
          {/* Outside the sheet: the theme filter would recolour the accent */}
          {markTop !== null && (
            <div
              className="link-preview-mark"
              style={{ top: markTop, left: Math.max(2, (open.vx ?? 0) - 10) }}
            />
          )}
        </div>
      </div>
      <AbstractBody
        ref={panelRef}
        abs={abs}
        onRetry={() => void askAbstract(open)}
        maxHeight={panelMax}
        // Its own cross: the abstract goes, the entry stays, the window keeps
        // its place (it has been read in, so it stays open as before)
        onClose={() => setAbs({ state: 'idle' })}
      />
      <div className="link-preview-foot" {...footHandle}>
        <span>
          {t('linkPreview.page', { page: open.pageIndex + 1 })}
          {open.range && ` · ${open.range[0]}–${open.range[1]}`}
        </span>
        {canAsk && abs.state === 'idle' && (
          <button
            type="button"
            className="lpa-ask"
            title={t('linkPreview.abstractTip')}
            onClick={() => void askAbstract(open)}
          >
            {t('linkPreview.abstract')}
          </button>
        )}
        {abs.state === 'loading' && <span className="lpa-loading">{t('linkPreview.abstractLoading')}</span>}
        <AbstractSource abs={abs} />
      </div>
      <span className="box-grip link-preview-grip" title={t('bubble.resizeTip')} {...gripProps} />
    </div>
  )
}

/** A preview that cannot be drawn simply does not open; the link still works */
function previewFailed(err: unknown): void {
  console.warn('pdfx: klarte ikke å forhåndsvise lenken', err)
}

function anchorOfTarget(el: EventTarget | null): Element | null {
  return ((el as Element | null)?.closest?.('a.pdf-link.internal') as Element | null) ?? null
}

/** The characters under the link's box, read off the page's text layer:
 *  what the citation itself says («5–9», «[12]»). A link's box often starts
 *  and ends mid-span, so the spans it touches are walked one character at a
 *  time and only the characters inside the box count. */
function linkText(anchor: HTMLElement): string {
  const page = anchor.closest('.pdf-page')
  if (!page) return ''
  const box = anchor.getBoundingClientRect()
  if (box.width === 0) return ''
  const midY = (box.top + box.bottom) / 2
  let out = ''
  const range = document.createRange()
  for (const span of page.querySelectorAll<HTMLElement>('.text-host .textLayer > span')) {
    const r = span.getBoundingClientRect()
    if (r.right < box.left || r.left > box.right || midY < r.top - 2 || midY > r.bottom + 2) continue
    const node = span.firstChild
    if (!node || node.nodeType !== Node.TEXT_NODE) continue
    const text = node.textContent ?? ''
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const c = range.getBoundingClientRect()
      const cx = (c.left + c.right) / 2
      if (cx >= box.left - 1 && cx <= box.right + 1) out += text[i]
    }
  }
  return out
}
