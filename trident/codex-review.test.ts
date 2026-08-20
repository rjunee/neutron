/**
 * `trident/codex-review.sh` — the cross-model review wrapper. Ports the legacy harness's
 * codex-review.sh into trident. Verified BEHAVIORALLY by spawning the script with
 * a MOCKED `codex` on PATH + a controllable CODEX_HOME, asserting the EXIT CODE
 * mapping the inner-workflow codex reviewer relies on:
 *
 *   0   connected      — codex ran, verdict on stdout
 *   10  not_connected  — no CODEX_HOME / no auth.json (graceful → Claude-only)
 *   11  not_connected  — codex CLI absent
 *   3   deferred       — configured but the review could not be performed: auth
 *                        precheck failed, or the diff was EMPTY (never silent-approve)
 *   5   deferred       — configured + authed but the review call failed or
 *                        returned no final message (including a refusal)
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'codex-review.sh')
// Spawn bash by ABSOLUTE path: the CLI-absent case runs with a PATH that contains
// nothing at all, so `bash` could not be resolved from it.
const BASH = existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash'

interface RunOpts {
  /** Write an auth.json into CODEX_HOME (the "configured" case). */
  authed?: boolean
  /** Don't set CODEX_HOME at all. */
  noCodexHome?: boolean
  /** Put a mock `codex` on PATH whose `login status` exits with this code. */
  codexLoginExit?: number | null
  /** Mock codex emits NO final message — the refusal shape. */
  mockCodexSilent?: boolean
  /**
   * Write this content to a diff file and point NEUTRON_CODEX_DIFF_FILE at it.
   * Omitted → a small non-empty diff (an empty diff is now DEFERRED, so a test
   * about anything else must hand the script something to review). `null` → no
   * diff file at all, so the script falls back to `git diff` in cwd.
   */
  diffFileContent?: string | null
  /**
   * Shadow `awk` with a stub that fails, so the diff's line count cannot be
   * computed — the disclosure must still fire (fail SAFE, never fail open).
   */
  brokenAwk?: boolean
  env?: Record<string, string>
}

const DEFAULT_DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n+change\n'

function run(opts: RunOpts = {}): {
  status: number | null
  stderr: string
  stdout: string
  /** argv the mock `codex` received on its review invocation ('' if never run). */
  codexArgv: string
  /** the PROMPT the mock `codex` received on stdin ('' if never run). */
  codexStdin: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'trident-codex-'))
  const codexHome = join(dir, 'codexhome')
  mkdirSync(codexHome, { recursive: true })
  if (opts.authed === true) writeFileSync(join(codexHome, 'auth.json'), '{"token":"x"}\n')

  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  // codexLoginExit===null means "no codex CLI anywhere", so PATH is the EMPTY mock
  // bin ONLY — a machine with a real `codex` installed in /usr/bin would otherwise
  // satisfy `command -v codex` and the CLI-absent branch would never be exercised.
  const path =
    opts.codexLoginExit === null
      ? bin
      : `${bin}${delimiter}/usr/bin${delimiter}/bin`
  if (opts.codexLoginExit !== null && opts.codexLoginExit !== undefined) {
    // Mock codex: `login status` → the given exit; anything else → exit 0.
    const mock = join(bin, 'codex')
    // Records the argv of the non-login invocation so the review MODEL flag is
    // observable — an unpinned review is otherwise invisible from the exit code.
    // Also records the PROMPT it was piped on stdin, so the truncation disclosure
    // is observable — a silently-truncated diff is invisible from the exit code.
    writeFileSync(
      mock,
      `#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit ${opts.codexLoginExit}; fi\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir, 'codex-argv.txt'))}\ncat > ${JSON.stringify(join(dir, 'codex-stdin.txt'))}\n${opts.mockCodexSilent === true ? '' : 'echo "mock codex review body"\necho "VERDICT: APPROVE"\n'}exit 0\n`,
    )
    chmodSync(mock, 0o755)
  }
  if (opts.brokenAwk === true) {
    // First on PATH, so it shadows the real awk for this run only.
    const stub = join(bin, 'awk')
    writeFileSync(stub, '#!/bin/sh\nexit 127\n')
    chmodSync(stub, 0o755)
  }
  const env: Record<string, string> = {
    PATH: path,
    NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
    ...(opts.env ?? {}),
  }
  if (opts.noCodexHome !== true) env['CODEX_HOME'] = codexHome
  const diffFileContent = opts.diffFileContent === undefined ? DEFAULT_DIFF : opts.diffFileContent
  if (diffFileContent !== null) {
    const df = join(dir, 'forge.diff')
    writeFileSync(df, diffFileContent)
    env['NEUTRON_CODEX_DIFF_FILE'] = df
  }
  // The cwd is a bare temp dir, NOT a git repo — so the `git diff` fallback yields
  // nothing and every test that needs a diff must hand one over explicitly.
  const res = spawnSync(BASH, [SCRIPT, 'main'], { cwd: dir, encoding: 'utf8', env })
  const readOr = (name: string): string => {
    try {
      return readFileSync(join(dir, name), 'utf8')
    } catch {
      return ''
    }
  }
  return {
    status: res.status,
    stderr: res.stderr ?? '',
    stdout: res.stdout ?? '',
    codexArgv: readOr('codex-argv.txt'),
    codexStdin: readOr('codex-stdin.txt'),
  }
}

