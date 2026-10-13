// Proof for the nested bookmarks (src/shared/bookmarks.ts, issue #43): the
// tree the panel draws from a flat, page-ordered list; nesting under the
// sibling above and out again; a removed parent lifting its children; a
// folded parent hiding what is under it; and a stored list read as the
// untrusted input it is — a missing parent, a self-parent, a cycle, a page
// twice, garbage. Above all: a list with no `parent` anywhere comes out
// exactly as before, one row per bookmark at depth 0.
//
// Run: node scripts/test-bookmarks.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/bookmarks.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'bookmarks-'))
const out = join(dir, 'bookmarks.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const M = await import(pathToFileURL(out).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const bm = (page, extra = {}) => ({ page, label: `p${page}`, createdAt: page, ...extra })
const rowsOf = (list) => M.bookmarkRows(list).map((r) => `${r.bookmark.page}@${r.depth}${r.hasChildren ? '+' : ''}`).join(' ')

// ---- the flat case is untouched
{
  const flat = [bm(2), bm(5), bm(9)]
  check('flat list: one row each, depth 0, no children', rowsOf(flat) === '2@0 5@0 9@0', rowsOf(flat))
  check('flat list: sanitize returns it as it was', JSON.stringify(M.sanitizeBookmarks(flat)) === JSON.stringify(flat))
  check('flat list: the first row cannot nest (same array back)', M.indentBookmark(flat, 2) === flat)
  check('flat list: a top-level row cannot move out', M.outdentBookmark(flat, 5) === flat)
}

// ---- nesting
{
  const flat = [bm(2), bm(5), bm(9)]
  const nested = M.indentBookmark(flat, 5)
  check('indent: under the sibling above', nested.find((b) => b.page === 5).parent === 2, JSON.stringify(nested))
  check('indent: the tree shows it under its parent', rowsOf(nested) === '2@0+ 5@1 9@0', rowsOf(nested))
  const deeper = M.indentBookmark(M.indentBookmark(nested, 9), 9)
  check('indent twice: 9 goes under 2, then under 5', rowsOf(deeper) === '2@0+ 5@1+ 9@2', rowsOf(deeper))
  check('indent: under the sibling above at the SAME level, not the one above in the list', (() => {
    // 2 > 5, then 9 at top level: its sibling above is 2 (5 is a child)
    const r = M.indentBookmark(nested, 9)
    return r.find((b) => b.page === 9).parent === 2
  })())
  const back = M.outdentBookmark(deeper, 9)
  check('outdent: beside its parent', rowsOf(back) === '2@0+ 5@1 9@1', rowsOf(back))
  const top = M.outdentBookmark(back, 9)
  check('outdent again: top level, parent field gone', rowsOf(top) === '2@0+ 5@1 9@0' && !('parent' in top.find((b) => b.page === 9)))
  // Children come along when their parent moves
  const family = M.indentBookmark(M.indentBookmark([bm(1), bm(4), bm(6)], 4), 6) // 1 > 4 > 6? no: 6 indents under 4's level sibling…
  check('a moved parent takes its children', (() => {
    // 1 > 4, 6 under 4 (indent 6 → sibling above at top level is 1; indent again → under 4)
    const l = M.indentBookmark(M.indentBookmark(M.indentBookmark([bm(1), bm(4), bm(6)], 4), 6), 6)
    const o = M.outdentBookmark(l, 4) // 4 out to top level; 6 still under 4
    return rowsOf(o) === '1@0 4@0+ 6@1'
  })())
  void family
}

// ---- removing and folding
{
  const l = M.indentBookmark(M.indentBookmark([bm(2), bm(5), bm(9)], 5), 9)
  // 2 > {5, 9}
  const gone = M.removeBookmark(l, 2)
  check('remove a parent: its children move up to its level', rowsOf(gone) === '5@0 9@0', rowsOf(gone))
  const deep = M.indentBookmark(l, 9) // 2 > 5 > 9
  const mid = M.removeBookmark(deep, 5)
  check('remove a middle one: the child goes to the grandparent', rowsOf(mid) === '2@0+ 9@1', rowsOf(mid))
  check('remove what is not there: same array back', M.removeBookmark(l, 77) === l)
  const folded = M.toggleCollapsed(l, 2)
  check('collapsed: the children are hidden, the parent still says it has them', rowsOf(folded) === '2@0+', rowsOf(folded))
  check('collapsed twice: open again, flag gone', rowsOf(M.toggleCollapsed(folded, 2)) === '2@0+ 5@1 9@1' && !('collapsed' in M.toggleCollapsed(folded, 2)[0]))
  const into = M.indentBookmark([...folded, bm(12)], 12)
  check('indent under a folded parent opens it', rowsOf(into) === '2@0+ 5@1 9@1 12@1', rowsOf(into))
}

// ---- the stored list is untrusted
{
  const junk = [
    bm(5, { parent: 2 }), // parent exists
    bm(2),
    bm(9, { parent: 99 }), // parent missing → top level
    bm(12, { parent: 12 }), // itself → top level
    bm(20, { parent: 21 }),
    bm(21, { parent: 20 }), // a cycle → both top level
    bm(2, { label: 'twice' }), // duplicate page: first wins
    { page: 0, label: 'zero', createdAt: 0 },
    { page: 'x', label: 'nan', createdAt: 0 },
    null,
    bm(30, { collapsed: true, label: undefined })
  ]
  const clean = M.sanitizeBookmarks(junk)
  check('sanitize: page order, duplicates and garbage dropped', clean.map((b) => b.page).join(',') === '2,5,9,12,20,21,30', clean.map((b) => b.page).join(','))
  check('sanitize: a missing parent reads as top level', !('parent' in clean.find((b) => b.page === 9)))
  check('sanitize: a self-parent reads as top level', !('parent' in clean.find((b) => b.page === 12)))
  check('sanitize: a cycle is cut', !('parent' in clean.find((b) => b.page === 20)) && !('parent' in clean.find((b) => b.page === 21)))
  check('sanitize: a real parent survives', clean.find((b) => b.page === 5).parent === 2)
  check('sanitize: the first of two on one page wins', clean.find((b) => b.page === 2).label === 'p2')
  check('sanitize: collapsed kept, a missing label becomes empty', clean.find((b) => b.page === 30).collapsed === true && clean.find((b) => b.page === 30).label === '')
  check('rows never loop on a cycle', rowsOf([bm(1, { parent: 2 }), bm(2, { parent: 1 })]) === '')
}

console.log(failures === 0 ? '\nAll bookmark checks passed' : `\n${failures} bookmark check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
