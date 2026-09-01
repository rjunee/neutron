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
 *   - delete OWNER_HOME and every NEUTRON_* var except the HARNESS vars below
 *     (KEEP_PREFIXES + KEEP_EXACT);
 *   - point NEUTRON_HOME at a fresh per-process scratch dir, so a test that
 *     boots without its own home (see tests/support/test-isolation.ts)
 *     resolves a scratch database rather than a live one, and not ~/neutron on
 *     a self-host box either.
 *
 * WHAT IS KEPT, AND WHY IT IS AN ALLOW-LIST AND NOT A PREFIX RULE. The scrub
 * targets a live instance's CONFIGURATION. A handful of NEUTRON_* vars are not
 * that: they are how a human or a runner ASKS FOR a test run — opt-in gates and
 * harness knobs. Scrubbing one does not fail; it makes the gated suite SKIP,
 * and a skip reports green. That is the exact incident scripts/run-pty-e2e.sh
 * exists to prevent (a suite that had never run anywhere while every summary
 * counted it as passing), so a blanket prefix rule quietly re-opens it. Each
 * entry below is therefore listed, with the runner that sets it:
 *   - NEUTRON_TEST_*      scripts/run-tests.sh + CI thread NEUTRON_TEST_SHARD
 *                         into test processes; scrubbing them would CREATE a
 *                         local/CI divergence instead of closing one.
 *   - NEUTRON_PTY_E2E     scripts/run-pty-e2e.sh, the only way the three PTY
 *                         acceptance suites (incl. the ritual write-containment
 *                         security E2E) ever run.
 *   - NEUTRON_E2E_NETWORK the opt-in real-fetch case in
 *                         cores/free/research/__tests__/web-fetch.test.ts.
 *   - NEUTRON_BUN_BIN     which `bun` the runner + the scripts/ci guard tests
 *                         invoke; scrubbed, a non-default toolchain silently
 *                         becomes bare `bun`.
 * None of them names a database, a home, an identity or a credential, so
 * keeping them cannot reach the live instance. Add to this list only vars with
 * that same property.
 *
 * Tests that need specific values (createIsolatedHome, env-gated suites) set
 * their own AFTER this preload runs; they are unaffected.
 *
 * Scope: `bun test` ONLY (bunfig [test].preload) — and bunfig.toml is resolved
 * from the process CWD, so `cd gateway && bun test …` loads NEITHER preload and
 * is NOT hermetic. Run the suite (and file-scoped runs) from the repo root.
 * Server boot does not load this file, so a real install still reads its real
 * environment at runtime.
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

/** Harness namespaces that survive the scrub — see the header for each. */
const KEEP_PREFIXES = ['NEUTRON_TEST_']
/** Individual harness/opt-in vars that survive the scrub. */
const KEEP_EXACT = new Set(['NEUTRON_PTY_E2E', 'NEUTRON_E2E_NETWORK', 'NEUTRON_BUN_BIN'])

function isHarnessVar(key: string): boolean {
  return KEEP_EXACT.has(key) || KEEP_PREFIXES.some((prefix) => key.startsWith(prefix))
}

for (const key of Object.keys(process.env)) {
  if (key === 'OWNER_HOME' || (key.startsWith('NEUTRON_') && !isHarnessVar(key))) {
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