describe('trident/codex-review.sh — exit-code contract', () => {
  test('no CODEX_HOME → exit 10 (not connected, graceful)', () => {
    const { status, stderr } = run({ noCodexHome: true })
    expect(status).toBe(10)
    expect(stderr).toContain('NOT_CONNECTED')
  })

  test('CODEX_HOME set but no auth.json → exit 10 (not connected)', () => {
    const { status, stderr } = run({ authed: false, codexLoginExit: 0 })
    expect(status).toBe(10)
    expect(stderr).toContain('NOT_CONNECTED')
  })

  test('configured but codex CLI absent → exit 11 (not connected)', () => {
    const { status, stderr } = run({ authed: true, codexLoginExit: null })
    expect(status).toBe(11)
    expect(stderr).toContain('NOT_CONNECTED')
  })

  test('configured but auth precheck fails → exit 3 (DEFERRED, never silent-approve)', () => {
    const { status, stderr } = run({ authed: true, codexLoginExit: 1 })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_REVIEW_AUTH_EXPIRED')
    expect(stderr).toContain('DEFERRED')
  })

  test('configured + authed + review runs → exit 0 (connected), verdict on stdout', () => {
    const { status, stdout } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; echo "looks good"; echo "VERDICT: APPROVE"' },
    })
    expect(status).toBe(0)
    expect(stdout).toContain('VERDICT: APPROVE')
  })

  test('reviews the explicit NEUTRON_CODEX_DIFF_FILE, not `git diff` in cwd (Codex [P2] fix)', () => {
    // The cwd is a bare temp dir (no git repo) — a `git diff` would yield NOTHING.
    // The diff file carries a unique marker; the codex prompt (piped to exec on
    // stdin) must contain it, proving the file was read instead of git-diffing cwd.
    const { status, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: 'diff --git a/x b/x\n+MARKER_FROM_DIFF_FILE_9f3a\n',
      // Fail the exec unless the marker made it into the piped prompt → asserts the
      // diff file content reached codex.
      env: {
        NEUTRON_CODEX_EXEC_CMD:
          'if grep -q MARKER_FROM_DIFF_FILE_9f3a; then echo "VERDICT: APPROVE"; exit 0; fi; exit 9',
      },
    })
    expect(status).toBe(0)
    expect(stderr).not.toContain('EMPTY_DIFF')
  })

  test('scrubs OPENAI_API_KEY before running codex → subscription OAuth only, never a metered key (Codex [P1])', () => {
    // With OPENAI_API_KEY set in the env, the wrapper must unset it so codex uses
    // the CODEX_HOME OAuth. The exec cmd fails if the key survived into codex's env.
    const { status } = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        OPENAI_API_KEY: 'sk-metered-should-be-scrubbed',
        NEUTRON_CODEX_EXEC_CMD:
          'cat >/dev/null; if [ -n "$OPENAI_API_KEY" ]; then exit 8; fi; echo "VERDICT: APPROVE"',
      },
    })
    expect(status).toBe(0)
  })

  test('configured + authed but the review CALL fails → exit 5 (DEFERRED)', () => {
    const { status, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; exit 7' },
    })
    expect(status).toBe(5)
    expect(stderr).toContain('CODEX_REVIEW_CALL_FAILED')
    expect(stderr).toContain('DEFERRED')
  })
})

