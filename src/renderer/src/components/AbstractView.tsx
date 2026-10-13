// What «Sammendrag» found, drawn the same way wherever it was asked for: the
// link preview's footer button (a citation in the text) and the selection
// menu (an entry selected in the reference list itself). The lookup is
// src/shared/abstract.ts behind PdfxApi.citationAbstract; this is only the
// reading of its answer.

import { forwardRef } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { errorText, t } from '../i18n'
import { bridge } from '../bridge'
import { doiUrl } from '../../../shared/doi'
import type { CitationAbstract, FileError } from '../../../shared/types'

export type AbstractState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; result: CitationAbstract }
  | { state: 'error'; error: FileError }

/** Abstracts from arXiv and the others carry TeX — «$\alpha$», «\(x\)» —
 *  rendered with KaTeX as the assistant's answers are (issue #31, second
 *  round). A dollar sign is money more often than math outside physics, so
 *  «$…$» counts only when its inside looks like TeX: a backslash, a sub- or
 *  superscript, braces, a relation — or a short bare symbol («$n$»). Bad TeX
 *  degrades to its source, never to a broken panel. */
function withMath(text: string): React.ReactNode {
  const parts = text.split(/(\$\$[^$]+\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\))/g)
  if (parts.length === 1) return text
  return parts.map((part, i) => {
    const display = part.startsWith('$$')
    const tex = display
      ? part.slice(2, -2)
      : part.startsWith('\\(')
        ? part.slice(2, -2)
        : part.startsWith('$')
          ? part.slice(1, -1)
          : null
    if (tex === null) return part
    if (part.startsWith('$') && !display && !/[\\^_{}=<>]|^[A-Za-z0-9]{1,3}$/.test(tex.trim())) return part
    return (
      <span
        key={i}
        className={display ? 'ai-math-block' : 'ai-math'}
        dangerouslySetInnerHTML={{
          __html: katex.renderToString(tex, { throwOnError: false, displayMode: display })
        }}
      />
    )
  })
}

const SOURCE_NAMES: Record<Exclude<CitationAbstract['source'], ''>, string> = {
  arxiv: 'arXiv',
  europepmc: 'Europe PMC',
  crossref: 'Crossref',
  openalex: 'OpenAlex'
}

/** Title, venue · year, the abstract's paragraphs — or the calm «found it,
 *  no abstract», or the named failure with a retry when nothing answered.
 *  A work identified by MATCHING the reference text (not by a printed DOI)
 *  says so, so a wrong match can be seen for what it is. */
export const AbstractBody = forwardRef<
  HTMLDivElement,
  {
    abs: AbstractState
    onRetry(): void
    maxHeight?: number | undefined
    className?: string
    /** A cross that removes the abstract alone — the link preview's panel
     *  folds out under the entry and must be closable without the window */
    onClose?: (() => void) | undefined
  }
>(function AbstractBody({ abs, onRetry, maxHeight, className, onClose }, ref) {
  if (abs.state !== 'done' && abs.state !== 'error') return null
  const result = abs.state === 'done' ? abs.result : null
  return (
    <div
      ref={ref}
      className={`link-preview-abstract${className ? ` ${className}` : ''}`}
      aria-live="polite"
      style={{ maxHeight }}
    >
      {onClose && (
        <button type="button" className="lpa-close" title={t('app.close')} aria-label={t('app.close')} onClick={onClose}>
          ✕
        </button>
      )}
      {result ? (
        <>
          {result.title && <div className="lpa-title">{result.title}</div>}
          {(result.year || result.venue) && (
            <div className="lpa-meta">{[result.venue, result.year].filter(Boolean).join(' · ')}</div>
          )}
          {result.abstract ? (
            result.abstract.split(/\n{2,}/).map((p, i) => (
              <p key={i} className="lpa-text">
                {withMath(p)}
              </p>
            ))
          ) : (
            <p className="lpa-none">{t('linkPreview.abstractNone')}</p>
          )}
          {result.via === 'match' && <p className="lpa-note">{t('linkPreview.abstractMatched')}</p>}
        </>
      ) : (
        abs.state === 'error' && (
          <p className="lpa-none">
            {errorText(abs.error)}
            {abs.error.code === 'abstract-offline' && (
              <button type="button" className="lpa-retry" onClick={onRetry}>
                {t('linkPreview.retry')}
              </button>
            )}
          </p>
        )
      )}
    </div>
  )
})

/** «Fra Europe PMC · DOI» — where the abstract came from, and the paper */
export function AbstractSource({ abs }: { abs: AbstractState }): React.JSX.Element | null {
  const result = abs.state === 'done' ? abs.result : null
  if (!result?.source) return null
  const url = result.doi ? doiUrl(result.doi) : null
  return (
    <span className="lpa-source">
      {t('linkPreview.abstractFrom', { source: SOURCE_NAMES[result.source] })}
      {url && (
        <>
          {' · '}
          <a
            href={url}
            onClick={(e) => {
              e.preventDefault()
              bridge.openExternal(url)
            }}
          >
            DOI
          </a>
        </>
      )}
    </span>
  )
}
