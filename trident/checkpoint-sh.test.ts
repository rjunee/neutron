/**
 * REAL-sqlite tests for `trident/checkpoint.sh` (refactor P10) — the checked-in
 * checkpoint-writer the inner workflow's Bash steps invoke instead of
 * LLM-transcribed inline SQL. Mirrors the merge-realgit.test.ts discipline: the
 * script IS shell + the sqlite3 CLI, so it is exercised against a real
 * throwaway database file, not a mock (no-mock-past-the-seam).
 *
 * What this suite pins (the P10 accept criteria):
 *   1. the UPDATE semantics are UNCHANGED from the inline SQL it replaced —
 *      same columns/values, same WHERE-id row selection, idempotent re-runs;
 *   2. the terminal-result `inner_result_file` path keeps the readfile()
 *      JSON-safe indirection AND the column-consistency CASE (subagent_status
 *      flips to 'completed' ONLY when the result file has non-empty content);
 *   3. writes RETRY under a held lock (PRAGMA busy_timeout=5000 on the same
 *      connection) instead of failing instantly like the old busy_timeout=0;
 *   4. a row that has already reached a TERMINAL phase has its LIVENESS pair
 *      frozen — a surviving detached workflow cannot write a stale `running`
 *      claim (or a fresh heartbeat) back onto a cancelled/reaped run, while its
 *      branch/pr/checkpoint/result still land so the orphan stays traceable.
 *
 * THE THROWAWAY SCHEMA MIRRORS PRODUCTION'S CONSTRAINTS, because a fixture that
 * is laxer than the real table lets a mutant live:
 *   * migration 0077's REAL `phase` CHECK, so a test can only ever seed a phase
 *     production can actually hold. An earlier revision seeded 'Build'/'Review' —
 *     values the CHECK rejects — which meant the terminal guard was never once
 *     exercised against a legal active phase.
 *   * `last_advanced_at TEXT NOT NULL` (migration 0077:118), seeded non-null. An
 *     earlier revision declared it nullable and seeded NULL, a state production
 *     cannot hold — so "freeze the heartbeat only when the old value is NULL"
 *     passed the whole suite.
 *   * `subagent_status`'s nullability, seeded BOTH ways: 'pending' (a fresh run)
 *     and NULL (exactly what `terminalTransition` leaves on a cancelled row) — so
 *     "freeze the status only when the old value is 'pending'" cannot pass either.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERMINAL_PHASES } from './state-machine.ts'
import { terminalRunDisposition } from './run-disposition.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'
import type { TridentPhase, TridentVerdict } from './store.ts'

const SCRIPT = fileURLToPath(new URL('./checkpoint.sh', import.meta.url))

/**
 * Migration 0077's phase CHECK set, verbatim (`0077_code_trident_runs.sql:88-95`).
 * TYPED against `TridentPhase` on purpose: this is a hand-copy of that CHECK, and the
 * annotation is what makes a typo here a typecheck failure instead of a silently
 * narrower fixture.
 */
const ALL_PHASES: readonly TridentPhase[] = [
  'forge-init',
  'ralph-plan',
  'ralph-task',
  'argus',
  'forge-fix',
  'done',
  'failed',
  'stopped',
]
const ACTIVE_PHASES = ALL_PHASES.filter((p) => !(TERMINAL_PHASES as readonly string[]).includes(p))

/**
 * The seeded heartbeat. Production's `last_advanced_at` is NOT NULL and is
 * re-stamped on every transition, so every row carries one — the freeze has to
 * hold a REAL timestamp stable, not merely decline to fill in a NULL.
 */
const SEEDED_HEARTBEAT = '2026-01-01T00:00:00Z'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trident-checkpoint-sh-'))
  dbPath = join(dir, 'trident.db')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE code_trident_runs (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL DEFAULT 'forge-init'
      CHECK (phase IN (${ALL_PHASES.map((p) => `'${p}'`).join(', ')})),
    -- Mirrors migrations/expected-schema.txt:592. REQUIRED: the script's derived
    -- \`round=MAX(round, N)\` SET errors 'no such column' against a fixture without it.
    round INTEGER NOT NULL DEFAULT 1,
    pr INTEGER,
    branch TEXT,
    brief_alert TEXT,
    inner_checkpoint TEXT,
    inner_checkpoint_head TEXT,
    inner_checkpoint_findings TEXT,
    -- Mirrors migrations/expected-schema.txt:619-620 CONSTRAINT AND ALL. Without
    -- the CHECK the fixture accepts values production rejects, and a test can pin
    -- a write that aborts the real UPDATE (Argus r4): an out-of-domain verdict
    -- fails the whole atomic statement, taking branch/checkpoint/result with it.
    inner_verdict TEXT
      CHECK (inner_verdict IS NULL OR inner_verdict IN (
        'APPROVE', 'REQUEST_CHANGES', 'REVIEW_NOT_RUN'
      )),
    inner_result TEXT,
    subagent_status TEXT
      CHECK (subagent_status IS NULL OR subagent_status IN (
        'pending', 'running', 'completed', 'failed', 'crashed'
      )),
    last_advanced_at TEXT NOT NULL
  )`)
  db.exec(
    `INSERT INTO code_trident_runs (id, phase, subagent_status, last_advanced_at)
     VALUES ('run-1', 'forge-init', 'pending', '${SEEDED_HEARTBEAT}'),
            ('run-other', 'forge-init', 'pending', '${SEEDED_HEARTBEAT}')`,
  )
  db.close()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function sh(args: string[]): { code: number; stderr: string } {
  const p = Bun.spawnSync(['bash', SCRIPT, ...args])
  return { code: p.exitCode, stderr: p.stderr.toString() }
}

function row(id: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true })
  const r = db.query('SELECT * FROM code_trident_runs WHERE id = ?').get(id) as Record<string, unknown>
  db.close()
  return r
}

/**
 * A `sqlite3` stand-in first on PATH, recording BOTH channels the script could
 * hand a statement over: its argv and its stdin. Two channels because the fix for
 * the argv-length blocker moved the statement from one to the other, and a capture
 * that reads only `"$*"` would call that move a regression instead of the point.
 * `echo '1|active'` is the outcome line the script's own `case` parses.
 */
