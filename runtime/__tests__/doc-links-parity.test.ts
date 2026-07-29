/**
 * runtime/doc-links.ts — Expo-side mirror parity test (P7.3).
 *
 * The Expo workspace can't import `@neutronai/runtime` (transitive
 * node-only deps). The Expo side keeps a pure-JS mirror at
 * `app/lib/doc-links.ts`. This test imports both and asserts they
 * produce byte-identical URLs for the canonical fixture matrix.
 *
 * Mirrors the convention used by `app/lib/ws-envelope.ts` parity (see
 * docs comment at the top of that file).
 */

import { describe, expect, test } from 'bun:test'

// The doc-link 'web' channel base is env-configured with NO hosted
// default. The runtime helper reads `NEUTRON_WEB_APP_BASE`; the Expo
// mirror reads `EXPO_PUBLIC_NEUTRON_WEB_APP_BASE`. For the parity
// assertions (`appBuild === runtimeBuild`) to hold, BOTH must resolve to
// the SAME value — set them before either module is imported.
const WEB_BASE = 'https://app.neutron.example'
process.env.NEUTRON_WEB_APP_BASE = WEB_BASE
process.env.EXPO_PUBLIC_NEUTRON_WEB_APP_BASE = WEB_BASE

const { buildDocLink: runtimeBuild, parseDocLink: runtimeParse } = await import(
  '../doc-links.ts'
)
const { buildDocLink: appBuild, parseDocLink: appParse } = await import(
  '@neutronai/app/lib/doc-links.ts'
)

const CHANNELS = ['app', 'web', 'telegram'] as const

interface BuildCase {
  project_id: string | null
  path: string
  /** P7.3 — optional 1-indexed line anchor. */
  line?: number
  /** P7.3 — optional 1-indexed inclusive range. */
  range_start?: number
  range_end?: number
}

const BUILD_CASES: BuildCase[] = [
  { project_id: 'acme', path: 'launch-plan.md' },
  { project_id: 'acme', path: 'launch-plan v3.md' },
  { project_id: 'acme', path: 'sub folder/notes (draft)/file #1.md' },
  { project_id: 'proj-42', path: 'x.md' },
  { project_id: 'proj_42', path: 'x.md' },
  { project_id: 'A1B2C3.D4E5', path: 'x.md' },
  { project_id: 'acme', path: '/launch-plan.md' },
  { project_id: 'acme', path: 'a//b///c.md' },
  { project_id: null, path: 'Projects/neutron/STATUS.md' },
  { project_id: null, path: 'entities/people/jane-doe.md' },
  // P7.3 — line anchor fixtures (project-scoped only; vault refs reject).
  { project_id: 'acme', path: 'launch-plan.md', line: 1 },
  { project_id: 'acme', path: 'launch-plan.md', line: 42 },
  { project_id: 'acme', path: 'launch-plan.md', line: 99999 },
  { project_id: 'acme', path: 'sub folder/file.md', line: 7 },
  // P7.3 — range anchor fixtures (parser-reserved; builder honours them too).
  { project_id: 'acme', path: 'launch-plan.md', range_start: 10, range_end: 20 },
  { project_id: 'p1', path: 'a.md', range_start: 1, range_end: 1 },
  // ISSUES #12 — boundary fixtures. Both implementations must accept
  // line === 0x7fffffff (parser upper bound, inclusive) and BOTH must
  // throw on the next integer above.
  { project_id: 'p1', path: 'a.md', line: 0x7fffffff },
  { project_id: 'p1', path: 'a.md', line: 0x7fffffff + 1 },
  { project_id: 'p1', path: 'a.md', range_start: 1, range_end: 0x7fffffff + 1 },
]

