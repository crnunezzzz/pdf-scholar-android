// Fonts for PDFs that do not carry their own (Android, docs/ANDROID.md).
//
// A PDF may name a font without embedding it — Word does this with Cambria,
// Calibri, Times New Roman and Arial more often than one would hope. pdf.js
// then asks the system: it creates a FontFace from `local()` names it knows
// for that family (for Times New Roman: Times New Roman, Liberation Serif,
// Tinos, …) and draws with it, or with the generic serif/sans if none is
// installed. Windows and macOS have the real fonts. An Android device has
// none of them, so the text came out in the device's generic serif squeezed
// into the document's glyph widths: cramped, unevenly spaced, no longer what
// the author wrote (reported on a Universidad del Pacífico exam, 2026-10-15).
//
// The fix gives pdf.js on Android what a desktop has: for each family it asks
// for, a font with IDENTICAL metrics, shipped with the app — the
// metric-compatible twins ChromeOS and LibreOffice substitute (all SIL OFL
// 1.1): Tinos for Times New Roman, Arimo for Arial/Helvetica, Cousine for
// Courier New, Carlito for Calibri, Caladea for Cambria, Gelasio for Georgia.
// Every glyph then takes exactly the width the document gave it.
//
// How: pdf.js builds those faces with the page's FontFace constructor, so on
// Android the constructor puts the bundled twin FIRST in any source list that
// names the family (`local()` names alone are useless there, and pdf.js's own
// list for Times ends in DejaVu Serif, a wrong-metric match). pdf.js awaits
// that face before drawing, so no page paints with the fallback first. Only
// the latin subset rides along (Western European letters, punctuation, €);
// anything beyond falls through to the generic face as before.
import caladea400 from '@fontsource/caladea/files/caladea-latin-400-normal.woff2?url'
import caladea400i from '@fontsource/caladea/files/caladea-latin-400-italic.woff2?url'
import caladea700 from '@fontsource/caladea/files/caladea-latin-700-normal.woff2?url'
import caladea700i from '@fontsource/caladea/files/caladea-latin-700-italic.woff2?url'
import carlito400 from '@fontsource/carlito/files/carlito-latin-400-normal.woff2?url'
import carlito400i from '@fontsource/carlito/files/carlito-latin-400-italic.woff2?url'
import carlito700 from '@fontsource/carlito/files/carlito-latin-700-normal.woff2?url'
import carlito700i from '@fontsource/carlito/files/carlito-latin-700-italic.woff2?url'
import tinos400 from '@fontsource/tinos/files/tinos-latin-400-normal.woff2?url'
import tinos400i from '@fontsource/tinos/files/tinos-latin-400-italic.woff2?url'
import tinos700 from '@fontsource/tinos/files/tinos-latin-700-normal.woff2?url'
import tinos700i from '@fontsource/tinos/files/tinos-latin-700-italic.woff2?url'
import arimo400 from '@fontsource/arimo/files/arimo-latin-400-normal.woff2?url'
import arimo400i from '@fontsource/arimo/files/arimo-latin-400-italic.woff2?url'
import arimo700 from '@fontsource/arimo/files/arimo-latin-700-normal.woff2?url'
import arimo700i from '@fontsource/arimo/files/arimo-latin-700-italic.woff2?url'
import cousine400 from '@fontsource/cousine/files/cousine-latin-400-normal.woff2?url'
import cousine400i from '@fontsource/cousine/files/cousine-latin-400-italic.woff2?url'
import cousine700 from '@fontsource/cousine/files/cousine-latin-700-normal.woff2?url'
import cousine700i from '@fontsource/cousine/files/cousine-latin-700-italic.woff2?url'
import gelasio400 from '@fontsource/gelasio/files/gelasio-latin-400-normal.woff2?url'
import gelasio400i from '@fontsource/gelasio/files/gelasio-latin-400-italic.woff2?url'
import gelasio700 from '@fontsource/gelasio/files/gelasio-latin-700-normal.woff2?url'
import gelasio700i from '@fontsource/gelasio/files/gelasio-latin-700-italic.woff2?url'

/** One twin's four faces: [regular, italic, bold, bold italic] */
type Faces = readonly [string, string, string, string]

const CALADEA: Faces = [caladea400, caladea400i, caladea700, caladea700i]
const CARLITO: Faces = [carlito400, carlito400i, carlito700, carlito700i]
const TINOS: Faces = [tinos400, tinos400i, tinos700, tinos700i]
const ARIMO: Faces = [arimo400, arimo400i, arimo700, arimo700i]
const COUSINE: Faces = [cousine400, cousine400i, cousine700, cousine700i]
const GELASIO: Faces = [gelasio400, gelasio400i, gelasio700, gelasio700i]

/** A `local()` name (lower case, no spaces, hyphens or style suffix) → twin.
 *  The names are the ones pdf.js puts in a substitute's source list (its
 *  substitutionMap: «Times New Roman», «Liberation Serif», «Tinos», …) and the
 *  bare document name for a family it has no entry for (Cambria, Georgia). */
const TWINS: [RegExp, Faces][] = [
  [/^(cambria|caladea)/, CALADEA],
  [/^(calibri|carlito)/, CARLITO],
  [/^(timesnewroman|timesroman|times$|times(bold|italic)|liberationserif|tinos|nimbusroman|thorndale)/, TINOS],
  [/^(arial(?!narrow|black|unicode|rounded)|helvetica(?!neue)|liberationsans(?!narrow)|arimo|nimbussans)/, ARIMO],
  [/^(couriernew|courier$|courier(bold|oblique|italic)|liberationmono|cousine|nimbusmono)/, COUSINE],
  [/^(georgia|gelasio)/, GELASIO]
]

const LOCAL = /local\(\s*(["']?)([^"')]+)\1\s*\)/g

/** The bundled twin for a FontFace source list, as a `url()` to put first, or
 *  null when no name in it is one we stand in for. Exported for the test. */
export function twinSource(source: string, descriptors?: FontFaceDescriptors): string | null {
  const names = [...source.matchAll(LOCAL)].map((m) => m[2].toLowerCase().replace(/[\s_-]+/g, ''))
  const faces = names.map((n) => TWINS.find(([re]) => re.test(n))?.[1]).find(Boolean)
  if (!faces) return null
  const weight = String(descriptors?.weight ?? 'normal')
  const bold = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600
  const italic = /italic|oblique/.test(String(descriptors?.style ?? ''))
  return `url(${faces[(bold ? 2 : 0) + (italic ? 1 : 0)]}) format('woff2')`
}

let installed = false

/** Android: wrap the page's FontFace constructor so pdf.js's system-font
 *  substitutes find the bundled twins (see the top of this file). Must run
 *  before the first document opens; a second call does nothing. */
export function installPdfFallbackFonts(): void {
  if (installed || typeof window === 'undefined' || typeof window.FontFace !== 'function') return
  installed = true
  const Native = window.FontFace
  class PdfFontFace extends Native {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      const twin = typeof source === 'string' ? twinSource(source, descriptors) : null
      super(family, twin ? `${twin},${source}` : source, descriptors)
    }
  }
  window.FontFace = PdfFontFace
}
