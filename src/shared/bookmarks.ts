// Bookmarks are a flat list per file — page and label — and have been since
// they were introduced; a reader asked to nest one under another (issue #43).
// The nesting is a `parent` on the child: the parent's PAGE, since a page holds
// at most one bookmark and the page is a bookmark's identity everywhere else
// (toggle, rename, the selection menu's «Lag bokmerke»). The list stays flat
// and page-ordered on disk, so every older reader of it — the B key's «next
// bookmark», the extension's store, a state file from before nesting — is
// exactly as it was; the tree is derived here, for the panel. A list with no
// `parent` anywhere renders as it always did (Emil, 2026-10-13: nesting may
// exist only if it costs the flat case nothing).
//
// Pure, so the test can lay out lists of its own. Every rule returns the SAME
// array when it changes nothing, which is how the panel knows a button is
// moot (the first sibling has nothing above it to nest under).
import type { DocBookmark } from './types'

export interface BookmarkRow {
  bookmark: DocBookmark
  /** 0 = top level */
  depth: number
  hasChildren: boolean
}

const parentOf = (list: readonly DocBookmark[], b: DocBookmark): number | undefined =>
  b.parent !== undefined && b.parent !== b.page && list.some((x) => x.page === b.parent) ? b.parent : undefined

const without = (b: DocBookmark, key: 'parent' | 'collapsed'): DocBookmark => {
  const copy = { ...b }
  delete copy[key]
  return copy
}

/** Stored input is untrusted: a page that is not a page, a page twice, a
 *  parent that is not in the list, a parent that leads back to itself — each
 *  reads as the harmless thing (dropped, first one wins, top level). Comes
 *  out page-ordered, as the store keeps it. */
export function sanitizeBookmarks(list: readonly DocBookmark[]): DocBookmark[] {
  const byPage = new Map<number, DocBookmark>()
  for (const b of list) {
    if (!b || !Number.isInteger(b.page) || b.page < 1 || byPage.has(b.page)) continue
    byPage.set(b.page, b)
  }
  const out: DocBookmark[] = []
  for (const b of byPage.values()) {
    let parent = typeof b.parent === 'number' && b.parent !== b.page && byPage.has(b.parent) ? b.parent : undefined
    if (parent !== undefined) {
      // Walk up; a page met twice is a cycle, and this bookmark leaves it
      const seen = new Set<number>([b.page])
      for (let p: number | undefined = parent; p !== undefined; p = byPage.get(p)?.parent) {
        if (seen.has(p) || !byPage.has(p)) {
          if (seen.has(p)) parent = undefined
          break
        }
        seen.add(p)
      }
    }
    const clean: DocBookmark = {
      page: b.page,
      label: typeof b.label === 'string' ? b.label : '',
      createdAt: typeof b.createdAt === 'number' ? b.createdAt : 0
    }
    if (parent !== undefined) clean.parent = parent
    if (b.collapsed === true) clean.collapsed = true
    out.push(clean)
  }
  return out.sort((a, b) => a.page - b.page)
}

/** The panel's rows, top-down: top-level bookmarks by page, each followed by
 *  its children by page, and so on — minus what sits under a collapsed one. */
export function bookmarkRows(list: readonly DocBookmark[]): BookmarkRow[] {
  const children = new Map<number | undefined, DocBookmark[]>()
  for (const b of list) {
    const key = parentOf(list, b)
    const arr = children.get(key) ?? []
    arr.push(b)
    children.set(key, arr)
  }
  const out: BookmarkRow[] = []
  const seen = new Set<number>()
  const walk = (parent: number | undefined, depth: number): void => {
    for (const b of [...(children.get(parent) ?? [])].sort((x, y) => x.page - y.page)) {
      if (seen.has(b.page)) continue
      seen.add(b.page)
      out.push({ bookmark: b, depth, hasChildren: (children.get(b.page) ?? []).length > 0 })
      if (!b.collapsed) walk(b.page, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

/** Under the bookmark above it at its own level — the nearest sibling on an
 *  earlier page, expanded if it was folded so the move can be seen. The first
 *  of its siblings has nothing above it and stays. */
export function indentBookmark(list: readonly DocBookmark[], page: number): readonly DocBookmark[] {
  const me = list.find((b) => b.page === page)
  if (!me) return list
  const level = parentOf(list, me)
  const above = list
    .filter((b) => b.page < page && parentOf(list, b) === level)
    .reduce<DocBookmark | null>((best, b) => (best === null || b.page > best.page ? b : best), null)
  if (!above) return list
  return list.map((b) =>
    b.page === page ? { ...b, parent: above.page } : b.page === above.page && b.collapsed ? without(b, 'collapsed') : b
  )
}

/** Out one level: beside its parent. Its own children come along. */
export function outdentBookmark(list: readonly DocBookmark[], page: number): readonly DocBookmark[] {
  const me = list.find((b) => b.page === page)
  const parent = me ? parentOf(list, me) : undefined
  if (!me || parent === undefined) return list
  const grand = parentOf(list, list.find((b) => b.page === parent)!)
  return list.map((b) => {
    if (b.page !== page) return b
    return grand === undefined ? without(b, 'parent') : { ...b, parent: grand }
  })
}

/** Gone; what sat under it moves up to where it was */
export function removeBookmark(list: readonly DocBookmark[], page: number): readonly DocBookmark[] {
  const me = list.find((b) => b.page === page)
  if (!me) return list
  const parent = parentOf(list, me)
  return list
    .filter((b) => b.page !== page)
    .map((b) => {
      if (b.parent !== page) return b
      return parent === undefined ? without(b, 'parent') : { ...b, parent }
    })
}

export function toggleCollapsed(list: readonly DocBookmark[], page: number): readonly DocBookmark[] {
  if (!list.some((b) => b.page === page)) return list
  return list.map((b) => (b.page !== page ? b : b.collapsed ? without(b, 'collapsed') : { ...b, collapsed: true }))
}
