/**
 * `trident/codex-review.sh` — the cross-model review wrapper. Ports the legacy harness's
 * codex-review.sh into trident. Verified BEHAVIORALLY by spawning the script with
 * a MOCKED `codex` on PATH + a controllable CODEX_HOME, asserting the EXIT CODE
 * mapping the inner-workflow codex reviewer relies on:
 *
 *   0   connected      — codex ran, verdict on stdout
 *   10  not_connected  — no CODEX_HOME / no auth.json (graceful → Claude-only)
 *   11  not_connected  — codex CLI absent
 *   3   deferred       — configured but auth precheck failed (never silent-approve)
 *   5   deferred       — configured + authed but the review call failed
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'codex-review.sh')

interface RunOpts {
  /** Write an auth.json into CODEX_HOME (the "configured" case). */
  authed?: boolean
  /** Don't set CODEX_HOME at all. */
  noCodexHome?: boolean
  /** Put a mock `codex` on PATH whose `login status` exits with this code. */
  codexLoginExit?: number | null
  /** Write this content to a diff file and point NEUTRON_CODEX_DIFF_FILE at it. */
  diffFileContent?: string
  env?: Record<string, string>
}

function run(opts: RunOpts = {}): {
  status: number | null
  stderr: string
  stdout: string
  /** argv the mock `codex` received on its review invocation ('' if never run). */
  codexArgv: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'trident-codex-'))
  const codexHome = join(dir, 'codexhome')
  mkdirSync(codexHome, { recursive: true })
  if (opts.authed === true) writeFileSync(join(codexHome, 'auth.json'), '{"token":"x"}\n')

  // Base PATH excludes any real codex (so codexLoginExit===null → CLI missing).
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  let path = `${bin}${delimiter}/usr/bin${delimiter}/bin`
  if (opts.codexLoginExit !== null && opts.codexLoginExit !== undefined) {
    // Mock codex: `login status` → the given exit; anything else → exit 0.
    const mock = join(bin, 'codex')
    // Records the argv of the non-login invocation so the review MODEL flag is
    // observable — an unpinned review is otherwise invisible from the exit code.
    writeFileSync(
      mock,
      `#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit ${opts.codexLoginExit}; fi\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir, 'codex-argv.txt'))}\nexit 0\n`,
    )
    chmodSync(mock, 0o755)
  }
  const env: Record<string, string> = {
    PATH: path,
    NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
    ...(opts.env ?? {}),
  }
  if (opts.noCodexHome !== true) env['CODEX_HOME'] = codexHome
  if (opts.diffFileContent !== undefined) {
    const df = join(dir, 'forge.diff')
    writeFileSync(df, opts.diffFileContent)
    env['NEUTRON_CODEX_DIFF_FILE'] = df
  }
  // Run inside a git repo so `git diff` doesn't error — the temp dir is fine (no
  // repo → empty diff, which the script tolerates).
  const res = spawnSync('bash', [SCRIPT, 'main'], { cwd: dir, encoding: 'utf8', env })
  let codexArgv = ''
  try {
    codexArgv = readFileSync(join(dir, 'codex-argv.txt'), 'utf8')
  } catch {
    codexArgv = ''
  }
  return { status: res.status, stderr: res.stderr ?? '', stdout: res.stdout ?? '', codexArgv }
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
})