function fakeSqlite3(name: string): { binDir: string; sql: () => string; argv: () => string } {
  const binDir = join(dir, name)
  mkdirSync(binDir)
  const argvLog = join(binDir, 'argv.log')
  const sqlLog = join(binDir, 'stdin.sql')
  writeFileSync(
    join(binDir, 'sqlite3'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\ncat >> ${JSON.stringify(sqlLog)}\necho '1|active'\n`,
    { mode: 0o755 },
  )
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
  return { binDir, sql: () => read(sqlLog) + read(argvLog), argv: () => read(argvLog) }
}

describe('checkpoint.sh — C1 per-phase checkpoint write (legacy checkpoint() SQL)', () => {
  test('writes pr/branch/inner_checkpoint/subagent_status + stamps last_advanced_at on ONLY the addressed row', () => {
    const res = sh([dbPath, 'run-1', 'pr', '55', 'branch', 'trident/add-widget', 'inner_checkpoint', 'forge-done', 'subagent_status', 'running'])
    expect(res.code).toBe(0)
    const r = row('run-1')
    expect(r.pr).toBe(55)
    expect(r.branch).toBe('trident/add-widget')
    expect(r.inner_checkpoint).toBe('forge-done')
    expect(r.subagent_status).toBe('running')
    // Timestamp computed in-script, like the old Bash step. MILLISECONDS are the
    // preferred shape (`date -u +%FT%T.%3NZ`) because the wake-on-change watcher
    // detects a checkpoint through that run's own `last_advanced_at` entry in
    // `changeSignature()`, and two writes inside one second collapse into one
    // signature; the whole-second form is the documented fallback for a `date`
    // without the GNU `%3N` extension, so BOTH are accepted here and the sub-second
    // case is pinned separately below.
    expect(String(r.last_advanced_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    // Untouched columns stay untouched; other rows are never selected.
    expect(r.inner_result).toBeNull()
    expect(row('run-other')).toMatchObject({ subagent_status: 'pending', branch: null, inner_checkpoint: null })
  })

  test('re-running the SAME checkpoint is idempotent (identical row state)', () => {
    const args = [dbPath, 'run-1', 'branch', 'trident/add-widget', 'inner_checkpoint', 'forge-done', 'subagent_status', 'running']
    expect(sh(args).code).toBe(0)
    const first = { ...row('run-1'), last_advanced_at: null }
    expect(sh(args).code).toBe(0)
    const second = { ...row('run-1'), last_advanced_at: null }
    expect(second).toEqual(first)
  })

  test('SQL-escapes values (a single quote cannot break or inject the statement)', () => {
    const res = sh([dbPath, 'run-1', 'branch', "tri'dent", 'inner_checkpoint', "fix'; DROP TABLE code_trident_runs; --"])
    expect(res.code).toBe(0)
    expect(row('run-1').branch).toBe("tri'dent")
    expect(row('run-1').inner_checkpoint).toBe("fix'; DROP TABLE code_trident_runs; --")
  })

  test('brief_alert is whitelisted and SQL-escapes a single quote without truncation', () => {
    const alert = "CODEX_BUILD_BRIEF_PART_CORRUPT: it's truncated'; DROP TABLE code_trident_runs; --"
    const res = sh([dbPath, 'run-1', 'brief_alert', alert])
    expect(res.code).toBe(0)
    expect(row('run-1').brief_alert).toBe(alert)
    expect(row('run-other').brief_alert).toBeNull()
  })

  test('brief_alert records evidence without re-stamping the active-run heartbeat', () => {
    const alert = 'CODEX_BUILD_BRIEF_PART_CORRUPT: recovered. DEFERRED.'
    const res = sh([dbPath, 'run-1', 'brief_alert', alert])

    expect(res.code).toBe(0)
    expect(row('run-1')).toMatchObject({
      brief_alert: alert,
      last_advanced_at: SEEDED_HEARTBEAT,
    })
  })
})

describe('checkpoint.sh — terminal-result write (legacy writeTerminalResult() SQL)', () => {
  const json = '{"ok":true,"verdict":"APPROVE","prNumber":55,"branch":"trident/add-widget","round":1,"checkpoint":"argus-approved"}'

  test('inner_result_file loads the JSON via read_file_literal and flips subagent_status to completed; idempotent', () => {
    const tmp = join(dir, 'terminal.json')
    writeFileSync(tmp, json)
    const args = [dbPath, 'run-1', 'inner_result_file', tmp, 'inner_verdict', 'APPROVE', 'branch', 'trident/add-widget', 'pr', '55']
    expect(sh(args).code).toBe(0)
    const first = row('run-1')
    // The JSON round-trips byte-identically (materialised as a SQL literal by
    // `read_file_literal` — its own double quotes never break the statement).
    expect(first.inner_result).toBe(json)
    expect(first.inner_verdict).toBe('APPROVE')
    expect(first.subagent_status).toBe('completed')
    expect(first.pr).toBe(55)
    // Idempotent re-run → same row state.
    expect(sh(args).code).toBe(0)
    expect({ ...row('run-1'), last_advanced_at: null }).toEqual({ ...first, last_advanced_at: null })
  })

  test('COLUMN CONSISTENCY: an EMPTY result file leaves subagent_status untouched (never completed-with-no-result)', () => {
    const tmp = join(dir, 'empty.json')
    writeFileSync(tmp, '')
    expect(sh([dbPath, 'run-1', 'inner_result_file', tmp, 'inner_verdict', 'APPROVE', 'branch', 'b']).code).toBe(0)
    const r = row('run-1')
    expect(r.subagent_status).toBe('pending') // unchanged — the CASE fell through to ELSE
    expect(r.inner_result).toBe('') // an empty file → empty text, not terminal (parseInnerResult → null)
  })

  test('COLUMN CONSISTENCY: a MISSING result file leaves inner_result NULL and subagent_status untouched', () => {
    expect(sh([dbPath, 'run-1', 'inner_result_file', join(dir, 'nope.json'), 'inner_verdict', 'APPROVE', 'branch', 'b']).code).toBe(0)
    const r = row('run-1')
    expect(r.inner_result).toBeNull()
    expect(r.subagent_status).toBe('pending')
  })
})

describe('checkpoint.sh — the checkpoint records WHICH COMMIT it applied to (0122)', () => {
  // The name alone could not tell a resumed run whether the branch still holds the
  // code the checkpoint was about, which is why every relaunch had to rebuild. The
  // OID lands in the SAME UPDATE as the name, so the pair is atomic.
  test('inner_checkpoint_head is written beside the checkpoint name, in one statement', () => {
    const res = sh([dbPath, 'run-1', 'inner_checkpoint', 'forge-done', 'inner_checkpoint_head', 'a'.repeat(40)])
    expect(res.code).toBe(0)
    const r = row('run-1')
    expect(r.inner_checkpoint).toBe('forge-done')
    expect(r.inner_checkpoint_head).toBe('a'.repeat(40))
    expect(row('run-other').inner_checkpoint_head).toBeNull()
  })

  test('an EMPTY head CLEARS the previous one (a phase with no sha must not inherit)', () => {
    sh([dbPath, 'run-1', 'inner_checkpoint', 'fix-round-2', 'inner_checkpoint_head', 'a'.repeat(40)])
    const res = sh([dbPath, 'run-1', 'inner_checkpoint', 'fix-round-3', 'inner_checkpoint_head', ''])
    expect(res.code).toBe(0)
    const r = row('run-1')
    expect(r.inner_checkpoint).toBe('fix-round-3')
    // NOT the round-2 sha: a stale OID next to a fresh name is exactly the pairing
    // a resume would misread as "this code was already reviewed".
    expect(r.inner_checkpoint_head).toBe('')
  })

  test('inner_findings_file loads the findings JSON via read_file_literal, quotes and all', () => {
    const tmp = join(dir, 'findings.json')
    const findings = [{ severity: 'blocker', title: "it's broken", evidence: 'a.ts:1' }]
    writeFileSync(tmp, JSON.stringify(findings))
    const res = sh([dbPath, 'run-1', 'inner_checkpoint', 'argus-request-changes', 'inner_findings_file', tmp])
    expect(res.code).toBe(0)
    expect(JSON.parse(String(row('run-1').inner_checkpoint_findings))).toEqual(findings)
  })

  test('a MISSING findings file leaves the column NULL and never fails the build', () => {
    const res = sh([dbPath, 'run-1', 'inner_checkpoint', 'argus-request-changes', 'inner_findings_file', join(dir, 'nope.json')])
    expect(res.code).toBe(0)
    expect(row('run-1').inner_checkpoint_findings).toBeNull()
    // The checkpoint itself still landed — a resume then re-reviews rather than
    // fixing blind, which is the safe degrade.
    expect(row('run-1').inner_checkpoint).toBe('argus-request-changes')
  })

  test('the findings write does NOT flip subagent_status (a mid-run checkpoint is not a result)', () => {
    const tmp = join(dir, 'findings.json')
    writeFileSync(tmp, '[{"severity":"blocker"}]')
    sh([dbPath, 'run-1', 'inner_findings_file', tmp])
    expect(row('run-1').subagent_status).toBe('pending')
  })
})

describe('checkpoint.sh — argument validation (fail loudly, touch nothing)', () => {
  test.each([
    [['run-1', 'pr', 'abc'], 'pr must be a non-negative integer'],
    [['run-1', 'pr', ''], 'pr must be a non-negative integer'],
    [['run-1', 'evil_field', 'x'], "unknown field 'evil_field'"],
    [['run-1', 'branch'], "missing value for field 'branch'"],
    [['run-1'], 'no fields given'],
  ])('rejects %j', (args, message) => {
    const res = sh([dbPath, ...(args as string[])])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain(message as string)
    expect(row('run-1').branch).toBeNull() // nothing written
  })
})

describe('checkpoint.sh — a TERMINAL row freezes its LIVENESS pair, and ONLY that pair', () => {
  // Cancelling a build writes the terminal phase but does NOT kill the detached
  // workflow (rjunee/neutron#177): it keeps building and its next checkpoint would
  // otherwise put `subagent_status='running'` (+ a fresh `last_advanced_at`)
  // straight back onto the terminal row — re-creating the stale "still running"
  // claim the store's `terminalTransition` retracts. This is the durability half
  // of that fix.
  //
  // The orphan's branch/pr/checkpoint/result DO still land. They are inert on a
  // terminal row (`step()` no-ops on it, so nothing resumes or harvests), but
  // while #177 stands they are the ONLY trail back to work the orphan did after
  // the cancel — a branch it pushed, a PR it opened.
  function setPhase(id: string, phase: string): void {
    const db = new Database(dbPath)
    db.run('UPDATE code_trident_runs SET phase = ? WHERE id = ?', [phase, id])
    db.close()
  }

  test('the throwaway schema rejects a phase production cannot hold (so the cases below are legal ones)', () => {
    // Guards this suite against its own earlier bug: seeding 'Build'/'Review'
    // meant the freeze was never once exercised against a real active phase.
    expect(() => setPhase('run-1', 'Build')).toThrow()
    expect(() => setPhase('run-1', 'Review')).toThrow()
  })

  test.each([...TERMINAL_PHASES])(
    'a per-phase checkpoint against a %s run freezes liveness, records the trail, and does not fail the build',
    (phase) => {
      setPhase('run-1', phase)
      // Non-empty precondition: terminal, still carrying its old claim, no trail yet.
      expect(row('run-1')).toMatchObject({
        phase,
        subagent_status: 'pending',
        last_advanced_at: SEEDED_HEARTBEAT,
        branch: null,
        pr: null,
        inner_checkpoint: null,
      })

      const res = sh([dbPath, 'run-1', 'pr', '55', 'branch', 'trident/add-widget', 'inner_checkpoint', 'forge-done', 'subagent_status', 'running'])

      // Exit 0 — the checkpoint step must never fail the build.
      expect(res.code).toBe(0)
      expect(res.stderr).toContain('already terminal')
      const r = row('run-1')
      // FROZEN — the two liveness columns.
      expect(r.subagent_status).toBe('pending') // NOT resurrected to 'running'
      expect(r.last_advanced_at).toBe(SEEDED_HEARTBEAT) // heartbeat HELD, not re-stamped
      expect(r.phase).toBe(phase)
      // RECORDED — everything else, so the orphan stays traceable from the row.
      expect(r.pr).toBe(55)
      expect(r.branch).toBe('trident/add-widget')
      expect(r.inner_checkpoint).toBe('forge-done')
    },
  )

  test('the TERMINAL-RESULT write records the result but never flips liveness to completed', () => {
    const tmp = join(dir, 'terminal.json')
    writeFileSync(tmp, '{"ok":true,"verdict":"APPROVE"}')
    setPhase('run-1', 'stopped')
    expect(row('run-1')).toMatchObject({ inner_result: null, inner_verdict: null, subagent_status: 'pending' })

    const res = sh([dbPath, 'run-1', 'inner_result_file', tmp, 'inner_verdict', 'APPROVE', 'branch', 'b'])

    expect(res.code).toBe(0)
    expect(res.stderr).toContain('already terminal')
    expect(row('run-1')).toMatchObject({
      inner_result: '{"ok":true,"verdict":"APPROVE"}',
      inner_verdict: 'APPROVE',
      branch: 'b',
      // The readfile CASE would have written 'completed'; the terminal freeze wins.
      subagent_status: 'pending',
      last_advanced_at: SEEDED_HEARTBEAT,
    })
  })

  test('brief_alert is recorded on a terminal row without thawing liveness', () => {
    setPhase('run-1', 'failed')
    const alert = 'CODEX_BUILD_BRIEF_PART_MISSING: brief part vanished. DEFERRED.'

    const res = sh([dbPath, 'run-1', 'brief_alert', alert])

    expect(res.code).toBe(0)
    expect(res.stderr).toContain('already terminal')
    expect(row('run-1')).toMatchObject({
      brief_alert: alert,
      subagent_status: 'pending',
      last_advanced_at: SEEDED_HEARTBEAT,
    })
  })

  // THE TWO MUTANTS THESE CASES EXIST TO KILL. Both narrow `frozen()`
  // (trident/checkpoint.sh) by one extra AND-clause on the OLD column value, and
  // both were RUN: each survives the earlier, laxer fixture and dies under this one.
  //
  //   (a) freeze `subagent_status` only when the OLD value is 'pending'. Every
  //       other case above seeds 'pending', so the mutant passed them all. The
  //       state it breaks is the one `terminalTransition` itself creates: it NULLs
  //       a live claim, so the very next checkpoint after a cancel sees NULL — and
  //       the mutant would write 'running' back, re-creating the exact bug.
  //   (b) freeze `last_advanced_at` only when the OLD value is NULL. Production's
  //       column is NOT NULL, so that condition can never hold there; under the
  //       old NULL-seeded fixture it always held, and the mutant refreshed the
  //       heartbeat of every real finished run while the suite stayed green.
  test.each([...TERMINAL_PHASES])(
    'a %s run whose live claim was ALREADY retracted keeps subagent_status NULL and holds its heartbeat',
    (phase) => {
      const db = new Database(dbPath)
      // Exactly the row `terminalTransition` leaves behind: terminal phase, claim
      // NULLed, heartbeat stamped at the moment of the cancel.
      db.run(`UPDATE code_trident_runs SET phase = ?, subagent_status = NULL WHERE id = 'run-1'`, [phase])
      db.close()
      expect(row('run-1')).toMatchObject({ phase, subagent_status: null, last_advanced_at: SEEDED_HEARTBEAT })

      const res = sh([dbPath, 'run-1', 'inner_checkpoint', 'forge-done', 'subagent_status', 'running'])

      expect(res.code).toBe(0)
      const r = row('run-1')
      expect(r.subagent_status).toBeNull() // kills mutant (a)
      expect(r.last_advanced_at).toBe(SEEDED_HEARTBEAT) // kills mutant (b)
      expect(r.inner_checkpoint).toBe('forge-done') // the trail still lands
    },
  )

  test('the TERMINAL-RESULT write also holds an already-NULL claim and a real heartbeat', () => {
    const tmp = join(dir, 'terminal.json')
    writeFileSync(tmp, '{"ok":true,"verdict":"APPROVE"}')
    const db = new Database(dbPath)
    db.run(`UPDATE code_trident_runs SET phase = 'stopped', subagent_status = NULL WHERE id = 'run-1'`)
    db.close()

    expect(sh([dbPath, 'run-1', 'inner_result_file', tmp, 'inner_verdict', 'APPROVE']).code).toBe(0)

    // WHY THIS CASE EXISTS, precisely — the sibling test above looks like it already
    // covers the readfile path, and it does not cover the same mutant. This branch does
    // NOT route through `frozen()`: `inner_result_file` builds its own copy of the
    // terminal predicate inline (checkpoint.sh:147), so mutant (a) — which narrows
    // `frozen()` — cannot reach here at all and this test passes under it (executed:
    // (a) takes 3 tests red, none of them this one). What the SECOND copy needs is its
    // own mutants, and this row's already-NULL claim is what kills the (a)-shaped one:
    // adding `AND subagent_status = 'pending'` to that inline freeze arm leaves the
    // sibling above green (it seeds 'pending', which the narrowed arm still freezes) and
    // reddens ONLY this case — 1 fail, verified by execution. Dropping the arm outright
    // reddens both.
    expect(row('run-1')).toMatchObject({
      subagent_status: null,
      last_advanced_at: SEEDED_HEARTBEAT,
      inner_result: '{"ok":true,"verdict":"APPROVE"}',
    })
  })

  test.each([...ACTIVE_PHASES])(
    'a %s run is written normally — the freeze is not a blanket refusal, and it keys on the REAL active set',
    (phase) => {
      setPhase('run-1', phase)
      expect(sh([dbPath, 'run-1', 'inner_checkpoint', 'argus-approved', 'subagent_status', 'running']).code).toBe(0)
      const r = row('run-1')
      expect(r.inner_checkpoint).toBe('argus-approved')
      expect(r.subagent_status).toBe('running')
      expect(String(r.last_advanced_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    },
  )

  test('two checkpoints inside ONE SECOND leave two DISTINCT last_advanced_at values', () => {
    // THE WAKE THAT USED TO BE LOST. `TridentRunStore.changeSignature()` — the
    // watcher's whole detector — is a PER-RUN list of `id:last_advanced_at`, so two
    // whole-second stamps on the SAME row inside one second are ONE signature and the
    // second checkpoint waits out the 90 s backstop: exactly the latency the watcher
    // exists to remove. Two writes back to back is the ordinary case (a phase that
    // checkpoints twice quickly), not a contrived one.
    //
    // Retried until the pair genuinely shares a second, because that is the case
    // under test and a boundary crossing would otherwise assert nothing. Bounded, so
    // a slow box cannot hang the suite.
    let first = ''
    let second = ''
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(sh([dbPath, 'run-1', 'inner_checkpoint', 'forge-done']).code).toBe(0)
      first = String(row('run-1').last_advanced_at)
      expect(sh([dbPath, 'run-1', 'inner_checkpoint', 'argus-approved']).code).toBe(0)
      second = String(row('run-1').last_advanced_at)
      if (first.slice(0, 19) === second.slice(0, 19)) break
    }

    // The FALLBACK is a supported configuration (a `date` without the GNU `%3N`
    // extension), so the assertion is keyed to what this platform actually produced
    // rather than asserting a precision the script does not promise everywhere.
    if (/\.\d{3}Z$/.test(first)) {
      expect(first.slice(0, 19)).toBe(second.slice(0, 19))
      expect(second).not.toBe(first)
      // Chronological order survives the string comparison the signature relies on
      // once the trailing 'Z' is stripped — which is exactly what the store's MAX
      // does, because 'Z' sorts ABOVE '.' and the raw strings compare backwards.
      expect(second.replace('Z', '') > first.replace('Z', '')).toBe(true)
    } else {
      expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      expect(second.replace('Z', '') >= first.replace('Z', '')).toBe(true)
    }
  })

  // NOT TESTED HERE, deliberately, and worth saying why rather than leaving a gap that
  // looks like an oversight: the stderr branches parse sqlite3's list-mode 'N|state'
  // line, so the script pins `-init /dev/null -list -separator '|'` to stop a host
  // `~/.sqliterc` muting them. A fixture for it was written and then DELETED because it
  // could not fail — measured on sqlite3 3.43.2 (Apple), a `.sqliterc` is honoured when
  // passed as `-init <file>` (output becomes 'c;s\n0;active\n') but is NOT picked up
  // from a `HOME` override, so the hostile-rc test passed identically with the pins
  // removed. A test that cannot fail is zero coverage wearing a green tick. Covering it
  // for real would mean writing into the developer's actual home directory, which no
  // test may do; the pins stay as environment hardening for CLI builds that DO read it.
  test('an unknown run id reports the skip rather than passing silently', () => {
    const res = sh([dbPath, 'no-such-run', 'inner_checkpoint', 'forge-done'])
    expect(res.code).toBe(3)
    expect(res.stderr).toContain('not found — checkpoint NOT applied')
  })
})

describe('checkpoint.sh derives the round from the checkpoint name', () => {
  // THE MEASUREMENT: 215 of 224 runs in the 30 days to 2026-08-31 sat at round 1
  // while their `inner_checkpoint` recorded fix-round-2..7. The store's TS seam
  // already derives the round from the checkpoint name (`store.ts` update() →
  // `checkpointRound`), but the LIVE inner workflow does not checkpoint through
  // it — it invokes THIS script, which never wrote `round` at all. That asymmetry
  // is the defect these cases pin.
  function setPhase(id: string, phase: string): void {
    const db = new Database(dbPath)
    db.run('UPDATE code_trident_runs SET phase = ? WHERE id = ?', [phase, id])
    db.close()
  }

  test('a fix-round-N checkpoint records round N, monotonically and idempotently', () => {
    expect(row('run-1').round).toBe(1) // precondition: the seeded default

    expect(sh([dbPath, 'run-1', 'inner_checkpoint', 'fix-round-3']).code).toBe(0)
    expect(row('run-1').round).toBe(3)

    // MONOTONIC — an out-of-order (or re-fired) checkpoint may not walk it back.
    expect(sh([dbPath, 'run-1', 'inner_checkpoint', 'fix-round-2']).code).toBe(0)
    expect(row('run-1').round).toBe(3)

    // IDEMPOTENT — re-running the same checkpoint yields the same row state.
    expect(sh([dbPath, 'run-1', 'inner_checkpoint', 'fix-round-3']).code).toBe(0)
    expect(row('run-1').round).toBe(3)
  })

  test('an outer-published checkpoint records its LAST numeric field (the round, not remaining tasks)', () => {
    const oid = 'a'.repeat(40)
    expect(sh([dbPath, 'run-1', 'inner_checkpoint', `outer-published:${oid}:2:6:deviated`]).code).toBe(0)
    expect(row('run-1').round).toBe(6)
  })

  test.each(['forge-done', 'argus-request-changes-round-4', 'argus-approved', 'inner-error', ''])(
    'a checkpoint that carries no round (%p) leaves the column untouched',
    (checkpoint) => {
      // `argus-request-changes-round-N` names a round and is DELIBERATELY not
      // parsed — `checkpointRound` enumerates exactly two shapes and forbids
      // guessing; the bash mirror must forbid the same one.
      expect(sh([dbPath, 'run-1', 'inner_checkpoint', checkpoint]).code).toBe(0)
      expect(row('run-1').round).toBe(1)
      expect(row('run-1').inner_checkpoint).toBe(checkpoint)
    },
  )

  test('a leading-zero round normalizes like Number() does, not as octal', () => {
    expect(sh([dbPath, 'run-1', 'inner_checkpoint', 'fix-round-007']).code).toBe(0)
    expect(row('run-1').round).toBe(7)
  })

  test('a TERMINAL row still records the round — it is evidence, like branch/pr, never control flow', () => {
    setPhase('run-1', 'failed')
    expect(row('run-1')).toMatchObject({ round: 1, subagent_status: 'pending', last_advanced_at: SEEDED_HEARTBEAT })

    const res = sh([dbPath, 'run-1', 'inner_checkpoint', 'fix-round-5', 'subagent_status', 'running'])

    expect(res.code).toBe(0)
    expect(res.stderr).toContain('already terminal')
    const r = row('run-1')
    expect(r.round).toBe(5) // RECORDED — the orphan's trail stays readable
    expect(r.subagent_status).toBe('pending') // FROZEN
    expect(r.last_advanced_at).toBe(SEEDED_HEARTBEAT) // FROZEN
  })

  test('only the addressed row moves', () => {
    expect(sh([dbPath, 'run-1', 'inner_checkpoint', 'fix-round-4']).code).toBe(0)
    expect(row('run-other').round).toBe(1)
  })
})

describe('checkpoint.sh — a REJECTION MUST STATE A REASON (the write-site precondition)', () => {
  const REAL = '[{"severity":"blocker","title":"a reviewer actually said this"}]'

  function findingsFile(name: string, content: string): string {
    const f = join(dir, name)
    writeFileSync(f, content)
    return f
  }

  test('POSITIVE CONTROL: a genuine review with real findings still records REQUEST_CHANGES', () => {
    // Read this first. Every refusal below is only evidence if the honest path
    // still lands — a guard that refused everything would pass all of them.
    const res = sh([
      dbPath, 'run-1',
      'inner_checkpoint', 'argus-request-changes-round-2',
      'inner_findings_file', findingsFile('real.json', REAL),
      'inner_verdict', 'REQUEST_CHANGES',
    ])
    expect(res.code).toBe(0)
    expect(res.stderr).not.toContain('REFUSED')
    const r = row('run-1')
    expect(r.inner_verdict).toBe('REQUEST_CHANGES')
    expect(r.inner_checkpoint_findings).toBe(REAL)
  })

  test('the findings may already be on the ROW — the check reads the effective value, not just this invocation', () => {
    // The live shape: the review checkpoint writes findings, and the LATER
    // terminal write brings the verdict. SQLite evaluates every RHS against the
    // OLD row, so `inner_checkpoint_findings` in the guard is what is already
    // recorded.
    expect(sh([dbPath, 'run-1', 'inner_findings_file', findingsFile('prior.json', REAL)]).code).toBe(0)
    const res = sh([dbPath, 'run-1', 'inner_verdict', 'REQUEST_CHANGES'])
    expect(res.code).toBe(0)
    expect(res.stderr).not.toContain('REFUSED')
    expect(row('run-1').inner_verdict).toBe('REQUEST_CHANGES')
  })

  test('an EMPTY inner_verdict CLEARS the column to SQL NULL — the schema has no empty string in its domain', () => {
    // The verdict write moved below the argument loop (a REQUEST_CHANGES is only
    // legal alongside findings, which a LATER argument may bring). Gating that
    // deferred write on `[ -n "$value" ]` silently changed one behaviour that had
    // nothing to do with the guard: `inner_verdict ''` did nothing at all. An empty
    // value is a CLEARING write here, exactly as it is for `inner_checkpoint_head`.
    //
    // NULL, not '' (Argus r4): the production CHECK admits only NULL or one of the
    // three verdicts, so writing '' aborts the ENTIRE atomic UPDATE and the same
    // statement's branch/checkpoint/result are lost with it. The fixture above now
    // carries that CHECK, so this test can only pass against a write the real
    // schema would accept.
    expect(sh([dbPath, 'run-1', 'inner_verdict', 'APPROVE']).code).toBe(0)
    expect(row('run-1').inner_verdict).toBe('APPROVE')
    expect(sh([dbPath, 'run-1', 'inner_verdict', '']).code).toBe(0)
    expect(row('run-1').inner_verdict).toBe(null)
  })

  test('the CLEARING write does not cost the rest of its own UPDATE', () => {
    // The failure mode the NULL exists to prevent, stated as behaviour: an aborted
    // UPDATE would leave the branch and checkpoint from the SAME invocation
    // unwritten — checkpoint.sh's "blind row" it refuses to trade a column for.
    const res = sh([
      dbPath, 'run-1',
      'branch', 'trident/clearing-write',
      'inner_checkpoint', 'forge-done',
      'inner_verdict', '',
    ])
    expect(res.code).toBe(0)
    const r = row('run-1')
    expect(r.inner_verdict).toBe(null)
    expect(r.branch).toBe('trident/clearing-write')
    expect(r.inner_checkpoint).toBe('forge-done')
  })

  test('a REQUEST_CHANGES with NO findings is REFUSED and the true state is recorded instead', () => {
    // The measured shape: 97 of 160 recorded rejections in 30 days carried no
    // findings at all. `REVIEW_NOT_RUN` — never APPROVE, which would merge
    // unreviewed code.
    const res = sh([dbPath, 'run-1', 'inner_verdict', 'REQUEST_CHANGES'])
    expect(res.code).toBe(0)
    expect(res.stderr).toContain('REFUSED a findings-free REQUEST_CHANGES')
    expect(row('run-1').inner_verdict).toBe('REVIEW_NOT_RUN')
  })

  test('SEMANTICALLY EMPTY findings are empty — the test is parseCheckpointFindings, not a string compare', () => {
    // Every one of these is non-'[]' text a `TRIM(...) NOT IN ('','[]')` predicate
    // would call a real rejection, and every one of them decodes to [].
    const empties = [
      '[]', '[ ]', '{}', 'null', '{', '   ', '"a finding"', '0',
      // Deeper than SQLite's JSON_MAX_DEPTH (1000), so `json_valid` is 0 here and
      // the writer records REVIEW_NOT_RUN — `parseCheckpointFindings` agrees by
      // its own explicit bound, which is the point of pinning both sides.
      '['.repeat(1001) + '0' + ']'.repeat(1001),
      // A LEADING BYTE-ORDER MARK. `parseCheckpointFindings` answers [] for it by
      // an explicit clause, and `findings_case` now carries the same clause, so
      // this row is empty to the writer whatever the engine's `json_valid` starts
      // saying about the mark. The findings file holds the real EF BB BF bytes —
      // this path never goes through a driver that could strip them.
      '\uFEFF[{"severity":"blocker","title":"behind a byte-order mark"}]',
    ]
    for (const [i, findings] of empties.entries()) {
      const res = sh([
        dbPath, 'run-1',
        'inner_findings_file', findingsFile(`empty-${i}.json`, findings),
        'inner_verdict', 'REQUEST_CHANGES',
      ])
      expect(res.code).toBe(0)
      expect(row('run-1').inner_verdict).toBe('REVIEW_NOT_RUN')
    }
  })

  test('MALFORMED UTF-8 findings are REFUSED — the shape this script really can write', () => {
    // Argus r3 blocker, reproduced. Unlike a NUL (which bash strips on ingest) and
    // unlike a BOM (which every engine here already calls invalid JSON), invalid
    // UTF-8 travels through a findings FILE perfectly well and SQLite's JSON parser
    // accepts any byte >= 0x20 inside a string literal — so `[{"title":"<0x80>"}]`
    // was json_valid, an array, non-empty, and this script recorded REQUEST_CHANGES
    // with it. Every reader of that column then goes through bun:sqlite, whose
    // driver returns '' for a value that is not well-formed UTF-8, so the row read
    // back as precisely the findings-free rejection this script exists to make
    // unwritable — written BY this script, not inherited from history.
    const malformed: Array<[string, string]> = [
      ['orphan-continuation-byte', '5b7b227469746c65223a2280227d5d'],
      ['truncated-3-byte-sequence', '5b7b227469746c65223a22e280227d5d'],
      ['surrogate-sequence', '5b7b227469746c65223a22eda080227d5d'],
      ['overlong-sequence', '5b7b227469746c65223a22c080227d5d'],
    ]
    for (const [label, hex] of malformed) {
      const f = join(dir, `malformed-${label}.json`)
      writeFileSync(f, Buffer.from(hex, 'hex'))
      // The bytes really are on disk — a helper that had re-encoded them through a
      // JS string would leave this test asserting nothing.
      expect(readFileSync(f).toString('hex')).toBe(hex)
      const res = sh([dbPath, 'run-1', 'inner_findings_file', f, 'inner_verdict', 'REQUEST_CHANGES'])
      expect({ label, code: res.code }).toEqual({ label, code: 0 })
      expect({ label, verdict: row('run-1').inner_verdict }).toEqual({ label, verdict: 'REVIEW_NOT_RUN' })
    }

    // POSITIVE CONTROL, and it is the whole reason the clause is a re-encoding test
    // and not "reject anything non-ASCII": well-formed non-ASCII findings are a real
    // review saying real things, and they still record the rejection. U+FFFF is the
    // sharp one — valid UTF-8 that SQLite's own reader folds to U+FFFD, hence the
    // hand-written exception in `findings_case`.
    const wellFormed: Array<[string, string]> = [
      ['4-byte-emoji', '5b7b227469746c65223a22f09f9880227d5d'],
      ['noncharacter-U-FFFF', '5b7b227469746c65223a22efbfbf227d5d'],
      ['2-byte-accent', '5b7b227469746c65223a22c3a9227d5d'],
    ]
    for (const [label, hex] of wellFormed) {
      const f = join(dir, `wellformed-${label}.json`)
      writeFileSync(f, Buffer.from(hex, 'hex'))
      const res = sh([dbPath, 'run-1', 'inner_findings_file', f, 'inner_verdict', 'REQUEST_CHANGES'])
      expect({ label, code: res.code }).toEqual({ label, code: 0 })
      expect({ label, verdict: row('run-1').inner_verdict }).toEqual({
        label,
        verdict: 'REQUEST_CHANGES',
      })
    }
  })

  test('a LARGE well-formed non-ASCII rejection lands, and lands in bounded time', () => {
    // Argus r4 blocker, reproduced. The GLOB in front of the character walk was a
    // cost gate resting on "every findings payload this system writes is all-ASCII,
    // `JSON.stringify` escaping the rest" — which is false: `JSON.stringify` emits
    // raw non-ASCII bytes, and LLM-authored findings carry em dashes and curly
    // quotes as a matter of course. Such a payload misses the gate and pays the
    // walk, and the walk is quadratic (SQLite's SUBSTR on TEXT is O(offset)):
    // measured on the build box at 0.73 s for 16 K characters, 3.0 s at 32 K and
    // 12.4 s at 64 K, on the write that RECORDS THE VERDICT, with nothing upstream
    // bounding the size of a findings array.
    //
    // 64 K accented characters is that payload, well-formed and perfectly valid
    // JSON. It must record the rejection it justifies, and it must not spend the
    // walk's twelve seconds doing it — the bytes are validated in one linear pass
    // in bash (`utf8_verdict`), so what reaches SQL is a constant.
    const big = `[{"severity":"blocker","title":"${'é'.repeat(65536)}"}]`
    const f = join(dir, 'big-nonascii.json')
    writeFileSync(f, big)
    // The file really is non-ASCII and really is that big — a payload that had been
    // ASCII-escaped on the way to disk would skip the gate for the wrong reason and
    // leave this test asserting nothing.
    expect(readFileSync(f).length).toBeGreaterThan(130_000)
    expect(readFileSync(f).includes(0xc3)).toBe(true)
    const started = Date.now()
    const res = sh([dbPath, 'run-1', 'inner_findings_file', f, 'inner_verdict', 'REQUEST_CHANGES'])
    const elapsed = Date.now() - started
    expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: '' })
    expect(row('run-1').inner_verdict).toBe('REQUEST_CHANGES')
    expect(String(row('run-1').inner_checkpoint_findings)).toBe(big)
    // The ceiling, not a stopwatch on the machine: the walk alone costs ~12 s at
    // this size and everything else this script does is milliseconds, so a run that
    // took the walk cannot come in under this and a run that did not cannot exceed
    // it, on any box slow enough to matter.
    expect({ elapsed: elapsed < 6_000, ms: elapsed }).toMatchObject({ elapsed: true })

    // POSITIVE CONTROL, and it is the whole point: skipping the walk must not
    // become "stop checking". The same payload with ONE orphan continuation byte in
    // it is still refused, at the same size.
    const bad = join(dir, 'big-malformed.json')
    writeFileSync(
      bad,
      Buffer.concat([
        Buffer.from(`[{"severity":"blocker","title":"${'é'.repeat(65536)}`, 'utf8'),
        Buffer.from([0x80]),
        Buffer.from('"}]', 'utf8'),
      ]),
    )
    expect(readFileSync(bad).includes(0x80)).toBe(true)
    const badRes = sh([dbPath, 'run-1', 'inner_findings_file', bad, 'inner_verdict', 'REQUEST_CHANGES'])
    expect(badRes.code).toBe(0)
    expect(row('run-1').inner_verdict).toBe('REVIEW_NOT_RUN')
  })

  test('the scan the stored column still needs is CEILINGED, and the ceiling fails closed', () => {
    // The literal this invocation brings is decided in bash, but `settled_rejection`
    // reads the OLD row's stored column inside the same atomic UPDATE, where bash
    // does not have the bytes and cannot get them without re-opening the TOCTOU
    // `read_file_literal` exists to close. So the SQL scan stays for that operand —
    // under a ceiling, above which it is not run at all.
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).toContain('utf8_scan_max=16384')
    // Both answers above the ceiling are used, and each is the fail-closed one for
    // the question it feeds: 1 where the question is "must I refuse to ERASE this
    // row's findings", 0 where it is "may this write record a REJECTION".
    expect(src).toContain('utf8_wellformed inner_checkpoint_findings 1')
    expect(src).toContain('utf8_wellformed inner_checkpoint_findings 0')
    // The linear validator is the exact boundary the scan draws, and `-t UTF-8`
    // alone is NOT it (glibc passes U+110000 through); the target is pinned so a
    // future edit cannot quietly widen what counts as well-formed.
    expect(src).toContain('iconv -f UTF-8 -t UTF-32LE')
  })

  test('the BOM clause is PINNED in the bash copy too, not only in the documented statements', () => {
    // Argus r16 (mutation): deleting `AND SUBSTR(%s, 1, 1) <> CHAR(65279)` from
    // `findings_case` left 197 tests green, because on both engines this project
    // runs (sqlite3 CLI 3.45.1, bun:sqlite 3.51.2) `json_valid` ALREADY answers 0
    // over bytes beginning EF BB BF — the clause changes no answer today. It
    // exists so an engine that started tolerating the mark could not quietly
    // promote a BOM-prefixed body to a rejection here while
    // `parseCheckpointFindings` still read it as empty, which is a divergence no
    // execution on today's engines can demonstrate. The doc copies are pinned
    // textually for exactly this reason (as-built-disposition-sql.test.ts); this
    // is the third copy, and it was the only unpinned one.
    const src = readFileSync(SCRIPT, 'utf8')
    const findingsCase = src.slice(src.indexOf('findings_case() {'), src.indexOf('# A TERMINAL ROW'))
    // Positive control: the slice really is the predicate, not an empty string.
    expect(findingsCase).toContain('json_array_length')
    expect(findingsCase).toContain('CHAR(65279)')
    // …and it is the SAME clause the parser carries, not an unrelated mention.
    expect(findingsCase).toContain('SUBSTR')
    // AND THE NUL CLAUSE IS THE THIRD COPY OF ITS OWN PREDICATE (Argus r22, nit).
    // The counting statements in `docs/AS_BUILT.md` — pinned textually by
    // `as-built-disposition-sql.test.ts` — carry `INSTR(…, CHAR(0)) = 0` because
    // SQLite's JSON functions stop at an embedded NUL while `JSON.parse` reads on
    // and throws. `settled_rejection` in this script applies `findings_case` to the
    // STORED column, so without this clause a historical row holding such a value
    // was "settled" to the shell and "legacy" to the count: one predicate with two
    // answers. Bash strips NULs on ingest, so no write from here can create the
    // shape — this is parity over the rows that already exist.
    expect(findingsCase).toContain('INSTR')
    expect(findingsCase).toContain('CHAR(0)')
    // AND THE MALFORMED-UTF-8 SCAN IS THE FOURTH COPY (Argus r3, blocker). This one
    // is NOT dormant — the test above shows it moving a write from REQUEST_CHANGES to
    // REVIEW_NOT_RUN — but its presence is pinned here beside its siblings so the
    // three copies (this script, `parseCheckpointFindings`, the documented counting
    // SQL) cannot drift apart one deletion at a time. The noncharacter escape is
    // pinned too: without it the clause demotes findings the parser reads perfectly.
    expect(findingsCase).toContain('CAST(CHAR(UNICODE(CAST(b AS TEXT))) AS BLOB)')
    expect(findingsCase).toContain("x'EFBFBE', x'EFBFBF'")
  })

  test("THIS invocation's findings win over the row's, so a rejection cannot ride on a stale non-empty column", () => {
    expect(sh([dbPath, 'run-1', 'inner_findings_file', findingsFile('stale.json', REAL)]).code).toBe(0)
    // A `fix-round-N` checkpoint writes `[]` — the run moved past those findings.
    const res = sh([
      dbPath, 'run-1',
      'inner_checkpoint', 'fix-round-3',
      'inner_findings_file', findingsFile('cleared.json', '[]'),
      'inner_verdict', 'REQUEST_CHANGES',
    ])
    expect(res.code).toBe(0)
    expect(row('run-1').inner_verdict).toBe('REVIEW_NOT_RUN')
  })

  test('FIELD ORDER does not matter: the verdict is decided after the whole argument list is read', () => {
    const res = sh([
      dbPath, 'run-1',
      'inner_verdict', 'REQUEST_CHANGES',
      'inner_findings_file', findingsFile('late.json', REAL),
    ])
    expect(res.code).toBe(0)
    expect(row('run-1').inner_verdict).toBe('REQUEST_CHANGES')
  })

  test('REFUSED, NOT FAILED: the rest of the write still lands', () => {
    // Exiting non-zero would trade one bad column for a blind row — the run
    // really did end, and its branch/checkpoint/result are the trail back to it.
    const f = join(dir, 'terminal.json')
    writeFileSync(f, '{"ok":false}')
    const res = sh([
      dbPath, 'run-1',
      'branch', 'trident/some-card',
      'inner_checkpoint', 'forge-done',
      'inner_result_file', f,
      'inner_verdict', 'REQUEST_CHANGES',
    ])
    expect(res.code).toBe(0)
    const r = row('run-1')
    expect(r.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(r.branch).toBe('trident/some-card')
    expect(r.inner_checkpoint).toBe('forge-done')
    expect(r.inner_result).toBe('{"ok":false}')
  })

  test('every OTHER verdict is written verbatim — the guard is scoped to the rejection', () => {
    for (const verdict of ['APPROVE', 'REVIEW_NOT_RUN']) {
      const res = sh([dbPath, 'run-1', 'inner_verdict', verdict])
      expect(res.code).toBe(0)
      expect(res.stderr).not.toContain('REFUSED')
      expect(row('run-1').inner_verdict).toBe(verdict)
    }
  })

  test('a terminal row is not exempt: the precondition holds wherever the write lands', () => {
    const db = new Database(dbPath)
    db.run("UPDATE code_trident_runs SET phase = 'failed' WHERE id = 'run-1'")
    db.close()
    expect(sh([dbPath, 'run-1', 'inner_verdict', 'REQUEST_CHANGES']).code).toBe(0)
    expect(row('run-1').inner_verdict).toBe('REVIEW_NOT_RUN')
  })

  // ── THE SECOND WAY IN: a findings-only write (Argus r8 blocker) ──────────────
  //
  // Guarding only the invocations that CARRY a verdict left the forbidden row
  // reachable in two legal steps — record a real rejection, then write findings
  // ALONE that empty the set, and `REQUEST_CHANGES` ends up sitting beside `[]`.
  // `TridentRunStore.update` refuses that shape (it tests the EFFECTIVE verdict
  // against the EFFECTIVE findings), so a bash seam that allowed it made the two
  // write sites disagree about the one invariant this card is about.

  test('a findings-only write that EMPTIES the findings DEMOTES a recorded REQUEST_CHANGES', () => {
    expect(sh([
      dbPath, 'run-1',
      'inner_findings_file', findingsFile('reject.json', REAL),
      'inner_verdict', 'REQUEST_CHANGES',
    ]).code).toBe(0)
    expect(row('run-1').inner_verdict).toBe('REQUEST_CHANGES') // positive control

    // The live shape: a `fix-round-N` checkpoint writes `[]` because the run moved
    // past those findings, and brings NO verdict of its own.
    const res = sh([
      dbPath, 'run-1',
      'inner_checkpoint', 'fix-round-3',
      'inner_findings_file', findingsFile('emptied.json', '[]'),
    ])

    expect(res.code).toBe(0)
    expect(res.stderr).toContain('DEMOTED')
    const r = row('run-1')
    expect(r.inner_checkpoint_findings).toBe('[]')
    expect(r.inner_verdict).toBe('REVIEW_NOT_RUN') // NOT a rejection it cannot justify
  })

  test('the demotion is scoped: a findings-only write leaves APPROVE, REVIEW_NOT_RUN and a null verdict alone', () => {
    // Only a row currently CLAIMING a rejection can be demoted. Touching any other
    // verdict would be this script inventing a decision, which is the disease.
    for (const verdict of ['APPROVE', 'REVIEW_NOT_RUN']) {
      expect(sh([dbPath, 'run-1', 'inner_verdict', verdict]).code).toBe(0)
      const res = sh([dbPath, 'run-1', 'inner_findings_file', findingsFile(`keep-${verdict}.json`, '[]')])
      expect(res.code).toBe(0)
      expect(res.stderr).not.toContain('DEMOTED')
      expect(row('run-1').inner_verdict).toBe(verdict)
    }
    expect(sh([dbPath, 'run-1', 'inner_verdict', '']).code).toBe(0)
    expect(sh([dbPath, 'run-1', 'inner_findings_file', findingsFile('keep-null.json', '[]')]).code).toBe(0)
    expect(row('run-1').inner_verdict).toBeNull()
  })

  test('a findings-only write carrying REAL findings keeps the REQUEST_CHANGES it lands on', () => {
    // The positive control for the demotion: it must be driven by the findings
    // being empty, not by the write being findings-only.
    expect(sh([
      dbPath, 'run-1',
      'inner_findings_file', findingsFile('first.json', REAL),
      'inner_verdict', 'REQUEST_CHANGES',
    ]).code).toBe(0)
    const later = '[{"severity":"major","title":"a second real finding"}]'
    const res = sh([dbPath, 'run-1', 'inner_findings_file', findingsFile('second.json', later)])
    expect(res.code).toBe(0)
    expect(res.stderr).not.toContain('DEMOTED')
    expect(row('run-1')).toMatchObject({ inner_verdict: 'REQUEST_CHANGES', inner_checkpoint_findings: later })
  })

  // -- AND A SETTLED REJECTION IS NOT ERASED BY AN ORPHAN (Argus r1) -----------
  //
  // The demotion above is right for a LIVE row and wrong for a TERMINAL one.
  // `artifactCheckpointCommand` (inner-workflow.mjs) opens every phase checkpoint
  // with `printf '%s' '[]' > <tmp>` and passes it as `inner_findings_file` with no
  // verdict, and a cancelled build's workflow keeps running and keeps checkpointing
  // (rjunee/neutron#177) -- so one of those lands on a row that already recorded a
  // REAL rejection, and the demotion rewrites a reviewer's decision to
  // REVIEW_NOT_RUN and deletes their words with it. That row then reads as
  // built-never-reviewed and is re-dispatched: the waste this card measures,
  // manufactured by the guard meant to end it.

  function terminalRejection(id: string, findings: string): void {
    expect(sh([dbPath, id, 'inner_findings_file', findingsFile(`settled-${id}.json`, findings), 'inner_verdict', 'REQUEST_CHANGES']).code).toBe(0)
    expect(row(id).inner_verdict).toBe('REQUEST_CHANGES') // precondition, not decoration
    const db = new Database(dbPath)
    db.run("UPDATE code_trident_runs SET phase = 'failed' WHERE id = ?", [id])
    db.close()
  }

  test("an ORPHAN's `[]` findings write cannot erase a TERMINAL row's real rejection", () => {
    terminalRejection('run-1', REAL)

    // Byte-for-byte the artifact checkpoint's shape: branch + name + head +
    // findings `[]` + status, and NO verdict.
    const res = sh([
      dbPath, 'run-1',
      'branch', 'trident/some-card',
      'inner_checkpoint', 'forge-done',
      'inner_checkpoint_head', 'b'.repeat(40),
      'inner_findings_file', findingsFile('orphan-empty.json', '[]'),
      'subagent_status', 'running',
    ])

    expect(res.code).toBe(0)
    expect(res.stderr).not.toContain('DEMOTED')
    const r = row('run-1')
    expect(r.inner_verdict).toBe('REQUEST_CHANGES') // the reviewer decided; an orphan may not undecide it
    expect(r.inner_checkpoint_findings).toBe(REAL) // ...and their reasons are still on the row
    // The orphan's own trail still lands -- the guard is scoped to the two columns
    // that carry the decision, not a blanket refusal of the write.
    expect(r.branch).toBe('trident/some-card')
    expect(r.inner_checkpoint).toBe('forge-done')
  })

  test('the guard refuses ERASURE ONLY: an orphan may still ADD real findings to a terminal rejection', () => {
    terminalRejection('run-1', REAL)
    const more = '[{"severity":"major","title":"a second real finding"}]'

    expect(sh([dbPath, 'run-1', 'inner_findings_file', findingsFile('orphan-real.json', more)]).code).toBe(0)

    expect(row('run-1')).toMatchObject({ inner_verdict: 'REQUEST_CHANGES', inner_checkpoint_findings: more })
  })

  test('the guard is scoped to a SETTLED rejection: a terminal APPROVE / REVIEW_NOT_RUN row is untouched', () => {
    // Nothing here invents a decision. Only a terminal row currently claiming a
    // rejection it has justified is protected; every other terminal row takes the
    // findings write exactly as before.
    for (const verdict of ['APPROVE', 'REVIEW_NOT_RUN']) {
      expect(sh([dbPath, 'run-other', 'inner_verdict', verdict]).code).toBe(0)
      const db = new Database(dbPath)
      db.run("UPDATE code_trident_runs SET phase = 'failed' WHERE id = 'run-other'")
      db.close()
      expect(sh([dbPath, 'run-other', 'inner_findings_file', findingsFile(`terminal-${verdict}.json`, '[]')]).code).toBe(0)
      expect(row('run-other')).toMatchObject({ inner_verdict: verdict, inner_checkpoint_findings: '[]' })
    }
  })

  test('a verdict-carrying orphan cannot erase it either -- `REQUEST_CHANGES` + `[]` is the same emptying write', () => {
    // Argus r16. The guard armed only when NO verdict was given, so the SAME
    // emptying write with a verdict stapled to it walked past it: seed a settled
    // terminal rejection, then write `inner_verdict REQUEST_CHANGES` with `[]`,
    // and the row came back done|REVIEW_NOT_RUN|[] -- the reviewer's decision
    // rewritten and their words deleted, which is exactly the row
    // `terminalRunDisposition` re-reads as built-never-reviewed and re-dispatches.
    // A findings-free REQUEST_CHANGES is the one verdict this script refuses to
    // write, so an invocation asking for it can never be a caller deciding
    // something new.
    terminalRejection('run-1', REAL)

    const res = sh([
      dbPath, 'run-1',
      'inner_findings_file', findingsFile('verdict-orphan-empty.json', '[]'),
      'inner_verdict', 'REQUEST_CHANGES',
    ])

    expect(res.code).toBe(0)
    const r = row('run-1')
    expect(r.inner_verdict).toBe('REQUEST_CHANGES')
    expect(r.inner_checkpoint_findings).toBe(REAL)
    expect(terminalRunDisposition(makeTridentRun({
      phase: 'failed',
      inner_verdict: r.inner_verdict as TridentVerdict,
      inner_checkpoint: 'forge-done',
      inner_checkpoint_findings: r.inner_checkpoint_findings as string,
    }))).toBe('reviewed-rejected')

    // A REAL decision still lands on the same row -- the guard refuses erasure,
    // not writing. Without this the test above would pass on a script that had
    // simply stopped accepting verdicts on terminal rows.
    expect(sh([dbPath, 'run-1', 'inner_verdict', 'APPROVE']).code).toBe(0)
    expect(row('run-1').inner_verdict).toBe('APPROVE')
  })

  test('nor can a CLEARING write erase it -- `inner_verdict \'\'` is the same erasure, spelled shorter', () => {
    // Argus r21. `inner_verdict ''` was the last shape that walked past both
    // guards: the findings column was frozen by the erasure block, the verdict
    // column was NULLed unconditionally, and the row came out of a single atomic
    // write with its two guarded columns DISAGREEING -- real findings, no verdict --
    // which the script's own docblock says can never happen.
    // `terminalRunDisposition` then reads a reviewed rejection as
    // died-before-build, i.e. as a card to re-dispatch from scratch.
    for (const [i, withEmptyFile] of [false, true].entries()) {
      const id = 'run-1'
      const db0 = new Database(dbPath)
      db0.run("UPDATE code_trident_runs SET phase = 'forge-init', inner_verdict = NULL WHERE id = ?", [id])
      db0.close()
      terminalRejection(id, REAL)

      const args = [dbPath, id, 'inner_verdict', '']
      // The same clear, once bare and once with an emptying findings file stapled
      // on -- the exemption its `REVIEW_NOT_RUN` sibling had to have closed twice.
      if (withEmptyFile) args.push('inner_findings_file', findingsFile(`clear-${i}.json`, '[]'))
      const res = sh(args)

      expect(res.code).toBe(0)
      expect(res.stderr).toContain('FROZE')
      const r = row(id)
      expect(r.inner_verdict).toBe('REQUEST_CHANGES')
      expect(r.inner_checkpoint_findings).toBe(REAL)
      // The two guarded columns still agree, which is the whole claim.
      expect(terminalRunDisposition(makeTridentRun({
        phase: 'failed',
        inner_verdict: r.inner_verdict as TridentVerdict,
        inner_checkpoint: 'forge-done',
        inner_checkpoint_findings: r.inner_checkpoint_findings as string,
      }))).toBe('reviewed-rejected')
    }
  })

  test('the CLEARING write still clears every row that is not a settled rejection', () => {
    // Positive control for the freeze above -- without it that test would pass on a
    // script that had simply stopped honouring `inner_verdict ''`. A LIVE row and a
    // terminal row that never claimed a rejection both clear to NULL as before.
    expect(sh([dbPath, 'run-1', 'inner_verdict', 'REQUEST_CHANGES', 'inner_findings_file', findingsFile('live-real.json', REAL)]).code).toBe(0)
    expect(row('run-1').inner_verdict).toBe('REQUEST_CHANGES') // live, and settled-looking
    expect(sh([dbPath, 'run-1', 'inner_verdict', '']).code).toBe(0)
    expect(row('run-1').inner_verdict).toBe(null) // ...but not terminal, so it clears

    expect(sh([dbPath, 'run-other', 'inner_verdict', 'APPROVE']).code).toBe(0)
    const db = new Database(dbPath)
    db.run("UPDATE code_trident_runs SET phase = 'done' WHERE id = 'run-other'")
    db.close()
    expect(sh([dbPath, 'run-other', 'inner_verdict', '']).code).toBe(0)
    expect(row('run-other').inner_verdict).toBe(null) // terminal, but nothing was rejected
  })

  test('a terminal row holding REAL findings keeps them whatever verdict it claims', () => {
    // Argus r16. `orchestrator.ts` (recordedTerminalVerdict) states that when a
    // terminal verdict is retracted "the findings themselves are still PRESERVED
    // on the row", and `builtButNeverReviewedSeed` carries the stored findings
    // into the seeded run -- so an orphan's `[]` on a REVIEW_NOT_RUN row did not
    // just blank a display column, it handed the next round a review with nothing
    // in it. The guard now arms on the row's CLAIM *or* on evidence that really
    // parses.
    for (const verdict of ['REVIEW_NOT_RUN', 'APPROVE']) {
      const id = `run-1`
      const db = new Database(dbPath)
      db.run(
        `UPDATE code_trident_runs
            SET phase = 'failed', inner_verdict = ?, inner_checkpoint = 'forge-done',
                inner_checkpoint_findings = ?
          WHERE id = ?`,
        [verdict, REAL, id],
      )
      db.close()

      expect(sh([dbPath, id, 'inner_findings_file', findingsFile(`preserve-${verdict}.json`, '[]')]).code).toBe(0)

      expect(row(id)).toMatchObject({ inner_verdict: verdict, inner_checkpoint_findings: REAL })
    }
  })

  test('a LEGACY terminal REQUEST_CHANGES -- `[]` or NULL findings -- is not demoted either', () => {
    // Argus r15 blocker. The guard first ALSO required the STORED findings to parse
    // non-empty, which armed it only for rows written since 0138 and left the entire
    // legacy population -- the 70 REQUEST_CHANGES + `[]` and 27 REQUEST_CHANGES +
    // NULL rows this card MEASURED -- exposed: an orphan `[]` checkpoint demoted a
    // settled terminal rejection to REVIEW_NOT_RUN, and `terminalRunDisposition`
    // re-read that row as built-never-reviewed, i.e. as work to re-dispatch. The card
    // forbids rewriting those rows; this is that rule at the write site.
    //
    // Raw SQL seeds the shape ON PURPOSE: neither write site can produce it, which is
    // exactly why the guard has to arm on the row's CLAIM rather than on its evidence.
    for (const [i, legacy] of ['[]', null].entries()) {
      const id = 'run-1'
      const db = new Database(dbPath)
      db.run(
        `UPDATE code_trident_runs
            SET phase = 'failed', inner_verdict = 'REQUEST_CHANGES',
                inner_checkpoint = 'forge-done', inner_checkpoint_findings = ?
          WHERE id = ?`,
        [legacy, id],
      )
      db.close()
      expect(row(id)).toMatchObject({ inner_verdict: 'REQUEST_CHANGES' }) // precondition, not decoration

      // The artifact checkpoint's own shape: findings `[]`, no verdict.
      const res = sh([dbPath, id, 'inner_findings_file', findingsFile(`legacy-${i}.json`, '[]'), 'subagent_status', 'running'])

      expect(res.code).toBe(0)
      expect(res.stderr).not.toContain('DEMOTED')
      const r = row(id)
      expect(r.inner_verdict).toBe('REQUEST_CHANGES') // history stays as history wrote it
      expect(r.inner_checkpoint_findings).toBe(legacy)

      // ...and what that means downstream, in the classifier's own words rather
      // than in this file's: the row still READS as a rejection. Demoted, the same
      // row reads as built-never-reviewed — work to hand forward and re-dispatch.
      const asRun = (verdict: TridentVerdict | null) =>
        makeTridentRun({
          phase: 'failed',
          inner_verdict: verdict,
          inner_checkpoint: 'forge-done',
          inner_checkpoint_findings: legacy,
        })
      expect(terminalRunDisposition(asRun(r.inner_verdict as TridentVerdict))).toBe('reviewed-rejected')
      expect(terminalRunDisposition(asRun('REVIEW_NOT_RUN'))).toBe('built-never-reviewed')
    }
  })

  test('a BARE `inner_verdict REVIEW_NOT_RUN` cannot erase a settled rejection either', () => {
    // Argus r18. The erasure guard armed only when a FINDINGS FILE accompanied the
    // write, so the verdict-only write walked straight past it -- and that is the
    // shape `writeTerminalResult` (inner-workflow.mjs) emits for EVERY non-code
    // terminal: `inner_result_file` + `inner_verdict 'REVIEW_NOT_RUN'` + `branch`,
    // no findings. A late or duplicate terminal write on an already-settled row
    // therefore demoted a real review to "no review happened", and
    // `terminalRunDisposition` re-reads that row as built-never-reviewed -- work to
    // re-dispatch, which is the waste this card exists to remove.
    terminalRejection('run-1', REAL)

    const res = sh([dbPath, 'run-1', 'inner_verdict', 'REVIEW_NOT_RUN', 'branch', 'trident/some-card'])

    expect(res.code).toBe(0)
    // A refused write is never silent -- the column does not hold what was asked for.
    expect(res.stderr).toContain('FROZE a bare REVIEW_NOT_RUN')
    const r = row('run-1')
    expect(r.inner_verdict).toBe('REQUEST_CHANGES') // the reviewer decided; a bare verdict may not undecide it
    expect(r.inner_checkpoint_findings).toBe(REAL)
    // The rest of the same write still lands -- scoped to the decision column.
    expect(r.branch).toBe('trident/some-card')
    // ...and what that means downstream, in the classifier's own words.
    expect(terminalRunDisposition(makeTridentRun({
      phase: 'failed',
      inner_verdict: r.inner_verdict as TridentVerdict,
      inner_checkpoint: 'forge-done',
      inner_checkpoint_findings: r.inner_checkpoint_findings as string,
    }))).toBe('reviewed-rejected')
  })

  test('...and the LEGACY shapes too -- a terminal REQUEST_CHANGES with `[]` or NULL findings', () => {
    // The measured population (70 `[]` + 27 NULL) has no evidence to protect, only a
    // CLAIM, so the guard has to arm on the claim here exactly as its findings-file
    // twin does. Raw SQL seeds the shape on purpose: no write site can produce it.
    for (const legacy of ['[]', null]) {
      const db = new Database(dbPath)
      db.run(
        `UPDATE code_trident_runs
            SET phase = 'failed', inner_verdict = 'REQUEST_CHANGES',
                inner_checkpoint = 'forge-done', inner_checkpoint_findings = ?
          WHERE id = 'run-1'`,
        [legacy],
      )
      db.close()
      expect(sh([dbPath, 'run-1', 'inner_verdict', 'REVIEW_NOT_RUN']).code).toBe(0)
      expect(row('run-1')).toMatchObject({ inner_verdict: 'REQUEST_CHANGES', inner_checkpoint_findings: legacy })
    }
  })

  test('the verdict-only guard is SCOPED: a live row, a non-settled terminal row and a real decision all still land', () => {
    // Three falsifications for the two tests above, so neither can pass on a script
    // that simply stopped writing REVIEW_NOT_RUN.
    //
    // (1) A LIVE row takes it -- the guard is terminal-only.
    expect(sh([
      dbPath, 'run-1',
      'inner_findings_file', findingsFile('scope-live.json', REAL),
      'inner_verdict', 'REQUEST_CHANGES',
    ]).code).toBe(0)
    expect(row('run-1').phase).toBe('forge-init')
    const live = sh([dbPath, 'run-1', 'inner_verdict', 'REVIEW_NOT_RUN'])
    expect(live.code).toBe(0)
    expect(live.stderr).not.toContain('FROZE') // nothing was refused
    expect(row('run-1').inner_verdict).toBe('REVIEW_NOT_RUN')

    // (2) A TERMINAL row that never claimed a rejection and holds no evidence takes
    // it -- this is the honest first REVIEW_NOT_RUN the card is FOR.
    const db = new Database(dbPath)
    db.run(
      `UPDATE code_trident_runs
          SET phase = 'failed', inner_verdict = NULL, inner_checkpoint_findings = '[]'
        WHERE id = 'run-1'`,
    )
    db.close()
    expect(sh([dbPath, 'run-1', 'inner_verdict', 'REVIEW_NOT_RUN']).code).toBe(0)
    expect(row('run-1').inner_verdict).toBe('REVIEW_NOT_RUN')

    // (3) A settled rejection still accepts a REAL decision: APPROVE lands on the
    // very row the guard just protected, so the guard refuses erasure, not writing.
    terminalRejection('run-other', REAL)
    expect(sh([dbPath, 'run-other', 'inner_verdict', 'APPROVE']).code).toBe(0)
    expect(row('run-other').inner_verdict).toBe('APPROVE')
  })

  test('a verdict paired with an EMPTYING findings file cannot erase a settled rejection either', () => {
    // Argus r20, reproduced independently by two reviewers with sqlite repros. The
    // arming asked TWO questions -- does this write bring findings, AND is its
    // verdict absent-or-REQUEST_CHANGES -- so the same emptying write with any
    // other verdict stapled on walked straight past the guard: `REVIEW_NOT_RUN` +
    // `[]` demoted a settled rejection and blanked its findings, and `APPROVE` +
    // `[]` turned that rejection into an APPROVAL with nothing behind it. Both
    // contradict the invariant the write site states in its own docblock -- "only
    // ERASURE is refused" -- so the guard now asks ONE question of every shape:
    // does this write BRING findings?
    terminalRejection('run-1', REAL)
    const noReview = sh([
      dbPath, 'run-1',
      'inner_verdict', 'REVIEW_NOT_RUN',
      'inner_findings_file', findingsFile('erase-no-review.json', '[]'),
      'branch', 'trident/some-card',
    ])

    expect(noReview.code).toBe(0)
    expect(noReview.stderr).toContain('FROZE a REVIEW_NOT_RUN with an emptying findings file')
    const nr = row('run-1')
    expect(nr.inner_verdict).toBe('REQUEST_CHANGES')
    expect(nr.inner_checkpoint_findings).toBe(REAL) // the reviewer's words survive
    expect(nr.branch).toBe('trident/some-card') // the rest of the write still lands

    // ...and the APPROVE shape, which is the worse of the two: it does not just
    // forget a review, it records the opposite of one.
    terminalRejection('run-other', REAL)
    const approve = sh([
      dbPath, 'run-other',
      'inner_verdict', 'APPROVE',
      'inner_findings_file', findingsFile('erase-approve.json', '[]'),
    ])

    expect(approve.code).toBe(0)
    expect(approve.stderr).toContain("FROZE the verdict 'APPROVE' with an emptying findings file")
    const ap = row('run-other')
    expect(ap.inner_verdict).toBe('REQUEST_CHANGES')
    expect(ap.inner_checkpoint_findings).toBe(REAL)
    // ...and what that means downstream, in the classifier's own words: the row
    // still READS as a rejection rather than as work to hand forward and rebuild.
    expect(terminalRunDisposition(makeTridentRun({
      phase: 'failed',
      inner_verdict: ap.inner_verdict as TridentVerdict,
      inner_checkpoint: 'forge-done',
      inner_checkpoint_findings: ap.inner_checkpoint_findings as string,
    }))).toBe('reviewed-rejected')
  })

  test('...and that freeze is SCOPED: real findings, a live row and a findings-free APPROVE all still land', () => {
    // The falsifications for the test above, so it cannot pass on a script that
    // simply stopped accepting verdicts alongside findings files.
    //
    // (1) A verdict carrying REAL findings is ADDING evidence, not erasing it: both
    // columns land on the settled row.
    terminalRejection('run-1', REAL)
    const MORE = '[{"severity":"major","title":"a second reviewer really said this too"}]'
    expect(sh([
      dbPath, 'run-1',
      'inner_verdict', 'REQUEST_CHANGES',
      'inner_findings_file', findingsFile('adds-evidence.json', MORE),
    ]).code).toBe(0)
    expect(row('run-1')).toMatchObject({ inner_verdict: 'REQUEST_CHANGES', inner_checkpoint_findings: MORE })

    // (2) A LIVE row takes the same emptying write -- the guard is terminal-only.
    const db = new Database(dbPath)
    db.run("UPDATE code_trident_runs SET phase = 'forge-init' WHERE id = 'run-1'")
    db.close()
    const live = sh([
      dbPath, 'run-1',
      'inner_verdict', 'REVIEW_NOT_RUN',
      'inner_findings_file', findingsFile('live-empty-verdict.json', '[]'),
    ])
    expect(live.code).toBe(0)
    expect(live.stderr).not.toContain('FROZE')
    expect(row('run-1')).toMatchObject({ inner_verdict: 'REVIEW_NOT_RUN', inner_checkpoint_findings: '[]' })

    // (3) THE POSITIVE CONTROL FOR THE APPROVE HALF: a real APPROVE brings no
    // findings file at all, and still lands on the very row the guard protects --
    // nothing here relaxes or tightens what a review may decide.
    terminalRejection('run-other', REAL)
    expect(sh([dbPath, 'run-other', 'inner_verdict', 'APPROVE']).code).toBe(0)
    expect(row('run-other').inner_verdict).toBe('APPROVE')
  })

  test('a LIVE row still demotes -- the guard did not disable the demotion, it scoped it', () => {
    // The falsification for the three above: make the row terminal and the erasure
    // is refused; leave it live and the same write demotes. Delete the `phase IN
    // (terminal)` clause from the guard and this goes red.
    expect(sh([
      dbPath, 'run-1',
      'inner_findings_file', findingsFile('live-real.json', REAL),
      'inner_verdict', 'REQUEST_CHANGES',
    ]).code).toBe(0)
    expect(row('run-1').phase).toBe('forge-init') // still LIVE

    const res = sh([dbPath, 'run-1', 'inner_findings_file', findingsFile('live-empty.json', '[]')])

    expect(res.code).toBe(0)
    expect(res.stderr).toContain('DEMOTED')
    expect(row('run-1')).toMatchObject({ inner_verdict: 'REVIEW_NOT_RUN', inner_checkpoint_findings: '[]' })
  })

  test('THE FINDINGS ARE READ ONCE: the emitted SQL carries their bytes as a literal and never calls readfile()', () => {
    // `readfile()` is a FUNCTION, not a value — SQLite re-evaluates it at every
    // mention, and the verdict CASE mentions the findings expression FOUR times
    // (the column, plus json_valid/json_type/json_array_length). Argus swapped the
    // file under a 300-write run and got a row whose verdict was decided from
    // different bytes than the ones stored: `REQUEST_CHANGES` beside `[]`,
    // persisted at iteration 132. A race is not a thing a unit test can pin
    // honestly, so what is pinned is the property that ABOLISHES it — the file is
    // read once, in bash, and every mention of it in the statement is the same
    // constant. Reverting to `CAST(readfile(...) AS TEXT)` makes this red.
    const fake = fakeSqlite3('fakebin')
    const p = Bun.spawnSync(['bash', SCRIPT, dbPath, 'run-1',
      'inner_findings_file', findingsFile('once.json', REAL),
      'inner_verdict', 'REQUEST_CHANGES',
    ], { env: { ...process.env, PATH: `${fake.binDir}:${process.env.PATH ?? ''}` } })

    expect(p.exitCode).toBe(0)
    const emitted = fake.sql()
    expect(emitted).toContain('UPDATE code_trident_runs') // positive control: we captured the real statement
    expect(emitted).toContain(REAL) // the bytes travelled as a literal
    expect(emitted).not.toContain('readfile')
    // ...ON STDIN, never in argv — see the size test below for the failure that
    // property exists to prevent.
    expect(fake.argv()).not.toContain(REAL)
  })

  test('THE RESULT FILE IS READ ONCE TOO — the same statement stores it and tests its length', () => {
    // Same mechanism, same fix: two `readfile()` evaluations of one path inside one
    // UPDATE can see different bytes, which here would flip `subagent_status` to
    // 'completed' beside an EMPTY `inner_result`.
    const fake = fakeSqlite3('fakebin-result')
    const f = join(dir, 'terminal-once.json')
    writeFileSync(f, '{"ok":true}')
    const p = Bun.spawnSync(['bash', SCRIPT, dbPath, 'run-1', 'inner_result_file', f, 'inner_verdict', 'APPROVE'], {
      env: { ...process.env, PATH: `${fake.binDir}:${process.env.PATH ?? ''}` },
    })

    expect(p.exitCode).toBe(0)
    const emitted = fake.sql()
    expect(emitted).toContain('UPDATE code_trident_runs')
    expect(emitted).toContain('{"ok":true}')
    expect(emitted).not.toContain('readfile')
    expect(fake.argv()).not.toContain('{"ok":true}')
  })
})