describe('trident/codex-review.sh — an EMPTY diff is DEFERRED, never an approval', () => {
  // The seat used to WARN and PROCEED: codex was handed a prompt whose DIFF section
  // was blank and cheerfully answered 'VERDICT: APPROVE' about NOTHING, which the
  // bridge recorded as codexStatus='connected' — a confident cross-model approval of
  // a change nobody read. The open kimi lane already defers here
  // (trident/kimi-review.ts: empty diff → status 'deferred'); this lane must match.
  test('an EMPTY diff FILE → exit 3 (DEFERRED), and codex is never invoked', () => {
    const { status, stderr, codexArgv, codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: '',
    })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_REVIEW_EMPTY_DIFF')
    expect(stderr).toContain('DEFERRED')
    // Nothing was sent to the model at all — no answer to mistake for a verdict.
    expect(codexArgv).toBe('')
    expect(codexStdin).toBe('')
  })

  test('a MISSING diff file with no git diff to fall back on → exit 3 (DEFERRED)', () => {
    // The failure this guards: the diff file failed to write, or the base ref
    // resolved wrong, so `git diff base..HEAD` in a non-repo cwd yields nothing.
    const { status, stderr } = run({ authed: true, codexLoginExit: 0, diffFileContent: null })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_REVIEW_EMPTY_DIFF')
  })

  test('a NEWLINES-ONLY diff file is empty too → exit 3, not a blank-prompt approval', () => {
    const { status, stderr } = run({ authed: true, codexLoginExit: 0, diffFileContent: '\n\n\n' })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_REVIEW_EMPTY_DIFF')
  })

  test('a SPACES/TABS-only diff file is empty too → exit 3, and codex is never invoked', () => {
    // The case `$(...)`-stripping does NOT cover: trailing newlines vanish on their
    // own, but spaces and tabs survive, so a bare `[ -z "$DIFF" ]` would call this
    // content and hand codex a prompt whose DIFF section is blank.
    const { status, stderr, codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: '   \n\t\t\n  ',
    })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_REVIEW_EMPTY_DIFF')
    expect(codexStdin).toBe('')
  })

  test('an empty diff does NOT reach the exec seam either (no exit-0 approval path)', () => {
    // With the test seam configured to APPROVE unconditionally, the ONLY thing that
    // can keep this from exiting 0 is the empty-diff guard firing before it.
    const { status, stdout } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: '',
      env: { NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; echo "VERDICT: APPROVE"' },
    })
    expect(status).toBe(3)
    expect(stdout).not.toContain('VERDICT: APPROVE')
  })
})

describe('exit 0 with an EMPTY final message is DEFERRED, never an approval', () => {
  test('empty output from the exec seam is diagnosed distinctly', () => {
    const { status, stderr, stdout } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; exit 0' },
    })
    expect(status).toBe(5)
    expect(stderr).toContain('CODEX_REVIEW_EMPTY_OUTPUT')
    expect(stderr).toContain('DEFERRED')
    expect(stderr).not.toContain('CODEX_REVIEW_CALL_FAILED')
    expect(stderr).not.toContain('CODEX_REVIEW_REFUSED')
    expect(stdout).not.toContain('VERDICT')
  })

  test('whitespace-only output from the exec seam is empty too', () => {
    const { status, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; printf "  \\n\\n\\t\\n"; exit 0' },
    })
    expect(status).toBe(5)
    expect(stderr).toContain('CODEX_REVIEW_EMPTY_OUTPUT')
  })

  test('content-policy refusal is named and the tool stderr is replayed', () => {
    const { status, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        NEUTRON_CODEX_EXEC_CMD:
          'cat >/dev/null; echo "ERROR: This content was flagged for possible cybersecurity risk." >&2; echo "tokens used: 90,276" >&2; exit 0',
      },
    })
    expect(status).toBe(5)
    expect(stderr).toContain('CODEX_REVIEW_REFUSED')
    expect(stderr).toContain('flagged for possible cybersecurity risk')
    expect(stderr).toContain('DEFERRED')
    expect(stderr).not.toContain('CODEX_REVIEW_CALL_FAILED')
    expect(stderr).not.toContain('CODEX_REVIEW_EMPTY_OUTPUT')
    expect(stderr).toContain('tokens used: 90,276')
  })

  test('refusal-shaped stderr beside a real review remains a successful review', () => {
    const { status, stderr, stdout } = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        NEUTRON_CODEX_EXEC_CMD:
          'cat >/dev/null; echo "warn: flagged for possible cybersecurity risk" >&2; echo "real finding"; echo "VERDICT: APPROVE"; exit 0',
      },
    })
    expect(status).toBe(0)
    expect(stdout).toContain('VERDICT: APPROVE')
    expect(stderr).not.toContain('CODEX_REVIEW_REFUSED')
    expect(stderr).not.toContain('CODEX_REVIEW_EMPTY_OUTPUT')
  })

  test('a real request-changes review is replayed unchanged', () => {
    const { status, stdout } = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        NEUTRON_CODEX_EXEC_CMD:
          'cat >/dev/null; echo "blocker: X"; echo "VERDICT: REQUEST_CHANGES"; exit 0',
      },
    })
    expect(status).toBe(0)
    expect(stdout).toContain('blocker: X')
    expect(stdout).toContain('VERDICT: REQUEST_CHANGES')
  })

  test('empty output from the real codex invocation path is gated too', () => {
    const { status, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      mockCodexSilent: true,
    })
    expect(status).toBe(5)
    expect(stderr).toContain('CODEX_REVIEW_EMPTY_OUTPUT')
  })

  test('a non-zero call with refusal text remains a call failure', () => {
    const { status, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        NEUTRON_CODEX_EXEC_CMD:
          'cat >/dev/null; echo "flagged for possible cybersecurity risk" >&2; exit 7',
      },
    })
    expect(status).toBe(5)
    expect(stderr).toContain('CODEX_REVIEW_CALL_FAILED')
    expect(stderr).not.toContain('CODEX_REVIEW_REFUSED')
  })
})

