/**
 * env-switch.ts — THE ONE SANCTIONED WAY to point a live-proof switch somewhere else.
 *
 * LIVES IN THIS WORKSPACE, not under `tests/support/`, because every suite that needs it
 * is a `runtime` adapter test and the L5 lint gate refuses a relative import that crosses
 * a workspace boundary. The alternative specifier the rule suggests (`neutron/...`) does
 * not resolve at all — there is no self-referencing entry for the root package — so the
 * only form that both lints and runs is one that never crosses. The guard that polices
 * these keys therefore names this path rather than importing from it.
 *
 * `HERDR_SOCKET_PATH` and `NEUTRON_PTY_E2E` are switches: they decide whether the only
 * tests in this repo that can see a real herdr server run at all. A suite that points
 * `HERDR_SOCKET_PATH` at a dead path to keep itself hermetic — several do, and they are
 * right to — disables those proofs for every suite that follows it in the same process
 * if it never puts the value back. That is a coverage hole no coverage measurement can
 * show, because the instrument reports "skipped", which reads as a decision rather than
 * as damage.
 *
 * WHY A HELPER RATHER THAN A RULE ABOUT WRITING THEM CAREFULLY. The guard in
 * `tests/integration/pty-e2e-registered.test.ts` used to accept any file that contained
 * a teardown hook AND a matching `delete` anywhere in it. That is file-scoped, and the
 * obligation is assignment-scoped: a file with two writes and one unrelated restore
 * passed, and so would a second, unscoped assignment added later to a file that already
 * had a correct one. Making this module the only permitted writer turns a recogniser
 * problem into a structural one — there is no pairing to verify, because there is only
 * one writer and it is written once.
 *
 * The prior value is captured WHEN THIS IS CALLED (module scope), not inside
 * `beforeAll`. Bun imports every test file in a chunk before running any hook, so a
 * module-scope capture records the value as it was before ANY suite in the chunk
 * touched it; a capture inside `beforeAll` would record whatever the previous suite's
 * `beforeAll` had already written and then "restore" that instead.
 */
import { afterAll, beforeAll } from 'bun:test'

/**
 * Point `key` at `value` for this test file, and put the previous value back after it.
 *
 * Restoration covers BOTH halves: an absent value is restored by DELETING the key, not
 * by writing the string `"undefined"` — which is truthy, and which every reader of these
 * switches would treat as a real path.
 */
export function pinEnvSwitch(key: string, value: string): void {
  const prior = process.env[key]
  beforeAll(() => {
    process.env[key] = value
  })
  afterAll(() => {
    restoreEnv(key, prior)
  })
}

/**
 * Put `key` back to `prior`, where ABSENT is a value and not a missing one.
 *
 * EXPORTED BECAUSE THE BRANCH IS OTHERWISE UNOBSERVABLE. Inside `afterAll` this runs
 * after the last test in the file, so nothing in the file can see what it did, and two
 * mutations of it — restoring an absent value as the STRING `'undefined'`, and not
 * restoring at all — both survived the guard suite that is supposed to be about exactly
 * this. A helper introduced to close a hole has to be held to the rule it enforces.
 *
 * `'undefined'` is the mutation that matters: it is truthy, and every reader of these
 * switches treats a non-empty value as a real path, so restoring one is worse than
 * leaving the dead path in place — it invents a third state that was never set.
 */
export function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[key]
  else process.env[key] = prior
}

/** The dead path every hermetic suite points `HERDR_SOCKET_PATH` at. Shared so the three
 *  suites that need it cannot drift into three spellings of the same intent. */
export const DEAD_HERDR_SOCKET = '/nonexistent/herdr-test-must-not-connect.sock'
