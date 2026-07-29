/**
 * Unit — `attachmentBasename` malformed-percent-escape guard (Argus round-1
 * BLOCKER). This helper runs during render for every non-image attachment chip.
 * A poisoned URL with a malformed percent-escape (e.g. `report%ZZ.pdf`) makes a
 * bare `decodeURIComponent` throw URIError; unguarded, that throw would trip the
 * ChatErrorBoundary and blank the whole chat view — and, because the URL
 * persists in history, it would recur on every reload. The guard must fall back
 * to the raw (still-encoded) segment instead of throwing.
 */
import { describe, expect, it } from 'bun:test'

import { attachmentBasename } from '../ChatApp.tsx'

describe('attachmentBasename', () => {
  it('decodes a normal percent-encoded basename', () => {
    expect(attachmentBasename('/api/app/upload/u-1/my%20report.pdf')).toBe('my report.pdf')
  })

  it('does NOT throw on a malformed percent-escape — returns the raw segment', () => {
    // node decodeURIComponent('report%ZZ.pdf') → URIError: URI malformed.
    let out = ''
    expect(() => {
      out = attachmentBasename('/api/app/upload/u-1/report%ZZ.pdf')
    }).not.toThrow()
    expect(out).toBe('report%ZZ.pdf')
  })

  it('does not throw on a lone trailing percent', () => {
    expect(() => attachmentBasename('/api/app/upload/u-1/weird%.pdf')).not.toThrow()
    expect(attachmentBasename('/api/app/upload/u-1/weird%.pdf')).toBe('weird%.pdf')
  })

  it('strips query + hash before taking the basename', () => {
    expect(attachmentBasename('/api/app/upload/u-1/doc.pdf?sig=abc#frag')).toBe('doc.pdf')
  })

  it('falls back to "attachment" for a pathless URL', () => {
    expect(attachmentBasename('/api/app/upload/u-1/')).toBe('attachment')
  })
})