describe('trident/codex-review.sh — TRUNCATION is disclosed to the model', () => {
  /** A diff of `n` numbered lines; line k is uniquely greppable as `+line-k`. */
  const numberedDiff = (n: number): string =>
    `diff --git a/x b/x\n${Array.from({ length: n - 1 }, (_, i) => `+line-${i + 1}`).join('\n')}\n`

  test('an over-limit diff announces the truncation and the line counts in the PROMPT', () => {
    // 20-line diff, limit 5. Silently, codex would scope a verdict to "the diff"
    // having read a quarter of it — an 11k-line PR approved on its first 3000 lines.
    const { status, codexStdin, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: numberedDiff(20),
      env: { NEUTRON_CODEX_DIFF_LINE_LIMIT: '5' },
    })
    expect(status).toBe(0)
    expect(codexStdin).toContain('TRUNCATED DIFF')
    // The ACTUAL numbers, not a vague hedge: 5 of 20 shown, 15 withheld.
    expect(codexStdin).toContain('FIRST 5 lines of a 20-line diff')
    expect(codexStdin).toContain('remaining 15 lines were NOT provided')
    // …and the verdict is explicitly re-scoped to what was read.
    expect(codexStdin).toContain('SCOPE YOUR VERDICT TO WHAT YOU ACTUALLY READ')
    expect(codexStdin).toContain('reviewed only the first 5 of 20 lines')
    // The truncation is also visible to the operator in the wrapper's stderr.
    expect(stderr).toContain('CODEX_REVIEW_DIFF_TRUNCATED')
    // Truncation still actually happens: line 4 is in, line 6 is out.
    expect(codexStdin).toContain('+line-4')
    expect(codexStdin).not.toContain('+line-6')
  })

  test('a diff AT the limit is not truncated and carries NO truncation notice', () => {
    // Off-by-one guard: exactly DIFF_LINE_LIMIT lines are fully shown, so claiming
    // truncation here would teach the model to hedge a review it read in full.
    const { status, codexStdin, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: numberedDiff(5),
      env: { NEUTRON_CODEX_DIFF_LINE_LIMIT: '5' },
    })
    expect(status).toBe(0)
    expect(codexStdin).toContain('+line-4')
    expect(codexStdin).not.toContain('TRUNCATED')
    expect(codexStdin).not.toContain('SCOPE YOUR VERDICT')
    expect(stderr).not.toContain('CODEX_REVIEW_DIFF_TRUNCATED')
  })

  test('an UNDER-limit diff carries no truncation notice', () => {
    const { codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: numberedDiff(3),
      env: { NEUTRON_CODEX_DIFF_LINE_LIMIT: '5' },
    })
    expect(codexStdin).not.toContain('TRUNCATED')
  })

  test('a diff whose FINAL line is unterminated is counted in full in the disclosure', () => {
    // 6 lines, the 6th unterminated, limit 5 → truncated. This pins the re-termination,
    // not the counter: counting the FILE's newlines (`wc -l < file`) reports 5 for
    // exactly the shape git writes with "\\ No newline at end of file", and the
    // disclosure would then read the absurd "the FIRST 5 lines of a 5-line diff".
    // (The truncation FACT is a string comparison and never depends on this count.)
    const { codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: 'diff --git a/x b/x\n+line-1\n+line-2\n+line-3\n+line-4\n+line-5',
      env: { NEUTRON_CODEX_DIFF_LINE_LIMIT: '5' },
    })
    expect(codexStdin).toContain('FIRST 5 lines of a 6-line diff')
  })

  test('TRAILING BLANK lines do not fake a truncation — the whole diff went out', () => {
    // 4 content lines + 4 trailing blanks, limit 5. Counting the file's lines said
    // "9" and the prompt asserted content had been WITHHELD from a diff codex was
    // handed in full — a false hedge on a review that was actually complete.
    const { codexStdin, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: 'diff --git a/x b/x\n+line-1\n+line-2\n+line-3\n\n\n\n\n',
      env: { NEUTRON_CODEX_DIFF_LINE_LIMIT: '5' },
    })
    expect(codexStdin).toContain('+line-3')
    expect(codexStdin).not.toContain('TRUNCATED')
    expect(stderr).not.toContain('CODEX_REVIEW_DIFF_TRUNCATED')
  })

  test('a BROKEN awk cannot silence the disclosure — it degrades to a hedge, it does not fail open', () => {
    // The line count is cosmetic; the truncation FACT is not. With the count
    // unavailable the wrapper used to run the `-gt` test on an empty string, print
    // "integer expression expected", and hand codex a silently-truncated diff with
    // NO notice at all — exactly the whole-diff-scoped APPROVE this guard exists for.
    const { status, codexStdin, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      brokenAwk: true,
      diffFileContent: numberedDiff(20),
      env: { NEUTRON_CODEX_DIFF_LINE_LIMIT: '5' },
    })
    expect(status).toBe(0)
    expect(codexStdin).toContain('TRUNCATED DIFF')
    expect(codexStdin).toContain('SCOPE YOUR VERDICT TO WHAT YOU ACTUALLY READ')
    expect(codexStdin).toContain('FIRST 5 lines of a LONGER diff')
    expect(stderr).toContain('CODEX_REVIEW_DIFF_TRUNCATED')
    // Still truncated in fact, and no bogus arithmetic leaked into the prompt.
    expect(codexStdin).not.toContain('+line-6')
    expect(codexStdin).not.toContain('integer expression expected')
  })

  test('a broken awk on an UNDER-limit diff still claims nothing (the hedge is not unconditional)', () => {
    const { codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      brokenAwk: true,
      diffFileContent: numberedDiff(3),
      env: { NEUTRON_CODEX_DIFF_LINE_LIMIT: '5' },
    })
    expect(codexStdin).not.toContain('TRUNCATED')
  })

  test('a 2MB diff is prepared in seconds, not minutes (the whitespace guard is O(n), not quadratic)', () => {
    // The guard was `[ -z "${DIFF//[[:space:]]/}" ]`, whose cost in bash is
    // QUADRATIC — ~4x per doubling — and it runs on EVERY review before codex is
    // even called: 3.2s on a normal at-cap diff, and on a diff THIS size it does not
    // finish in two minutes. The `case` form below does it in ~0.12s.
    const big = `diff --git a/x b/x\n${Array.from({ length: 45_000 }, (_, i) => `+line-${i} some payload text here padding padding`).join('\n')}\n`
    expect(big.length).toBeGreaterThan(2 * 1024 * 1024)
    const started = Date.now()
    const { status } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: big,
      // Above the line count, so the WHOLE 2MB reaches the guard — the cap would
      // otherwise hide the cost behind the first 3000 lines and this would measure
      // nothing. A real run pays it on the capped diff, which was already 3.2s.
      env: { NEUTRON_CODEX_DIFF_LINE_LIMIT: '50000' },
    })
    const elapsed = Date.now() - started
    expect(status).toBe(0)
    // WALL-CLOCK-BOUND-OK: this is a COMPLEXITY assertion about a BASH script, and
    // elapsed time is the only observable that separates the O(n) `case` form from
    // the quadratic `${DIFF//[[:space:]]/}` one. Nothing deterministic can replace
    // it: both forms produce the SAME exit code, the SAME stderr and the SAME prompt
    // — every other assertion in this file stays green while the wrapper burns half
    // a minute before codex is even called, which is how the cost went unnoticed in
    // the first place. The margin is measured, not hoped for: 1.3s on this path
    // against 22.5s with the quadratic form restored (a mutation run), so the bound
    // sits 6x above the good path and 3x below the bad one. ISSUES #438.
    expect(elapsed).toBeLessThan(8_000)
  })
})

