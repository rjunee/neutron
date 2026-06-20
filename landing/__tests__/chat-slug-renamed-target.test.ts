// Tests for `buildSlugRenamedTarget` in `landing/chat.ts`.
//
// The helper drives the `slug_renamed` envelope client handler's URL
// build. It MUST classify local-apex hosts (`localhost`, `*.localhost`,
// `*.local`, `*.test`, `127.x`, `0.0.0.0`) so dev runs emit `http://`,
// AND attach `&debug=1` when the debug flag is on so the WS-trace hook
// stays enabled on the renamed-subdomain page.
//
// Codex r1 [P3] (2026-05-22) — the original handler missed
// `<slug>.localhost:<port>` and emitted `https://prism.localhost:3000/...`
// in dev. This test pins the fix.

import { describe, expect, test } from 'bun:test'
import { buildSlugRenamedTarget } from '../chat.ts'

describe('buildSlugRenamedTarget — production hosts', () => {
  test('emits https for `<slug>.neutron.example`', () => {
    expect(buildSlugRenamedTarget('prism.neutron.example', 'tok', false)).toBe(
      'https://prism.neutron.example/chat?start=tok',
    )
  })

  test('emits https for staging apex (`<slug>.staging.example.com`)', () => {
    expect(
      buildSlugRenamedTarget('prism.staging.example.com', 'tok', false),
    ).toBe('https://prism.staging.example.com/chat?start=tok')
  })

  test('url-encodes the token', () => {
    // JWT base64url is URL-safe, but defensive encoding ensures a future
    // token shape with `+/=` doesn't break the query parse downstream.
    expect(buildSlugRenamedTarget('prism.neutron.example', 'a+b/c', false)).toBe(
      'https://prism.neutron.example/chat?start=a%2Bb%2Fc',
    )
  })
})

describe('buildSlugRenamedTarget — local-apex dev hosts (Codex r1 P3 fix)', () => {
  test('`<slug>.localhost:3000` (dev with NEUTRON_BASE_DOMAIN=localhost:3000) → http', () => {
    expect(buildSlugRenamedTarget('prism.localhost:3000', 'tok', false)).toBe(
      'http://prism.localhost:3000/chat?start=tok',
    )
  })

  test('bare `localhost` → http', () => {
    expect(buildSlugRenamedTarget('localhost', 'tok', false)).toBe(
      'http://localhost/chat?start=tok',
    )
  })

  test('bare `localhost:8080` → http', () => {
    expect(buildSlugRenamedTarget('localhost:8080', 'tok', false)).toBe(
      'http://localhost:8080/chat?start=tok',
    )
  })

  test('`<slug>.neutron.test` (test-suite apex) → http', () => {
    expect(buildSlugRenamedTarget('prism.neutron.test', 'tok', false)).toBe(
      'http://prism.neutron.test/chat?start=tok',
    )
  })

  test('`<slug>.neutron.local` (mDNS LAN apex) → http', () => {
    expect(buildSlugRenamedTarget('prism.neutron.local', 'tok', false)).toBe(
      'http://prism.neutron.local/chat?start=tok',
    )
  })

  test('`127.0.0.1:9090` (literal loopback) → http', () => {
    expect(buildSlugRenamedTarget('127.0.0.1:9090', 'tok', false)).toBe(
      'http://127.0.0.1:9090/chat?start=tok',
    )
  })

  test('`0.0.0.0` (CI bind-all) → http', () => {
    expect(buildSlugRenamedTarget('0.0.0.0', 'tok', false)).toBe(
      'http://0.0.0.0/chat?start=tok',
    )
  })
})

describe('buildSlugRenamedTarget — debug flag propagation', () => {
  test('debugOn=true appends &debug=1', () => {
    expect(buildSlugRenamedTarget('prism.neutron.example', 'tok', true)).toBe(
      'https://prism.neutron.example/chat?start=tok&debug=1',
    )
  })

  test('debugOn=false omits the flag', () => {
    expect(buildSlugRenamedTarget('prism.neutron.example', 'tok', false)).not.toContain(
      'debug',
    )
  })

  test('debugOn=true also fires on local-apex hosts', () => {
    expect(buildSlugRenamedTarget('prism.localhost:3000', 'tok', true)).toBe(
      'http://prism.localhost:3000/chat?start=tok&debug=1',
    )
  })
})
