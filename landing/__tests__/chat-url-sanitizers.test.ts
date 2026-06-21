// Tests for the URL scheme/host allow-list sanitizers in `landing/chat.ts`.
//
// `safeNavUrl` guards the `window.location` sinks in the redirect /
// slug-renamed handlers, and `safeImageSrc` guards the image-gallery
// `<img src>` write. Both protect against a value that flows in over the WS
// being handed straight to a DOM sink — a `javascript:`/`data:` URL in a
// location sink is a DOM-XSS vector, and an arbitrary host is an open redirect
// (CodeQL js/xss + js/client-side-unvalidated-url-redirection). These pin that
// http(s) targets pass through and unsafe schemes are rejected (null).

import { describe, expect, test } from 'bun:test'
import { safeImageSrc, safeNavUrl } from '../chat.ts'

describe('safeNavUrl — accepts http(s) targets', () => {
  test('passes through an https URL (normalized)', () => {
    expect(safeNavUrl('https://prism.neutron.example/chat?start=tok')).toBe(
      'https://prism.neutron.example/chat?start=tok',
    )
  })

  test('passes through an http URL (local dev)', () => {
    expect(safeNavUrl('http://prism.localhost:3000/chat?start=tok')).toBe(
      'http://prism.localhost:3000/chat?start=tok',
    )
  })
})

describe('safeNavUrl — rejects unsafe / unparseable targets', () => {
  test('rejects a javascript: URL (DOM-XSS vector)', () => {
    expect(safeNavUrl('javascript:alert(document.cookie)')).toBeNull()
  })

  test('rejects a data: URL', () => {
    expect(safeNavUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  test('rejects vbscript: and file: schemes', () => {
    expect(safeNavUrl('vbscript:msgbox(1)')).toBeNull()
    expect(safeNavUrl('file:///etc/passwd')).toBeNull()
  })

  test('rejects empty / non-string input', () => {
    expect(safeNavUrl('')).toBeNull()
    // @ts-expect-error — exercising the runtime type guard
    expect(safeNavUrl(undefined)).toBeNull()
  })

  test('rejects an unparseable garbage string', () => {
    expect(safeNavUrl('http://')).toBeNull()
  })
})

describe('safeImageSrc — accepts http(s) + data:image', () => {
  test('passes through an https image URL', () => {
    expect(safeImageSrc('https://cdn.example/p.png')).toBe(
      'https://cdn.example/p.png',
    )
  })

  test('passes through an inline data:image payload', () => {
    const src = 'data:image/png;base64,iVBORw0KGgo='
    expect(safeImageSrc(src)).toBe(src)
  })
})

describe('safeImageSrc — rejects unsafe schemes', () => {
  test('rejects javascript:', () => {
    expect(safeImageSrc('javascript:alert(1)')).toBeNull()
  })

  test('rejects a non-image data: payload', () => {
    expect(safeImageSrc('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  test('rejects empty input', () => {
    expect(safeImageSrc('')).toBeNull()
  })
})