describe('trident/codex-review.sh — the review MODEL is pinned', () => {
  test('pins gpt-5.6-sol by default', () => {
    // UNPINNED, `codex exec` takes the CLI default, and OpenAI moved auto-review to
    // the cheapest 5.6 tier — so the "independent GPT-5 second opinion" would
    // quietly be served by the weakest model available while every exit code and
    // every other test stayed green. Only the argv shows it.
    const { status, codexArgv } = run({ authed: true, codexLoginExit: 0, diffFileContent: 'diff --git a b\n' })
    expect(status).toBe(0)
    expect(codexArgv).toContain('--model')
    expect(codexArgv).toContain('gpt-5.6-sol')
  })

  test('CODEX_REVIEW_MODEL overrides the pin', () => {
    const { codexArgv } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: 'diff --git a b\n',
      env: { CODEX_REVIEW_MODEL: 'gpt-5.6-thinking' },
    })
    expect(codexArgv).toContain('gpt-5.6-thinking')
    expect(codexArgv).not.toContain('gpt-5.6-sol')
  })

  test('an EXPLICITLY EMPTY CODEX_REVIEW_MODEL falls back to the CLI default', () => {
    // `${VAR-default}` substitutes only when UNSET, so an operator can opt out of
    // pinning entirely. If this used `:-` instead, empty would silently re-pin.
    const { codexArgv } = run({
      authed: true,
      codexLoginExit: 0,
      diffFileContent: 'diff --git a b\n',
      env: { CODEX_REVIEW_MODEL: '' },
    })
    expect(codexArgv).not.toContain('--model')
  })

  test('the prompt still reaches codex on STDIN, not argv', () => {
    // The pin adds argv entries; the diff must still go via stdin or a near-cap
    // diff blows ARG_MAX and fails before codex runs (a false DEFERRED).
    const { codexArgv } = run({ authed: true, codexLoginExit: 0, diffFileContent: 'diff --git a b\n' })
    expect(codexArgv.trim().split('\n')).toEqual(['exec', '--model', 'gpt-5.6-sol', '-'])
  })

  test('an explicit adversarial rubric replaces the generic second-opinion rubric', () => {
    const rubric = 'Independently try to REFUTE this change. ADVERSARIAL_SENTINEL.'
    const { codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_REVIEW_RUBRIC: rubric },
    })
    expect(codexStdin).toContain(rubric)
    expect(codexStdin).not.toContain('giving an INDEPENDENT second opinion')
    expect(codexStdin).toContain(DEFAULT_DIFF.trim())
  })
})

