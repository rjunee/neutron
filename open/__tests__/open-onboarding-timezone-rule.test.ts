/**
 * ISSUES #306 — the onboarding agent must never ask for a timezone, and must
 * actually BE told the one the box already captured.
 *
 * WHY THE OLD TEST DID NOT CATCH THIS. The rule shipped as prose in
 * `onboarding/interview/skills/_envelope.md`, and the sole test guarding it
 * (`onboarding-envelope-timezone-rule.test.ts`, deleted in this change)
 * `readFileSync`'d that same markdown and asserted the string was present in
 * it. It passed forever while the rule reached no LLM: nothing loads that
 * file. A repo-wide search for `_envelope` returns only the unrelated
 * `malformed_envelope` error code in `app-ws-surface.ts` / `controller.ts` —
 * which is precisely the coincidental substring the deleted test's own
 * docstring cited as proof the file was "retained-LIVE". A second, equally
 * unread copy sits in `prompts/onboarding/interview-base.md`. The rule was
 * asserted, and never delivered.
 *
 * THE OTHER HALF. `PhaseSpecInput.known_timezone` was declared at
 * `phase-spec-resolver.ts:147` and assigned by nobody, while the value the
 * owner's browser reported sat one table away: `?tz=` → `app-ws-surface.ts`
 * → `on_client_timezone` → `persistOwnerTimezoneIfChanged` →
 * `instance_metadata.timezone`, with a reader (`readOwnerTimezone`) already
 * written. Capture worked. Nothing ever read it back, so onboarding asked.
 *
 * WHAT THESE TESTS ASSERT AGAINST, and why it is not a config literal: the
 * failure was never "the preamble body is wrong" — it was "the composer never
 * read the timezone". So these drive `buildOwnerOnboardingPreamble`, the
 * function the composer itself calls (`open/composer.ts`, wired into
 * `LiveAgentOnboardingSeam.systemPreamble`), against a REAL migrated DB. That
 * exercises the reader, the live schema and the rendering in one path. A test
 * that passed `known_timezone` in by hand would have stayed green for the
 * entire life of the bug.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { writeOwnerTimezone } from '@neutronai/gateway/storage/owner-metadata.ts'

import { buildOwnerOnboardingPreamble } from '../composer.ts'

const OWNER_SLUG = 'owner'

let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-onboarding-tz-'))
  db = ProjectDb.open(join(tmpDir, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Open onboarding — never-ask-timezone reaches the live preamble (ISSUES #306)', () => {
  test('the prohibition ships even when NO timezone has been captured', () => {
    // Fresh install: `?tz=` has never arrived, so `instance_metadata` holds no
    // timezone. The rule is still unconditional — not knowing the zone was
    // never a licence to ask for it, which is the case the owner actually hit.
    const preamble = buildOwnerOnboardingPreamble(db, OWNER_SLUG, true)

    expect(preamble).toContain('NEVER ask the owner for their timezone')
    expect(preamble).toContain('NEVER ask them to confirm or correct a')
    // With nothing captured there is no value to quote at the agent.
    expect(preamble).not.toContain('Their timezone is already known to be')
  })

  test('a captured timezone is READ BACK OUT of instance_metadata into the preamble', async () => {
    // Exactly what the live capture path persists.
    await writeOwnerTimezone(db, OWNER_SLUG, 'Europe/Berlin')

    const preamble = buildOwnerOnboardingPreamble(db, OWNER_SLUG, true)

    // The assertion the markdown test could never make: the value the owner's
    // browser reported is IN the prompt the model receives.
    expect(preamble).toContain('Their timezone is already known to be Europe/Berlin')
    // Still never ask, now that it is known.
    expect(preamble).toContain('NEVER ask the owner for their timezone')
  })

  test('the read is LIVE — a timezone written after the first build still lands', async () => {
    // The regression this guards is why the composer holds a closure rather
    // than a boot-time constant. On a real install the composer boots BEFORE
    // the browser ever connects, so the `?tz=` write ALWAYS lands after
    // composition. A value frozen at boot is null exactly when onboarding is
    // about to run — broken on every genuine first run, while passing any test
    // that seeded the row up front.
    expect(buildOwnerOnboardingPreamble(db, OWNER_SLUG, true)).not.toContain('Australia/Sydney')

    await writeOwnerTimezone(db, OWNER_SLUG, 'Australia/Sydney')

    expect(buildOwnerOnboardingPreamble(db, OWNER_SLUG, true)).toContain('Australia/Sydney')
  })

  test('the rule is independent of whether the history-import offer is shown', () => {
    // `import_offered` gates a large early block; the timezone rule must not
    // ride on it (the import branch is skipped on boxes with no synthesis
    // substrate, which is where onboarding is most likely to improvise).
    const withImport = buildOwnerOnboardingPreamble(db, OWNER_SLUG, true)
    const withoutImport = buildOwnerOnboardingPreamble(db, OWNER_SLUG, false)

    expect(withImport).toContain('NEVER ask the owner for their timezone')
    expect(withoutImport).toContain('NEVER ask the owner for their timezone')
  })
})