/**
 * THE STATEMENT TRAVELS ON STDIN — the size bound the read-once fix needed.
 *
 * `read_file_literal` materialises the findings/result bytes INTO the UPDATE, and
 * the verdict CASE mentions the findings FOUR times. Passed as a single sqlite3
 * argument that hit MAX_ARG_STRLEN — Linux caps ONE argv element at 128 KiB
 * whatever `ARG_MAX` says — so a 33 KB findings file produced a 132 KB argument,
 * `execve` answered E2BIG, and the script died at exit 126 under `set -e` with the
 * WHOLE terminal write lost: no verdict, no findings, no branch. That is the blind
 * "built, never reviewed" row this script exists to prevent, appearing on exactly
 * the reviews that found the most to say. The live corpus already holds 13,995-byte
 * findings.
 *
 * The suite above proved the bytes travel as a literal using 40-byte payloads,
 * which is the property that BREAKS at scale — so these tests state the bound in
 * bytes and run against the REAL sqlite3, where the limit actually lives. Reverting
 * the pipe to an argv argument makes the first one red.
 */
describe('checkpoint.sh — payloads past the platform per-argument limit', () => {
  /** Linux `MAX_ARG_STRLEN` = 32 * PAGE_SIZE = 128 KiB, per binfmts.h. */
  const MAX_ARG_STRLEN = 128 * 1024

  function fileWith(name: string, content: string): string {
    const f = join(dir, name)
    writeFileSync(f, content)
    return f
  }

  test('a findings file BIGGER than one argv element still records the rejection it justifies', () => {
    const findings = JSON.stringify([{ severity: 'blocker', title: 'x'.repeat(200_000), evidence: "it's long" }])
    expect(findings.length).toBeGreaterThan(MAX_ARG_STRLEN)

    const res = sh([
      dbPath, 'run-1',
      'branch', 'trident/big-review',
      'inner_checkpoint', 'argus-request-changes',
      'inner_findings_file', fileWith('huge-findings.json', findings),
      'inner_verdict', 'REQUEST_CHANGES',
    ])

    expect(res.code).toBe(0) // 126 = execve E2BIG, the shape this pins against
    const r = row('run-1')
    expect(r.inner_checkpoint_findings).toBe(findings) // byte-identical, all 200 KB
    expect(r.inner_verdict).toBe('REQUEST_CHANGES') // a REAL rejection, not demoted
    expect(r.branch).toBe('trident/big-review') // the rest of the write survived too
  })

  test('a result file BIGGER than one argv element still lands, and still flips subagent_status', () => {
    // Two mentions rather than four (the column and the length CASE), so its own
    // threshold is higher — the limit is per ARGUMENT, and the argument was the
    // whole statement.
    const result = JSON.stringify({ ok: true, verdict: 'APPROVE', notes: 'y'.repeat(200_000) })
    expect(result.length).toBeGreaterThan(MAX_ARG_STRLEN)

    const res = sh([dbPath, 'run-1', 'inner_result_file', fileWith('huge-result.json', result), 'inner_verdict', 'APPROVE'])

    expect(res.code).toBe(0)
    expect(row('run-1')).toMatchObject({ inner_result: result, subagent_status: 'completed' })
  })

  test('the bytes round-trip VERBATIM, trailing newline included', () => {
    // The `printf X` sentinel in `read_file_literal` exists for this, and it was
    // needed TWICE: `$(...)` strips trailing newlines from its own output as well,
    // so quoting through a bare command substitution re-stripped them (Argus r1).
    // `\n`-terminated JSON is what a writer that ends with a newline produces, and
    // silently trimming it makes the stored bytes differ from the file the reviewer
    // read.
    const findings = '[{"severity":"blocker","title":"trailing"}]\n\n'
    const result = '{"ok":true}\n'

    expect(sh([
      dbPath, 'run-1',
      'inner_findings_file', fileWith('nl-findings.json', findings),
      'inner_result_file', fileWith('nl-result.json', result),
      'inner_verdict', 'REQUEST_CHANGES',
    ]).code).toBe(0)

    const r = row('run-1')
    expect(r.inner_checkpoint_findings).toBe(findings)
    expect(r.inner_result).toBe(result)
    // ...and the newline did not cost the findings their meaning.
    expect(r.inner_verdict).toBe('REQUEST_CHANGES')
  })

  test('a payload line that LOOKS like a sqlite3 dot-command is DATA, not a command', () => {
    // Statements arriving on stdin are read by the CLI's script reader, which does
    // interpret a leading `.` — but only when no statement is pending, and these
    // bytes are inside one. Pinned because the argv form had no such reader at all,
    // so this is the one exposure the move introduced; `.quit` mid-literal would
    // truncate the write silently.
    const findings = '[\n.quit\n.output /dev/null\n]'

    const res = sh([
      dbPath, 'run-1',
      'branch', 'trident/dot-command',
      'inner_findings_file', fileWith('dot.json', findings),
    ])

    expect(res.code).toBe(0)
    expect(row('run-1')).toMatchObject({ inner_checkpoint_findings: findings, branch: 'trident/dot-command' })
  })
})

describe('checkpoint.sh — retry under lock (PRAGMA busy_timeout=5000, the P10 hardening)', () => {
  test('a write against an EXCLUSIVE-locked db retries and lands once the lock releases (old busy_timeout=0 failed instantly)', async () => {
    const holder = new Database(dbPath)
    holder.exec('BEGIN EXCLUSIVE') // hold the write lock
    const proc = Bun.spawn(['bash', SCRIPT, dbPath, 'run-1', 'inner_checkpoint', 'lock-test', 'subagent_status', 'running'], { stderr: 'pipe' })
    // Keep the lock across most of a second — far beyond busy_timeout=0's
    // instant "database is locked", well inside the 5s retry budget.
    await new Promise((r) => setTimeout(r, 750))
    holder.exec('COMMIT')
    holder.close()
    expect(await proc.exited).toBe(0)
    expect(row('run-1').inner_checkpoint).toBe('lock-test')
  })
})
