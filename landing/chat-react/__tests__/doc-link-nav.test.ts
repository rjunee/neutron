/**
 * landing/chat-react/__tests__/doc-link-nav.test.ts — P-A.
 *
 * `parseWebDocLinkHref` recognises the web doc-link URL the app-ws adapter emits
 * for a `platform=web` client (`/projects/<id>/docs?path=<enc>`), both
 * root-relative and absolute same-origin, and rejects everything else so a
 * normal external link still opens in a new tab.
 */

import { describe, expect, it } from 'bun:test'

import {
  initialDocLinkFromLocation,
  parseWebDocLinkHref,
  webifyDocLinkHref,
} from '../doc-link-nav.ts'

const ORIGIN = 'https://app.example.test'

describe('parseWebDocLinkHref', () => {
  it('parses a root-relative doc link (default self-host, WEB_APP_BASE unset)', () => {
    expect(parseWebDocLinkHref('/projects/acme/docs?path=pitch-deck.md', ORIGIN)).toEqual({
      projectId: 'acme',
      path: 'pitch-deck.md',
    })
  })

  it('parses a nested (folder) path', () => {
    expect(
      parseWebDocLinkHref('/projects/acme/docs?path=research%2Fnotes.md', ORIGIN),
    ).toEqual({ projectId: 'acme', path: 'research/notes.md' })
  })

  it('parses the surfaced STATUS.md link', () => {
    expect(parseWebDocLinkHref('/projects/acme/docs?path=STATUS.md', ORIGIN)).toEqual({
      projectId: 'acme',
      path: 'STATUS.md',
    })
  })

  it('parses an absolute SAME-ORIGIN doc link', () => {
    expect(
      parseWebDocLinkHref(`${ORIGIN}/projects/acme/docs?path=brief.md`, ORIGIN),
    ).toEqual({ projectId: 'acme', path: 'brief.md' })
  })

  it('ignores an optional &line= anchor (opens the whole doc)', () => {
    expect(
      parseWebDocLinkHref('/projects/acme/docs?path=brief.md&line=42', ORIGIN),
    ).toEqual({ projectId: 'acme', path: 'brief.md' })
  })

  it('tolerates a WEB_APP_BASE path prefix (absolute)', () => {
    expect(
      parseWebDocLinkHref(`${ORIGIN}/app/projects/acme/docs?path=brief.md`, ORIGIN),
    ).toEqual({ projectId: 'acme', path: 'brief.md' })
  })

  it('tolerates a path prefix (root-relative)', () => {
    expect(
      parseWebDocLinkHref('/app/projects/acme/docs?path=brief.md', ORIGIN),
    ).toEqual({ projectId: 'acme', path: 'brief.md' })
  })

  it('does not match a lookalike segment (/xprojects/)', () => {
    expect(parseWebDocLinkHref('/xprojects/acme/docs?path=brief.md', ORIGIN)).toBeNull()
  })

  it('rejects a different origin', () => {
    expect(
      parseWebDocLinkHref('https://evil.example/projects/acme/docs?path=x.md', ORIGIN),
    ).toBeNull()
  })

  it('rejects a native neutron:// link (custom scheme)', () => {
    expect(parseWebDocLinkHref('neutron://docs/acme/brief.md', ORIGIN)).toBeNull()
  })

  it('rejects a protocol-relative lookalike (different host)', () => {
    expect(
      parseWebDocLinkHref('//evil.example/projects/acme/docs?path=x.md', ORIGIN),
    ).toBeNull()
  })

  it('rejects an ordinary external https link', () => {
    expect(parseWebDocLinkHref('https://example.com/blog', ORIGIN)).toBeNull()
  })

  it('rejects a path traversal attempt', () => {
    expect(
      parseWebDocLinkHref('/projects/acme/docs?path=..%2F..%2Fetc.md', ORIGIN),
    ).toBeNull()
  })

  it('rejects a malformed shape (no docs segment / no path)', () => {
    expect(parseWebDocLinkHref('/projects/acme/tree?path=x.md', ORIGIN)).toBeNull()
    expect(parseWebDocLinkHref('/projects/acme/docs', ORIGIN)).toBeNull()
    expect(parseWebDocLinkHref('/projects/acme/docs?path=', ORIGIN)).toBeNull()
    expect(parseWebDocLinkHref('', ORIGIN)).toBeNull()
  })
})