/**
 * THE REVIEW-PHASE LIVENESS HEARTBEAT — `codex-review-alive`.
 *
 * THE COVERAGE HOLE THIS CLOSES. `grep -c stamp_stage trident/codex-review.sh` was 0
 * while the build wrapper's was 7: the review phase emitted NO stage events at all, so
 * for the whole of review the newest event in the ledger was the BUILD's
 * `codex-exec-end` and the orchestrator's hang watchdog — which stands down only on an
 * event newer than its 90-minute threshold — could only ever go stale on it. A watchdog
 * whose evidence is structurally absent during a phase cannot tell a working reviewer
 * from a hung one, so it kills both.
 *
 * Driven against the REAL sqlite through the shipped `stage-stamp.sh`, with a review
 * seam that genuinely sleeps: a mocked clock would prove the arithmetic, not that a
 * background process really writes rows while the model is thinking.
 */
describe('trident/codex-review.sh — the review-phase liveness heartbeat', () => {
  const STAGE_STAMP = join(HERE, 'stage-stamp.sh')

  const withStageDb = <T>(body: (stageDb: string, read: () => string[]) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'trident-codex-review-stage-db-'))
    const stageDb = join(dir, 'project.db')
    seedMigratedDb(stageDb)
    const migrated = new Database(stageDb)
    applyMigrations(migrated)
    migrated.close()
    const read = (): string[] => {
      const db = new Database(stageDb, { readonly: true })
      const rows = db
        .query<{ stage: string }, []>('SELECT stage FROM code_trident_stage_events ORDER BY id')
        .all()
      db.close()
      return rows.map((row) => row.stage)
    }
    try {
      return body(stageDb, read)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const stageEnv = (stageDb: string, runId: string, secs: string): Record<string, string> => ({
    NEUTRON_CODEX_REVIEW_STAGE_SCRIPT: STAGE_STAMP,
    NEUTRON_CODEX_REVIEW_STAGE_DB: stageDb,
    NEUTRON_CODEX_REVIEW_STAGE_RUN_ID: runId,
    NEUTRON_CODEX_REVIEW_HEARTBEAT_SECS: secs,
  })

  test('REAL BEHAVIOUR: a long review beats mid-phase, bracketed by start/end', () => {
    withStageDb((stageDb, read) => {
      const { status, stdout } = run({
        authed: true,
        codexLoginExit: 0,
        env: {
          ...stageEnv(stageDb, 'run-review-heartbeat', '1'),
          NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; sleep 3.4; echo "VERDICT: APPROVE"',
        },
      })
      expect(status).toBe(0)
      const stages = read()
      expect(stages.filter((s) => s === 'codex-review-alive').length).toBeGreaterThanOrEqual(2)
      // Strictly INSIDE the window — evidence during the silence, not at its edges.
      expect(stages.indexOf('codex-review-alive')).toBeGreaterThan(stages.indexOf('codex-review-start'))
      expect(stages.lastIndexOf('codex-review-alive')).toBeLessThan(stages.indexOf('codex-review-end'))
      // AND THE REVIEW TEXT IS UNTOUCHED. This script's stdout IS the verdict the bridge
      // parses; a ticker that leaked one line onto it would corrupt every review.
      expect(stdout).toContain('VERDICT: APPROVE')
      expect(stdout).not.toContain('codex-review-alive')
    })
  }, 30_000)

  test('NEGATIVE CONTROL: the ticker does NOT outlive the review it speaks for', () => {
    withStageDb((stageDb, read) => {
      const { status } = run({
        authed: true,
        codexLoginExit: 0,
        env: {
          ...stageEnv(stageDb, 'run-review-heartbeat-leak', '1'),
          NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; sleep 2.4; echo "VERDICT: APPROVE"',
        },
      })
      expect(status).toBe(0)
      const atExit = read()
      // Positive control for the negative one: it really was ticking.
      expect(atExit.filter((s) => s === 'codex-review-alive').length).toBeGreaterThanOrEqual(1)
      spawnSync('sleep', ['3'])
      expect(read().length).toBe(atExit.length)
    })
  }, 30_000)

  test('NEGATIVE CONTROL: a fast review emits no alive rows, and no stage env emits nothing', () => {
    withStageDb((stageDb, read) => {
      const { status } = run({
        authed: true,
        codexLoginExit: 0,
        env: stageEnv(stageDb, 'run-review-heartbeat-fast', '30'),
      })
      expect(status).toBe(0)
      // The brackets landed, so an empty ledger is not what makes this pass…
      expect(read()).toEqual(['codex-review-start', 'codex-review-end'])

      // …and with the SCRIPT coordinate removed — same database, same run id — the
      // wrapper writes NOTHING MORE, exactly as it did before the heartbeat existed.
      // Asserted against the SAME ledger that just proved it can be written to, so
      // "no new rows" is an observation and not an empty check against an empty db.
      const before = read().length
      const second = run({
        authed: true,
        codexLoginExit: 0,
        env: {
          NEUTRON_CODEX_REVIEW_STAGE_DB: stageDb,
          NEUTRON_CODEX_REVIEW_STAGE_RUN_ID: 'run-review-heartbeat-fast',
        },
      })
      expect(second.status).toBe(0)
      expect(read().length).toBe(before)
    })
  }, 30_000)

  test('a broken stage recorder cannot change the review exit code or its verdict', () => {
    const { status, stdout } = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        ...stageEnv('/nonexistent-dir/does-not-exist.db', 'run-review-heartbeat-broken', '1'),
        NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; sleep 2.4; echo "VERDICT: APPROVE"',
      },
    })
    expect(status).toBe(0)
    expect(stdout).toContain('VERDICT: APPROVE')
  }, 30_000)
})
