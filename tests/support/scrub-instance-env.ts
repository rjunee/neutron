/**
 * bun test preload — per-instance env hermeticity (data home + instance config).
 *
 * `bun test` inherits the invoking shell's environment. On a box that runs a
 * LIVE Neutron instance, that environment carries the instance's own
 * configuration: NEUTRON_DB_PATH (an absolute host filesystem path to the live
 * project.db — and it wins VERBATIM in `resolveOpenDbPath`, over NEUTRON_HOME),
 * OWNER_HOME, NEUTRON_INSTANCE_SLUG, identity/JWT vars (NEUTRON_IDENTITY_*),
 * OAuth client vars (NEUTRON_CORES_GOOGLE_*), onboarding wiring flags, and
 * more. Any test that boots the gateway/composer without arranging its own
 * home then resolves the LIVE data home, where the migration ownership guard
 * (migrations/runner.ts) correctly refuses a runner checkout that is not the
 * recorded owner. Measured 2026-08-31: 10 of 16 lanes / 50 files red locally
 * on main while CI — which has none of these vars and runs the same
 * scripts/run-tests.sh — was green on the same commit. Identity/OAuth vars
 * additionally flipped app surfaces to 401 missing_bearer and the composer to
 * live-cred mode in served/wiring tests.
 *
 * The ownership guard is RIGHT to refuse; the bug was tests reaching the live
 * home at all. This preload gives every `bun test` process the clean baseline
 * CI already has:
 *   - delete OWNER_HOME and every NEUTRON_* var EXCEPT NEUTRON_TEST_* (the
 *     runner knobs scripts/run-tests.sh threads into test processes — CI sets
 *     NEUTRON_TEST_SHARD there, so scrubbing those would CREATE a local/CI
 *     divergence instead of closing one);
 *   - point NEUTRON_HOME at a fresh per-process scratch dir, so a test that
 *     boots without its own home (see tests/support/test-isolation.ts) can
 *     only ever reach a scratch database — never a live one, and never
 *     ~/neutron on a self-host box.
 *
 * Tests that need specific values (createIsolatedHome, env-gated suites) set
 * their own AFTER this preload runs; they are unaffected.
 *
 * Scope: `bun test` ONLY (bunfig [test].preload). Server boot does not load
 * this file, so a real install still reads its real environment at runtime.
 *
 * BOUNDARY — this preload cannot reach CHILD PROCESSES. Measured three times
 * on bun 1.3.13 (2026-08-31): a spawn with the default env hands the child the
 * environ this process STARTED with, not the mutated `process.env`. In one
 * process, spawning `sh -c 'echo "[${PROBE_VAR-MISSING}]"'`:
 *
 *   process.env.PROBE_VAR = 'secret123'  -> child prints [MISSING]
 *   after set-empty                      -> [MISSING]
 *   after delete                         -> [MISSING]
 *   node:child_process execFileSync      -> [MISSING]
 *
 * i.e. neither a set nor a delete here propagates; only an explicit `env:{…}`
 * at the spawn site decides what a child sees. So a test that asserts on what a
 * SPAWNED process reads (e.g. GH_TOKEN/GITHUB_TOKEN reaching a child of the
 * test runner) cannot be fixed by adding the var to the delete list below —
 * that fix was tried and reverted once already, and re-measured twice. It
 * belongs at the spawn site or in the runner's own invocation, not here.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of Object.keys(process.env)) {
  if (key === 'OWNER_HOME' || (key.startsWith('NEUTRON_') && !key.startsWith('NEUTRON_TEST_'))) {
    delete process.env[key]
  }
}

const scratchHome = mkdtempSync(join(tmpdir(), 'neutron-test-home-'))
process.env['NEUTRON_HOME'] = scratchHome

// Best-effort cleanup: 16+ lanes per suite run on a shared box would
// otherwise accumulate scratch homes in tmpdir forever.
process.on('exit', () => {
  try {
    rmSync(scratchHome, { recursive: true, force: true })
  } catch {
    // tmpdir cleanup is advisory; never fail a run over it.
  }
})
