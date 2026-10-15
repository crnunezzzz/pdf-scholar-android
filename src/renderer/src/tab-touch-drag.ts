// Dragging a tab with a FINGER or a pen (the Android app, a touch screen).
//
// On the desktop a tab dragged onto the pages opens beside them — the
// two-document split (useDropTarget, the left or right half), or onto a tile of
// the three-document mosaic (App). That is an HTML5 drag, and a touch screen
// never starts one: Chromium on Android gives a finger no drag of an ordinary
// element. So the finger's gesture is turned into the same events here: the
// element under the finger receives dragenter / dragover / dragleave / drop
// carrying the tab's path under TAB_DRAG_MIME, exactly as a mouse drag would
// deliver them. Every drop target in the app works unchanged, hints included.
//
// The gesture: put a finger on a tab and move it — along the strip to reorder,
// out onto the pages to open it there (a strip with more tabs than fit keeps
// its sideways swipe: there the drag starts by pulling down, or after a hold). A tap still selects; a hold released
// without moving opens the tab's menu, which is what a long press on a tab
// means on Android, so that menu stays one long press away.
import { TAB_DRAG_MIME } from './drag-types'

const HOLD_MS = 380
/** How far a finger may wander before a hold stops counting as one */
const SLOP = 10

export interface TabTouchDragOptions {
  path: string
  name: string
  /** The drag has begun (the strip marks the tab as the one moving) */
  onStart(): void
  /** A hold released in place: the tab's menu, at that point */
  onLongPress(x: number, y: number): void
  /** The strip overflows and scrolls sideways: a sideways swipe is a scroll,
   *  and the drag starts only with a pull downward or after the hold */
  stripScrolls: boolean
}

/** Start following a touch or pen press on a tab. Mouse presses are left to
 *  the HTML5 drag; call this from the tab's pointerdown. */
export function startTabTouchDrag(down: PointerEvent, tabEl: HTMLElement, opts: TabTouchDragOptions): void {
  if (down.pointerType === 'mouse' || !down.isPrimary) return
  const x0 = down.clientX
  const y0 = down.clientY
  let started = false
  let moved = false
  let target: Element | null = null
  let accepted = false
  let ghost: HTMLElement | null = null
  const data = new DataTransfer()
  data.setData(TAB_DRAG_MIME, opts.path)
  data.effectAllowed = 'move'

  const fire = (el: Element, type: string, x: number, y: number): boolean =>
    el.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        dataTransfer: data
      })
    )

  const begin = (): void => {
    if (started) return
    started = true
    opts.onStart()
    ghost = document.createElement('div')
    ghost.className = 'tab-touch-ghost'
    ghost.textContent = opts.name
    document.body.append(ghost)
    place(x0, y0)
    navigator.vibrate?.(12)
    // The drag is what this finger now does: nothing else may scroll under it
    window.addEventListener('touchmove', holdStill, { passive: false })
  }

  const place = (x: number, y: number): void => {
    if (ghost) ghost.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }

  const hover = (x: number, y: number): void => {
    // The ghost takes no pointer events, so this is what lies under the finger
    const el = document.elementFromPoint(x, y)
    if (el !== target) {
      if (target) fire(target, 'dragleave', x, y)
      target = el
      if (target) fire(target, 'dragenter', x, y)
    }
    // A target that allows the drop cancels dragover — the browser's own rule
    accepted = target ? !fire(target, 'dragover', x, y) : false
  }

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== down.pointerId) return
    const dx = e.clientX - x0
    const dy = e.clientY - y0
    if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) moved = true
    if (!started) {
      if (!moved) return
      // A strip that scrolls keeps its sideways swipe (the browser has it)
      if (opts.stripScrolls && Math.abs(dx) > Math.abs(dy)) return finish(false)
      // Any other real movement drags: along the strip it reorders, out of it
      // it opens beside the pages
      begin()
    }
    place(e.clientX, e.clientY)
    hover(e.clientX, e.clientY)
  }

  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== down.pointerId) return
    if (started && !moved) {
      finish(false)
      opts.onLongPress(e.clientX, e.clientY)
      return
    }
    if (started && target && accepted) fire(target, 'drop', e.clientX, e.clientY)
    else if (started && target) fire(target, 'dragleave', e.clientX, e.clientY)
    finish(started)
  }

  const onCancel = (e: PointerEvent): void => {
    if (e.pointerId !== down.pointerId) return
    if (started && target) fire(target, 'dragleave', e.clientX, e.clientY)
    finish(started)
  }

  const holdStill = (e: TouchEvent): void => {
    if (e.cancelable) e.preventDefault()
  }

  // The hold itself: Android's own long press (the context menu) comes later
  // and is swallowed below while this gesture owns the finger
  const timer = window.setTimeout(begin, HOLD_MS)
  const noMenu = (e: Event): void => e.preventDefault()

  const finish = (ended: boolean): void => {
    window.clearTimeout(timer)
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('touchmove', holdStill)
    ghost?.remove()
    ghost = null
    // The tap that lifts the finger must not also select the tab beneath it
    if (ended || started) {
      window.addEventListener('click', swallowClick, true)
      window.setTimeout(() => window.removeEventListener('click', swallowClick, true), 400)
    }
    window.setTimeout(() => window.removeEventListener('contextmenu', noMenu, true), 400)
    // The strip's own end-of-drag bookkeeping (dragend clears the moving tab)
    if (ended && tabEl.isConnected) fire(tabEl, 'dragend', 0, 0)
  }
  const swallowClick = (e: Event): void => {
    e.stopPropagation()
    e.preventDefault()
    window.removeEventListener('click', swallowClick, true)
  }

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('contextmenu', noMenu, true)
}