describe('initialDocLinkFromLocation', () => {
  it('parses a hard-loaded doc deep-link location (pathname + search)', () => {
    expect(
      initialDocLinkFromLocation('/projects/acme/docs', '?path=pitch-deck.md', ORIGIN),
    ).toEqual({ projectId: 'acme', path: 'pitch-deck.md' })
  })

  it('parses a nested doc path from the location', () => {
    expect(
      initialDocLinkFromLocation('/projects/acme/docs', '?path=research%2Fnotes.md', ORIGIN),
    ).toEqual({ projectId: 'acme', path: 'research/notes.md' })
  })

  it('returns null for a normal /chat boot (not a doc link)', () => {
    expect(initialDocLinkFromLocation('/chat', '', ORIGIN)).toBeNull()
    expect(initialDocLinkFromLocation('/chat', '?start=abc', ORIGIN)).toBeNull()
  })

  it('returns null for a /projects page that is not a docs deep link', () => {
    expect(initialDocLinkFromLocation('/projects/acme', '', ORIGIN)).toBeNull()
    expect(initialDocLinkFromLocation('/projects/acme/docs', '', ORIGIN)).toBeNull()
  })
})

describe('webifyDocLinkHref (FIX #376)', () => {
  it('normalizes the canonical docs:/ marker to the web doc-link URL', () => {
    expect(webifyDocLinkHref('docs:/acme/brief.md')).toBe('/projects/acme/docs?path=brief.md')
  })

  it('normalizes a nested marker path', () => {
    expect(webifyDocLinkHref('docs:/acme/research/notes.md')).toBe(
      '/projects/acme/docs?path=research%2Fnotes.md',
    )
  })

  it('normalizes the native neutron:// scheme (per-segment percent-encoded)', () => {
    expect(webifyDocLinkHref('neutron://docs/acme/research%2Fnotes.md')).toBe(
      '/projects/acme/docs?path=research%2Fnotes.md',
    )
    expect(webifyDocLinkHref('neutron://docs/acme/brief.md')).toBe(
      '/projects/acme/docs?path=brief.md',
    )
  })

  it('drops a line/range anchor tail (the viewer opens the whole doc)', () => {
    expect(webifyDocLinkHref('docs:/acme/brief.md#L42')).toBe('/projects/acme/docs?path=brief.md')
    expect(webifyDocLinkHref('neutron://docs/acme/brief.md?line=42')).toBe(
      '/projects/acme/docs?path=brief.md',
    )
  })

  it('leaves a web-shape href untouched (already interceptable)', () => {
    expect(webifyDocLinkHref('/projects/acme/docs?path=brief.md')).toBeNull()
  })

  it('leaves an external URL untouched', () => {
    expect(webifyDocLinkHref('https://example.com/x')).toBeNull()
    expect(webifyDocLinkHref('mailto:a@b.co')).toBeNull()
  })

  it('rejects a traversal / absolute path', () => {
    expect(webifyDocLinkHref('docs:/acme/../secret.md')).toBeNull()
    expect(webifyDocLinkHref('neutron://docs/acme/%2e%2e%2fsecret.md')).toBeNull()
  })

  it('rejects a `.`/`..` projectId (would traverse /projects/../docs)', () => {
    expect(webifyDocLinkHref('docs:/../brief.md')).toBeNull()
    expect(webifyDocLinkHref('docs:/./brief.md')).toBeNull()
    expect(webifyDocLinkHref('neutron://docs/../brief.md')).toBeNull()
    expect(parseWebDocLinkHref('/projects/../docs?path=brief.md', ORIGIN)).toBeNull()
  })

  it('rejects a marker with no path segment', () => {
    expect(webifyDocLinkHref('docs:/acme')).toBeNull()
  })

  it('returns null for empty / non-string input', () => {
    expect(webifyDocLinkHref('')).toBeNull()
    expect(webifyDocLinkHref(undefined as unknown as string)).toBeNull()
  })
})
