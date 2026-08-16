/**
 * THE PROVENANCE HAS TO SURVIVE THE COMPOSER, AND NOTHING PROVED THAT.
 *
 * A review round named the exact regression: both seam fields are optional and
 * the wiring reads absence as `true`, so DELETING the composer's propagation
 * still compiles — and every configured production boot then silently refuses
 * to migrate credentials. The failure is invisible; the feature just stops.
 *
 * The composition-field coverage gate catches "the composer stopped setting the
 * field at all". It cannot catch "the composer sets it to the wrong value",
 * which is the half that matters here, because the safe default and the wrong
 * answer are the same literal.
 *
 * So this drives the REAL `buildOpenGraphComposer` and reads the value back off
 * the composition it returns.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'

import { buildOpenGraphComposer } from '../composer.ts'

let home: string
let db: ProjectDb

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neutron-slug-provenance-'))
  db = ProjectDb.open(join(home, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

/** Compose once and report only the field under test. */
async function composedProvenance(
  input: { db: ProjectDb; project_slug: string; slug_is_fallback?: boolean },
): Promise<boolean | undefined> {
  const composer = buildOpenGraphComposer({ env: {
      ...process.env,
      NEUTRON_HOME: home,
      // Composition refuses to sign owner sessions with a predictable fallback.
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'provenance-test-secret-not-a-real-one',
    } })
  const composition = await composer(input)
  return (composition as { slug_is_fallback?: boolean }).slug_is_fallback
}

test('a CONFIGURED boot arrives at the composition as configured', async () => {
  // The regression this exists for: delete the propagation and this becomes
  // `true`, every production boot refuses to migrate, and nothing reports a
  // problem because refusing IS the safe behaviour.
  expect(await composedProvenance({ db, project_slug: 'owner', slug_is_fallback: false })).toBe(
    false,
  )
})

test('a FALLBACK boot arrives at the composition as a fallback', async () => {
  expect(await composedProvenance({ db, project_slug: 'owner', slug_is_fallback: true })).toBe(true)
})

test('a caller that says NOTHING is treated as anonymous, not as configured', async () => {
  // The fail-closed reading, pinned at the seam that decides it. "This caller
  // did not say where the handle came from" and "this process does not know who
  // it is" are the same statement, and the dangerous default would be the
  // comfortable one.
  expect(await composedProvenance({ db, project_slug: 'owner' })).toBe(true)
})