const PARSE_CASES: string[] = [
  'neutron://docs/acme/launch-plan.md',
  'neutron://docs/acme/launch-plan%20v3.md',
  'neutron://docs/acme/notes%20(draft)/file%20%231.md',
  // Argus r4 BLOCKING #1 — new canonical web shape.
  `${WEB_BASE}/projects/acme/docs?path=launch-plan.md`,
  `${WEB_BASE}/projects/acme/docs?path=a%2Fb.md`,
  `${WEB_BASE}/projects/acme/docs?path=launch-plan%20v3.md`,
  'https://vault.example.test/Projects/neutron/STATUS.md',
  'docs:/acme/launch-plan.md',
  'docs:/acme/sub/nested.md',
  // Argus r4 IMPORTANT #1 — pre-encoded marker round-trips to literal.
  'docs:/p1/foo%28draft%29.md',
  'docs:/p1/launch%20plan.md',
  'docs:/',
  'docs:/acme',
  'docs:/acme/',
  'docs:/bad id/foo.md',
  'neutron://docs/',
  'neutron://docs/bad id/foo.md',
  'https://example.com',
  '',
  // Argus hardening fixtures — both implementations must reject these.
  'neutron://docs/p1/../../etc/passwd',
  'neutron://docs/p1/%2e%2e/foo.md',
  'neutron://docs/p1//foo.md',
  'neutron://docs/p1/foo.md?next=evil',
  'neutron://docs/p1/foo.md#section',
  // Argus r4 BLOCKING #1 — the old web URL shape MUST NOT parse.
  `${WEB_BASE}/docs/p1/foo.md`,
  `${WEB_BASE}/docs/p1/../../etc/passwd`,
  `${WEB_BASE}/docs/p1/foo.md?x=1`,
  // New shape rejection cases.
  `${WEB_BASE}/projects/p1/docs?path=foo.md&next=evil`,
  `${WEB_BASE}/projects/p1/docs?path=foo.md#evil`,
  `${WEB_BASE}/projects/p1/docs`,
  `${WEB_BASE}/projects/p1/docs?evil`,
  `${WEB_BASE}/projects/p1/notdocs?path=foo.md`,
  'https://vault.example.test/../etc/passwd',
  'https://vault.example.test/Projects/foo.md?evil',
  'docs:/p1/../foo.md',
  'docs:/p1/%2e%2e/foo.md',
  'docs:/p1/foo.md?x=1',
  'docs:/p1/foo.md#anchor',
  // P7.3 — line/range anchor fixtures (parity across runtime + Expo).
  'docs:/proj/a.md?line=1',
  'docs:/proj/a.md?line=42',
  'docs:/proj/a.md?line=99999',
  'docs:/proj/a.md?line=0',          // rejected (1-indexed)
  'docs:/proj/a.md?line=-5',         // rejected
  'docs:/proj/a.md?line=abc',        // rejected
  'docs:/proj/a.md?line=07',         // rejected (leading zero)
  'neutron://docs/proj/a.md?line=42',
  'neutron://docs/proj/a.md?range=10-20',
  'neutron://docs/proj/a.md?range=20-10',  // rejected (M < N)
  'neutron://docs/proj/a.md?range=10',     // rejected (no hyphen)
  `${WEB_BASE}/projects/proj/docs?path=a.md&line=42`,
  `${WEB_BASE}/projects/proj/docs?path=a.md&range=10-20`,
  `${WEB_BASE}/projects/proj/docs?path=a.md&line=42&next=evil`, // rejected
  `${WEB_BASE}/projects/proj/docs?path=a.md&line=0`,            // rejected
  'https://vault.example.test/x.md?line=42',                                  // rejected (vault)
  'https://vault.example.test/x.md?range=1-2',                                // rejected
  'docs:/proj/a.md?line=42#frag',                                                // rejected (fragment)
]

describe('runtime/doc-links ↔ app/lib/doc-links parity', () => {
  for (const ch of CHANNELS) {
    describe(`buildDocLink — channel='${ch}'`, () => {
      for (const c of BUILD_CASES) {
        test(`fixture ${JSON.stringify(c)}`, () => {
          // P7.3 — thread the optional anchor fields through both
          // helpers; assert URL parity for successful builds, and
          // assert BOTH throw for anchor-on-vault-legacy fixtures
          // (mirror builder rejection rules).
          const runtimeInput: Parameters<typeof runtimeBuild>[0] = {
            project_id: c.project_id,
            path: c.path,
            channel: ch,
          }
          const appInput: Parameters<typeof appBuild>[0] = {
            project_id: c.project_id,
            path: c.path,
            channel: ch,
          }
          if (c.line !== undefined) {
            runtimeInput.line = c.line
            appInput.line = c.line
          }
          if (c.range_start !== undefined) {
            runtimeInput.range_start = c.range_start
            appInput.range_start = c.range_start
          }
          if (c.range_end !== undefined) {
            runtimeInput.range_end = c.range_end
            appInput.range_end = c.range_end
          }
          const runtimeShouldThrow =
            (c.project_id === null &&
              (c.line !== undefined ||
                c.range_start !== undefined ||
                c.range_end !== undefined)) ||
            // ISSUES #12 — parity throw on oversized integers.
            (c.line !== undefined && c.line > 0x7fffffff) ||
            (c.range_start !== undefined && c.range_start > 0x7fffffff) ||
            (c.range_end !== undefined && c.range_end > 0x7fffffff)
          if (runtimeShouldThrow) {
            expect(() => runtimeBuild(runtimeInput)).toThrow()
            expect(() => appBuild(appInput)).toThrow()
            return
          }
          const fromRuntime = runtimeBuild(runtimeInput)
          const fromApp = appBuild(appInput)
          expect(fromApp).toBe(fromRuntime)
        })
      }
    })
  }

  describe('parseDocLink — every recognised shape', () => {
    for (const url of PARSE_CASES) {
      test(`fixture ${JSON.stringify(url)}`, () => {
        const fromRuntime = runtimeParse(url)
        const fromApp = appParse(url)
        expect(fromApp).toEqual(fromRuntime)
      })
    }
  })
})
