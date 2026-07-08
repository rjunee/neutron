/**
 * 2026-05-28 final-handoff sprint — Test 7.
 *
 * Argus-check: the mobile-app URL is referenced exactly once across the
 * codebase. The canonical declaration lives in
 * `contracts/handoff-config.ts` as `MOBILE_APP_URL` (moved there in L2,
 * 2026-07; `onboarding/interview/final-handoff-config.ts` and
 * `landing/server.ts` both re-export it, so the brief's "single
 * source-of-truth constant in landing/server.ts" assertion still holds
 * at the import surface). Every reference to the literal URL string
 * outside those files is a regression.
 */

import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MOBILE_APP_URL } from '../server.ts'
import { MOBILE_APP_URL as MOBILE_APP_URL_CONFIG } from '../../onboarding/interview/final-handoff-config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

describe('MOBILE_APP_URL — single source of truth', () => {
  test('landing/server.ts re-exports the constant from the onboarding config', () => {
    // The URL is env-derived from NEUTRON_WEB_APP_BASE with NO default:
    // empty string when the host is unset (Open local-first), and
    // `<base>/mobile` when configured. Either way the re-export must be
    // the identical value the onboarding config computes.
    expect(MOBILE_APP_URL_CONFIG).toBe(MOBILE_APP_URL)
    expect(typeof MOBILE_APP_URL).toBe('string')
    if (MOBILE_APP_URL.length > 0) {
      expect(new URL(MOBILE_APP_URL).pathname).toBe('/mobile')
    }
  })

  test('no .ts source file hardcodes a mobile-app URL literal — it is env-derived', () => {
    // The mobile-app URL is now derived from NEUTRON_WEB_APP_BASE in
    // exactly one place (onboarding/interview/final-handoff-config.ts) and
    // imported as the MOBILE_APP_URL constant everywhere else. No .ts file
    // may type out a `/mobile` URL literal — the regression we guard is
    // "developer re-hardcoded a host instead of using the env-derived
    // constant". `git grep` exits non-zero when there are no matches, which
    // is exactly the GREEN state, so tolerate that exit code.
    const cmd =
      "git grep -lE '[a-zA-Z]+://[^\"'\\''[:space:]]+/mobile' -- '*.ts' " +
      "':(exclude)**/__tests__/**' " +
      "':(exclude)*.test.ts' " +
      "':(exclude)**/node_modules/**' " +
      "':(exclude)docs/**' " +
      "':(exclude)prompts/**' || true"
    const stdout = execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const files = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    expect(files).toEqual([])
  })
})
