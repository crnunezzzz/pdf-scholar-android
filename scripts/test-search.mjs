// Proof for the search query rule in src/renderer/src/search.ts (issue #38):
// a phrase the page breaks across a line is still one match. buildPageText
// writes '\n' after every item with hasEOL, so the page text of
//
//     The tree originated
//     in Asia
//
// is «The tree originated\nin Asia», and a query typed with a space,
// «The tree originated in», found nothing while «The tree originated» did.
// The rule now: every whitespace run in the query matches ANY whitespace run
// on the page; leading and trailing blanks in the query are dropped; the
// match's start/end still address the page text itself (the text-layer
// mapping depends on it); case and whole-word options are unchanged.
//
// Run: node scripts/test-search.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/search.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'search-'))
const out = join(dir, 'search.mjs')
await build({
  entryPoints: [SRC],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'neutral',
  external: ['pdfjs-dist'],
  logLevel: 'silent'
})
const { findMatches, queryPattern } = await import(pathToFileURL(out).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const page = (text) => ({ text, runs: [] })
const opts = { matchCase: false, wholeWords: false }
const find = (text, query, o = opts) => findMatches([page(text)], query, o)

const broken = 'The tree originated\nin Asia, and the tree\n\n  spread west.'

const m1 = find(broken, 'The tree originated in')
check('a phrase broken across a line is one match', m1.length === 1 && m1[0].start === 0 && m1[0].end === 22,
  JSON.stringify(m1.map((m) => [m.start, m.end])))
check('the match addresses the page text itself (ends on «in»)', broken.slice(m1[0].start, m1[0].end) === 'The tree originated\nin')
check('the snippet shows the break as a space', m1[0].snippet.startsWith('The tree originated in Asia'))

const m2 = find(broken, 'tree spread')
check('a blank line plus indentation is still one whitespace run', m2.length === 1 && broken.slice(m2[0].start, m2[0].end) === 'tree\n\n  spread')

check('a trailing blank in the query is not a demand for a space', find(broken, 'originated ').length === 1)
check('a leading blank likewise', find(broken, ' Asia').length === 1)
check('two spaces in the query match one on the page', find(broken, 'in  Asia').length === 1)
check('a blank query finds nothing', find(broken, '   ').length === 0 && queryPattern('  ', false) === null)

check('case still folds by default', find(broken, 'the tree').length === 2)
check('match case still distinguishes', find(broken, 'The tree', { matchCase: true, wholeWords: false }).length === 1)
check('whole words still refuses a prefix', find(broken, 'tre', { matchCase: false, wholeWords: true }).length === 0)
check('whole words accepts the word', find(broken, 'tree', { matchCase: false, wholeWords: true }).length === 2)
check('regex characters in the query are literal', find('cost (a+b)*c', '(a+b)*c').length === 1)
check('overlapping occurrences are each found', find('aaa', 'aa').length === 2)

const m3 = find('x\n'.repeat(3) + 'needle', 'needle')
check('a match after several line breaks keeps its offset', m3.length === 1 && m3[0].start === 6)

console.log(failures === 0 ? '\nAll search checks passed' : `\n${failures} search check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
