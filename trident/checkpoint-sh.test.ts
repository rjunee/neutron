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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERMINAL_PHASES } from './state-machine.ts'
import type { TridentPhase } from './store.ts'

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
    pr INTEGER,
    branch TEXT,
    inner_checkpoint TEXT,
    inner_checkpoint_head TEXT,
    inner_checkpoint_findings TEXT,
    inner_verdict TEXT,
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

describe('checkpoint.sh — C1 per-phase checkpoint write (legacy checkpoint() SQL)', () => {
  test('writes pr/branch/inner_checkpoint/subagent_status + stamps last_advanced_at on ONLY the addressed row', () => {
    const res = sh([dbPath, 'run-1', 'pr', '55', 'branch', 'trident/add-widget', 'inner_checkpoint', 'forge-done', 'subagent_status', 'running'])
    expect(res.code).toBe(0)
    const r = row('run-1')
    expect(r.pr).toBe(55)
    expect(r.branch).toBe('trident/add-widget')
    expect(r.inner_checkpoint).toBe('forge-done')
    expect(r.subagent_status).toBe('running')
    // Timestamp computed in-script (`date -u +%FT%TZ`), like the old Bash step.
    expect(String(r.last_advanced_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
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
})

describe('checkpoint.sh — terminal-result write (legacy writeTerminalResult() SQL)', () => {
  const json = '{"ok":true,"verdict":"APPROVE","prNumber":55,"branch":"trident/add-widget","round":1,"checkpoint":"argus-approved"}'

  test('inner_result_file loads the JSON via readfile() and flips subagent_status to completed; idempotent', () => {
    const tmp = join(dir, 'terminal.json')
    writeFileSync(tmp, json)
    const args = [dbPath, 'run-1', 'inner_result_file', tmp, 'inner_verdict', 'APPROVE', 'branch', 'trident/add-widget', 'pr', '55']
    expect(sh(args).code).toBe(0)
    const first = row('run-1')
    // The JSON round-trips byte-identically (readfile CAST AS TEXT — its own
    // double quotes never touch the sqlite shell argument).
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
    expect(r.inner_result).toBe('') // readfile of an empty file → empty text, not terminal (parseInnerResult → null)
  })

  test('COLUMN CONSISTENCY: a MISSING result file leaves inner_result NULL and subagent_status untouched', () => {
    expect(sh([dbPath, 'run-1', 'inner_result_file', join(dir, 'nope.json'), 'inner_verdict', 'APPROVE', 'branch', 'b']).code).toBe(0)
    const r = row('run-1')
    expect(r.inner_result).toBeNull()
    expect(r.subagent_status).toBe('pending')
  })
})

describe('checkpoint.sh — the checkpoint records WHICH COMMIT it applied to (0121)', () => {
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

  test('inner_findings_file loads the findings JSON via readfile(), quotes and all', () => {
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
      expect(String(r.last_advanced_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    },
  )

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
    expect(res.code).toBe(0)
    expect(res.stderr).toContain('not found — checkpoint NOT applied')
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
