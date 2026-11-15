// Android's stand-ins for fonts a PDF names but does not embed
// (src/renderer/src/pdf-fonts.ts): pdf.js asks for a system font through a
// FontFace whose source lists local() names; on Android the bundled
// metric-compatible twin must come first, in the right weight and style, for
// every spelling Word writes — and only for those families.
//
// What would go wrong silently without this: pdf.js renaming the local() names
// in its substitution table (the twins would never be found again and Word's
// documents would go back to squeezed generic text), or a regex catching a
// family it should not (Arial Narrow drawn in Arimo's widths).
// Run: node scripts/test-pdf-fonts.mjs
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/renderer/src/pdf-fonts.ts', import.meta.url))
const outfile = join(mkdtempSync(join(tmpdir(), 'pdf-fonts-')), 'pdf-fonts.mjs')
// `?url` imports become their file name, which is all the test reads
const urlStub = {
  name: 'url-stub',
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: 'url' }))
    b.onLoad({ filter: /.*/, namespace: 'url' }, (a) => ({
      contents: `export default ${JSON.stringify(a.path.replace(/^.*\//, '').replace('?url', ''))}`,
      loader: 'js'
    }))
  }
}
await build({ entryPoints: [SRC], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [urlStub] })
const { twinSource } = await import(pathToFileURL(outfile).href)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}
const twin = (src, d) => (twinSource(src, d) ?? 'none').replace(/^url\((.*?)\).*$/, '$1')

console.log('\n1. the source lists pdf.js really builds')
{
  // pdf.js's own substitution table must still name the twins we key on
  const worker = readFileSync(new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url), 'utf8')
  for (const name of ['Times New Roman', 'Tinos', 'Arimo', 'Cousine', 'Carlito', 'Liberation Serif', 'Liberation Sans'])
    check(`pdf.js still lists local «${name}»`, worker.includes(`"${name}"`))
  check('Times New Roman → Tinos', twin('local(Times New Roman),local(Times-Roman),local(Liberation Serif),local(DejaVu Serif)') === 'tinos-latin-400-normal.woff2')
  check('Arial → Arimo', twin('local(Arial),local(Helvetica),local(Liberation Sans)') === 'arimo-latin-400-normal.woff2')
  check('Courier New → Cousine', twin('local(Courier New),local(Courier),local(Liberation Mono)') === 'cousine-latin-400-normal.woff2')
  check('Calibri → Carlito', twin('local(Calibri),local(Carlito)') === 'carlito-latin-400-normal.woff2')
}

console.log('\n2. a family pdf.js has no entry for comes by its own name')
{
  check('Cambria → Caladea', twin('local(Cambria)') === 'caladea-latin-400-normal.woff2')
  check('Cambria-Bold (bold weight) → Caladea bold', twin('local(Cambria-Bold)', { weight: 'bold' }) === 'caladea-latin-700-normal.woff2')
  check('Cambria,BoldItalic → bold italic', twin('local(Cambria-BoldItalic)', { weight: '700', style: 'italic' }) === 'caladea-latin-700-italic.woff2')
  check('Georgia → Gelasio', twin('local(Georgia)') === 'gelasio-latin-400-normal.woff2')
  check("quoted names work too", twin("local('Times New Roman')", { style: 'italic' }) === 'tinos-latin-400-italic.woff2')
}

console.log('\n3. nothing else is touched')
{
  check('Aptos (no twin) → nothing', twinSource('local(Aptos)') === null)
  check('Arial Narrow → nothing (other widths)', twinSource('local(Arial Narrow)') === null)
  check('Helvetica Neue → nothing', twinSource('local(Helvetica Neue)') === null)
  check('an embedded font (url only) → nothing', twinSource('url(data:font/woff2;base64,AAAA)') === null)
  check('the twin goes FIRST, the original list after', /^url\(tinos/.test(twinSource('local(Times New Roman)')))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
