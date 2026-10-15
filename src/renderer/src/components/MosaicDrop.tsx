// The three-document mosaic's drop zones (App): while a tab is being dragged
// — by mouse, or by finger through tab-touch-drag.ts, which delivers the same
// events — each tile becomes a target, and the tab dropped on one is shown
// there. Laid over the tiles, so it takes the drag before a tile's own
// split-column targets could.
import { useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { TAB_DRAG_MIME, dragCarriesTab } from '../drag-types'
import { t } from '../i18n'

export type MosaicRole = 'main' | 'top' | 'bottom'
export const MOSAIC_ROLES: readonly MosaicRole[] = ['main', 'top', 'bottom']

export default function MosaicDrop({
  onDrop
}: {
  onDrop(role: MosaicRole, path: string): void
}): React.JSX.Element {
  const [over, setOver] = useState<MosaicRole | null>(null)
  const accept = (e: ReactDragEvent, role: MosaicRole): void => {
    if (!dragCarriesTab(e.dataTransfer)) return
    e.preventDefault() // allows the drop
    setOver(role)
  }
  return (
    <div className="mosaic-drop">
      {MOSAIC_ROLES.map((role) => (
        <div
          key={role}
          className={`mosaic-zone tile-${role}${over === role ? ' is-over' : ''}`}
          onDragEnter={(e) => accept(e, role)}
          onDragOver={(e) => accept(e, role)}
          onDragLeave={() => setOver((o) => (o === role ? null : o))}
          onDrop={(e) => {
            if (!dragCarriesTab(e.dataTransfer)) return
            e.preventDefault()
            e.stopPropagation()
            setOver(null)
            const path = e.dataTransfer.getData(TAB_DRAG_MIME)
            if (path) onDrop(role, path)
          }}
        >
          <span>{t('app.mosaicDrop')}</span>
        </div>
      ))}
    </div>
  )
}
