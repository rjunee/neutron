/**
 * Connect invite/accept surfaces persist NOTHING into GBrain.
 *
 * The invite/accept/reference surfaces (owner-invite issuance, the accept
 * paths, the thin shared-project reference store, the guest refresh, the
 * disclosure) grant access + record a thin reference — they must not contain
 * any direct write into the memory layer. Static guard: none of these source
 * files reference the GBrain write primitives. (The content-sync persister they
 * used to coexist with was deleted with the mesh, connect-spec §2.1.)
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CONNECT_SURFACE_FILES = [
  '../remote-shared-projects-store.ts',
  '../guest-refresh-handler.ts',
  '../invite-preview-handler.ts',
  '../trusted-accept-handler.ts',
  '../../gateway/http/app-connect-invite.ts',
  // `../../landing/connect-accept.ts` + `../../landing/connect-disclosure.ts`
  // were deleted (refactor plan §K1, wave-1 kill — zero non-test importers;
  // the accept/disclosure surfaces they implemented were dead).
]

// GBrain / memory write CALLS that must not appear in any of these surfaces. We
// match invocation/import patterns, not prose, so we check for actual
// call/import shapes only.
const FORBIDDEN_CALL = [/\bwriteEntity\s*\(/, /\bput_page\s*\(/, /\badd_link\s*\(/]

/** Strip line + block comments so prose references don't trip the guard. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('connect invite/accept surfaces persist nothing into GBrain', () => {
  for (const rel of CONNECT_SURFACE_FILES) {
    test(`${rel} makes no GBrain write call`, () => {
      const code = stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'))
      for (const re of FORBIDDEN_CALL) {
        expect(re.test(code), `${rel} must not call ${re.source}`).toBe(false)
      }
    })
  }
})
