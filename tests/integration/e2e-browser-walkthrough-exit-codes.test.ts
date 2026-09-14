/**
 * e2e-browser-walkthrough-exit-codes.test.ts — the real-browser walkthrough must
 * never report "could not run" as a failure (#602).
 *
 * `tests/e2e-browser/onboarding_walkthrough.py` documents its own contract in its
 * first docstring: "EXIT CODES — 0 pass, 1 a real failure, **2 could-not-run**.
 * The third one is the point." It exists because the script used to print
 * `E2E SKIP` and exit 0, which made "everything passed" and "nothing was checked"
 * the same observable.
 *
 * It then broke that contract on its FIRST executable line. `from
 * playwright.sync_api import sync_playwright` sat bare at the top of `run()`,
 * above the `server_up()` check, so on a host without the Python Playwright
 * binding the walkthrough died with a traceback and exit 1 — the code reserved
 * for a real failure — before a single assertion had run. Measured on this
 * repository's own build host: exit 1, `ModuleNotFoundError: No module named
 * 'playwright'`, at line 244.
 *
 * The cost was not theoretical. That exit 1 was read as "the walkthrough does not
 * currently pass", which is a statement about the walkthrough. The true statement
 * is "the walkthrough has not been executed", which is a statement about the host
 * — a different problem with a different owner. An instrument that cannot start
 * cannot tell you anything about its subject.
 *
 * WHY THIS TEST IS DETERMINISTIC AND FAST. It points `NEUTRON_BASE_URL` at a
 * closed port, so the walkthrough is guaranteed to reach a could-not-run outcome
 * — whichever prerequisite is missing on the host running this — in well under a
 * second. It never drives a browser and never needs a live install.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const WALKTHROUGH = join(import.meta.dir, '..', 'e2e-browser', 'onboarding_walkthrough.py')

describe('real-browser walkthrough exit codes', () => {
  test('an unrunnable host gets exit 2 and says so — never exit 1', async () => {
    const proc = Bun.spawn(['python3', WALKTHROUGH], {
      // A port nothing listens on, so `server_up()` is false by construction.
      env: { ...process.env, NEUTRON_BASE_URL: 'http://127.0.0.1:1', E2E_ALLOW_SKIP: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    // python3 absent on this host is itself a could-not-run, and saying "the
    // walkthrough is fine" on that basis would be the very confusion this pins.
    if (code === 127) return

    // THE WHOLE POINT: 1 is reserved for a real failure. A prerequisite that is
    // missing — the binding, the server, anything checked before the first
    // assertion — must be distinguishable from a walkthrough that ran and failed.
    expect({ code, stderr: stderr.slice(0, 400) }).toMatchObject({ code: 2 })
    expect(stdout).toContain('E2E COULD NOT RUN')
    // A traceback means it died rather than reported.
    expect(stderr).not.toContain('Traceback')
  })

  // THE CONTRACT IS WRITTEN IN THE FILE, AND THE FILE IS THE THING THAT DRIFTS.
  // A bare top-of-function import is what broke it once; this catches the shape
  // coming back, including for a prerequisite nobody has thought of yet.
  test('no prerequisite import in run() escapes the could-not-run path', async () => {
    const source = await Bun.file(WALKTHROUGH).text()
    const body = source.slice(source.indexOf('def run() -> int:'))
    const firstImport = body.slice(0, body.indexOf('if not server_up()'))
    expect(firstImport).toContain('except ModuleNotFoundError')
    expect(firstImport).toContain('return 2')
  })
})
