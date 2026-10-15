// «Which document beside this one?» — what the split-view button opens when
// the host can put another file in the second column (App's tabs: desktop and
// Android). Laid over the right half of the pages, where that column will
// stand: first how many documents the window shows (1, 2 or the three-document
// mosaic), then for two the open documents (this one first — both columns on
// the same file), a search once the list is long, and a file picker. A drag of a tab onto the
// pages still works; this is the way that needs no drag at all, which on a
// touch screen was the only way and hard to find (2026-10-15). The 's' key
// stays the instant same-file split.
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconDocument, IconFolderOpen, IconSearch, IconSplit } from './icons'
import { t } from '../i18n'

/** More documents than this and the list gets a search field */
const SEARCH_FROM = 5

/** How many documents the window shows */
type Layout = 1 | 2 | 3

export default function SplitPicker({
  docs,
  currentPath,
  threeOpen = false,
  canThree = false,
  onOne,
  onThree,
  onPick,
  onOther,
  onClose
}: {
  docs: { name: string; path: string }[]
  /** This tab's own document: picking it is the same-file split */
  currentPath: string
  /** The three-document mosaic is showing right now (the panel was opened
   *  from one of its tiles) */
  threeOpen?: boolean
  /** Enough tabs are open to fill the mosaic's other two tiles */
  canThree?: boolean
  /** «1 document»: back to a single document (ends the mosaic if it shows) */
  onOne?: (() => void) | undefined
  /** «3 documents»: the mosaic. Absent where the host has none */
  onThree?: (() => void) | undefined
  onPick(path: string): void
  onOther(): void
  onClose(): void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [layout, setLayout] = useState<Layout>(threeOpen ? 3 : 2)
  const panelRef = useRef<HTMLDivElement>(null)

  const chooseLayout = (next: Layout): void => {
    if (next === 2) {
      setLayout(2)
      return
    }
    if (next === 1) {
      if (onOne) onOne()
      else onClose()
      return
    }
    // Three: the mosaic stands at once; opened from its own tile there is
    // nothing more to do
    if (!threeOpen) onThree?.()
    else onClose()
  }

  // This document first, the others in strip order
  const ordered = useMemo(() => {
    const own = docs.filter((d) => d.path === currentPath)
    return [...own, ...docs.filter((d) => d.path !== currentPath)]
  }, [docs, currentPath])
  const q = query.trim().toLocaleLowerCase()
  const shown = q ? ordered.filter((d) => d.name.toLocaleLowerCase().includes(q)) : ordered

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    // The keyboard lands in the panel (no field focused on a touch screen:
    // that would pull the on-screen keyboard up over the list)
    panelRef.current?.focus({ preventScroll: true })
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="split-picker-layer" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="split-picker"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label={t('split.pickTitle')}
      >
        <div className="split-picker-head">
          <IconSplit size={16} />
          <span className="split-picker-title">{t('split.pickTitle')}</span>
          <button className="split-picker-close" title={t('split.pickClose')} onClick={onClose}>
            ×
          </button>
        </div>
        {onThree && (
          <div className="split-picker-layouts" role="group" aria-label={t('split.layoutLabel')}>
            {([1, 2, 3] as const).map((n) => {
              const blocked = n === 3 && !threeOpen && !canThree
              return (
                <button
                  key={n}
                  className={`split-picker-layout${layout === n ? ' is-active' : ''}`}
                  aria-pressed={layout === n}
                  aria-disabled={blocked}
                  title={blocked ? t('tb.mosaicNeedThree') : undefined}
                  onClick={() => !blocked && chooseLayout(n)}
                >
                  <span className="split-picker-layout-label">{t(`split.layout${n}` as const)}</span>
                </button>
              )
            })}
          </div>
        )}
        {layout === 3 && <div className="split-picker-hint">{t('tb.mosaicHint')}</div>}
        {layout === 2 && ordered.length > SEARCH_FROM && (
          <label className="split-picker-search">
            <IconSearch size={14} />
            <input
              type="search"
              value={query}
              placeholder={t('split.pickSearch')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && shown.length > 0) onPick(shown[0].path)
              }}
            />
          </label>
        )}
        {layout === 2 && (
          <>
            <div className="split-picker-list">
              {shown.map((d) => {
                const own = d.path === currentPath
                return (
                  <button
                    key={d.path}
                    className="split-picker-item"
                    title={d.path}
                    onClick={() => onPick(d.path)}
                  >
                    <IconDocument size={18} />
                    <span className="split-picker-text">
                      <span className="split-picker-name">{d.name}</span>
                      <span className="split-picker-sub">
                        {own ? t('split.pickSame') : t('split.pickTab')}
                      </span>
                    </span>
                  </button>
                )
              })}
              {shown.length === 0 && <div className="split-picker-empty">{t('split.pickNone')}</div>}
            </div>
            <button className="split-picker-item split-picker-other" onClick={onOther}>
              <IconFolderOpen size={18} />
              <span className="split-picker-text">
                <span className="split-picker-name">{t('tb.splitOtherFile')}</span>
              </span>
            </button>
            <div className="split-picker-hint">{t('tb.splitDropHint')}</div>
          </>
        )}
      </div>
    </div>
  )
}
