/**
 * `phase` is written from the checkpoint — the TypeScript table, the Bash mirror,
 * and the REAL-sqlite behaviour of `checkpoint.sh`.
 *
 * The defect this pins, measured over every run the production database has held:
 * `failed` 138, `stopped` 59, `done` 9, `forge-init` 1, and ZERO rows in any of
 * the four in-flight phases. `phase` was written once at create and then not
 * again until a terminal write, so every raw read of it said "init" for the whole
 * life of a build. See `checkpoint-phase.ts` for the full account.
 *
 * What this suite pins:
 *   1. the TS table answers correctly, INCLUDING the three distinct `null` cases
 *      (terminal-adjacent, outer-loop marker, unrecognised);
 *   2. THE TWO COPIES AGREE — the Bash `phase_for_checkpoint` in `checkpoint.sh`
 *      is executed for real and compared against `phaseForCheckpoint` for every
 *      checkpoint name the inner workflow can emit. A second copy that drifts is
 *      worse than no second copy, and this is the same treatment the terminal
 *      phase set already gets;
 *   3. every phase the table can produce is one production's CHECK constraint
 *      actually accepts — a typo'd phase would otherwise fail the UPDATE at
 *      runtime, on the hot checkpoint path, where the script must never fail;
 *   4. THE RESURRECTION GUARD. `phase` is the only column here that drives
 *      control flow, and cancelling a build does not kill the workflow that was
 *      building it. A terminal row's phase must survive its own orphan's
 *      checkpoints — otherwise `stopped` flips back to `argus` and the run is
 *      re-loaded, re-driven and re-merged.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasArgusProvenance, phaseForCheckpoint } from './checkpoint-phase.ts'
import { TERMINAL_PHASES } from './state-machine.ts'
import type { TridentPhase } from './store.ts'

const SCRIPT = fileURLToPath(new URL('./checkpoint.sh', import.meta.url))

/** Migration 0077's phase CHECK set, verbatim — typed so a typo fails typecheck. */
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

const SEEDED_HEARTBEAT = '2026-01-01T00:00:00Z'

/**
 * Every checkpoint name the inner workflow can emit, plus the shapes that must
 * fall through. Sourced by reading `inner-workflow.mjs` for `checkpoint('…')`
 * call sites and the production DB's distinct `inner_checkpoint` values; the
 * fall-through cases are here because they are the ones a careless default
 * would get WRONG rather than merely unhandled.
 */
const CHECKPOINT_NAMES: readonly string[] = [
  // in-flight, each implying a phase
  'forge-done',
  'argus-approved',
  'ralph-task-built',
  'argus-request-changes',
  'argus-request-changes-round-1',
  'argus-request-changes-round-2',
  'argus-request-changes-round-10',
  'fix-round-1',
  'fix-round-2',
  'fix-round-5',
  'fix-round-10',
  // THE FOUR-DIGIT BOUNDARY. The Bash mirror enumerated one-, two- and
  // three-digit globs, so `fix-round-1000` left `phase` untouched there while the
  // TypeScript table (`/^fix-round-\d+$/`) answered `argus` — a divergence in the
  // one table whose whole claim is TOTAL equivalence, and one the corpus could not
  // see because it stopped at round 10 (Argus r8).
  'fix-round-999',
  'fix-round-1000',
  'argus-request-changes-round-999',
  'argus-request-changes-round-1000',
  // terminal-adjacent — the OUTER loop stamps the terminal phase, not us
  'pr-merged',
  'inner-error',
  'awaiting-trailer',
  // outer-loop bookkeeping marker (a real value from the production table)
  'outer-published:c37bb3f27e95ff8a0673f1410954046749891ce5:0:3',
  // unrecognised / adversarial shapes
  '',
  'forge-done-but-not-really',
  'fix-round-',
  'fix-round-x',
  'argus-request-changes-round-',
  'ralph-task-built ',
  'FORGE-DONE',
  'a-checkpoint-invented-next-week',
]

describe('phaseForCheckpoint — the canonical table', () => {
  test('a finished build and an approved review are both the review phase', () => {
    expect(phaseForCheckpoint('forge-done')).toBe('argus')
    expect(phaseForCheckpoint('argus-approved')).toBe('argus')
  })

  test('fix-round-N is the RE-REVIEW, not the build that just ended', () => {
    // The contradiction this resolves: `deriveStepLabel` read this checkpoint as
    // 'reviewing' while `deriveRunProgress` read it as 'building', so a single
    // progress snapshot asserted both at once.
    expect(phaseForCheckpoint('fix-round-1')).toBe('argus')
    expect(phaseForCheckpoint('fix-round-10')).toBe('argus')
    // The digit run is UNBOUNDED here, and the round parser's nine-digit bound is
    // deliberately NOT copied across: that bound exists because `checkpointRound`
    // does arithmetic on the value, and naming a phase does not.
    expect(phaseForCheckpoint('fix-round-1000')).toBe('argus')
    expect(phaseForCheckpoint('fix-round-1234567890')).toBe('argus')
  })

  test('a change request is the fix round that follows it', () => {
    expect(phaseForCheckpoint('argus-request-changes')).toBe('forge-fix')
    expect(phaseForCheckpoint('argus-request-changes-round-1')).toBe('forge-fix')
    expect(phaseForCheckpoint('argus-request-changes-round-10')).toBe('forge-fix')
  })

  test('one Ralph task built means the next one is being built', () => {
    expect(phaseForCheckpoint('ralph-task-built')).toBe('ralph-task')
  })

  test('terminal-adjacent checkpoints imply NOTHING — the outer loop owns those', () => {
    // Naming a live phase for any of these shows a finished run as working.
    expect(phaseForCheckpoint('pr-merged')).toBeNull() // outer stamps `done`
    expect(phaseForCheckpoint('inner-error')).toBeNull() // outer stamps `failed`
    expect(phaseForCheckpoint('awaiting-trailer')).toBeNull() // ditto — throw path
  })

  test('an outer-loop marker and an unknown name leave the phase alone', () => {
    expect(phaseForCheckpoint('outer-published:abc123:0:3')).toBeNull()
    expect(phaseForCheckpoint('a-checkpoint-invented-next-week')).toBeNull()
    expect(phaseForCheckpoint(null)).toBeNull()
    expect(phaseForCheckpoint('')).toBeNull()
  })

  test('near-miss shapes are NOT coerced into a phase', () => {
    // A prefix/suffix match would make `fix-round-` and a trailing space answer
    // as though they were real checkpoints.
    expect(phaseForCheckpoint('fix-round-')).toBeNull()
    expect(phaseForCheckpoint('fix-round-x')).toBeNull()
    expect(phaseForCheckpoint('forge-done-but-not-really')).toBeNull()
    expect(phaseForCheckpoint('ralph-task-built ')).toBeNull()
    expect(phaseForCheckpoint('FORGE-DONE')).toBeNull()
  })

  test('every phase this table can produce is one the CHECK constraint accepts', () => {
    // A phase outside migration 0077's CHECK set would fail the UPDATE at
    // runtime, on the hot checkpoint path, where the script must never fail.
    const produced = CHECKPOINT_NAMES.map((c) => phaseForCheckpoint(c)).filter(
      (p): p is TridentPhase => p !== null,
    )
    expect(produced.length).toBeGreaterThan(0) // positive control: the map is not inert
    for (const p of produced) expect(ALL_PHASES).toContain(p)
  })

  test('it never produces a TERMINAL phase', () => {
    // Only the outer loop may end a run. A checkpoint that could write `done`
    // would let the inner loop declare its own success.
    for (const name of CHECKPOINT_NAMES) {
      const p = phaseForCheckpoint(name)
      if (p !== null) expect(TERMINAL_PHASES as readonly string[]).not.toContain(p)
    }
  })
})

describe('the Bash mirror in checkpoint.sh agrees with the TypeScript table', () => {
  /** Run the script's own `phase_for_checkpoint` by sourcing it out of the file. */
  function bashPhaseFor(checkpoint: string): string {
    const src = readFileSync(SCRIPT, 'utf8')
    const start = src.indexOf('phase_for_checkpoint() {')
    expect(start).toBeGreaterThan(-1) // the function must still be findable
    const end = src.indexOf('\n}\n', start)
    expect(end).toBeGreaterThan(start)
    const fn = src.slice(start, end + 3)
    const p = Bun.spawnSync(['bash', '-c', `${fn}\nphase_for_checkpoint "$1"`, '_', checkpoint])
    expect(p.exitCode).toBe(0)
    return p.stdout.toString()
  }

  test('the extracted function is real bash, not an empty slice', () => {
    // Guards the extraction itself: an empty or malformed slice would make every
    // comparison below pass by both sides answering ''.
    expect(bashPhaseFor('forge-done')).toBe('argus')
  })

  for (const name of CHECKPOINT_NAMES) {
    test(`both copies agree for ${JSON.stringify(name)}`, () => {
      expect(bashPhaseFor(name)).toBe(phaseForCheckpoint(name) ?? '')
    })
  }
})

describe('checkpoint.sh writes the phase — against a real sqlite database', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trident-checkpoint-phase-'))
    dbPath = join(dir, 'trident.db')
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE code_trident_runs (
      id TEXT PRIMARY KEY,
      phase TEXT NOT NULL DEFAULT 'forge-init'
        CHECK (phase IN (${ALL_PHASES.map((p) => `'${p}'`).join(', ')})),
      -- Schema mirror only (migrations/expected-schema.txt:592): checkpoint.sh now
      -- also derives \`round\` from a round-carrying name, and the fix-round-N walk
      -- below would error 'no such column' against a table that lacks it.
      round INTEGER NOT NULL DEFAULT 1,
      pr INTEGER,
      branch TEXT,
      brief_alert TEXT,
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
       VALUES ('live', 'forge-init', 'running', '${SEEDED_HEARTBEAT}'),
              ('cancelled', 'stopped', NULL, '${SEEDED_HEARTBEAT}'),
              ('failed-run', 'failed', NULL, '${SEEDED_HEARTBEAT}')`,
    )
    db.close()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function sh(args: string[]): { code: number; stderr: string } {
    const p = Bun.spawnSync(['bash', SCRIPT, dbPath, ...args])
    return { code: p.exitCode, stderr: p.stderr.toString() }
  }

  function row(id: string): Record<string, unknown> {
    const db = new Database(dbPath, { readonly: true })
    const r = db.query('SELECT * FROM code_trident_runs WHERE id = ?').get(id) as Record<
      string,
      unknown
    >
    db.close()
    return r
  }

  test('a live run walks build → review → fix → re-review, in the column itself', () => {
    // The whole point: a raw read of `phase` now names where the run IS. Before
    // this, every one of these assertions read 'forge-init'.
    expect(row('live')['phase']).toBe('forge-init')

    expect(sh(['live', 'inner_checkpoint', 'forge-done']).code).toBe(0)
    expect(row('live')['phase']).toBe('argus')

    expect(sh(['live', 'inner_checkpoint', 'argus-request-changes-round-1']).code).toBe(0)
    expect(row('live')['phase']).toBe('forge-fix')

    expect(sh(['live', 'inner_checkpoint', 'fix-round-2']).code).toBe(0)
    expect(row('live')['phase']).toBe('argus')
  })

  test('a checkpoint that implies nothing leaves the phase exactly as it was', () => {
    expect(sh(['live', 'inner_checkpoint', 'forge-done']).code).toBe(0)
    expect(row('live')['phase']).toBe('argus')

    for (const inert of ['pr-merged', 'inner-error', 'awaiting-trailer', 'who-knows']) {
      expect(sh(['live', 'inner_checkpoint', inert]).code).toBe(0)
      expect(row('live')['phase']).toBe('argus') // unchanged
      expect(row('live')['inner_checkpoint']).toBe(inert) // but still recorded
    }
  })

  test('the write is idempotent — the same checkpoint twice is the same phase', () => {
    expect(sh(['live', 'inner_checkpoint', 'forge-done']).code).toBe(0)
    expect(sh(['live', 'inner_checkpoint', 'forge-done']).code).toBe(0)
    expect(row('live')['phase']).toBe('argus')
  })

  test('a field write that is NOT a checkpoint never touches the phase', () => {
    expect(sh(['live', 'branch', 'trident/some-branch', 'pr', '123']).code).toBe(0)
    expect(row('live')['phase']).toBe('forge-init')
    expect(sh(['live', 'inner_verdict', 'APPROVE']).code).toBe(0)
    expect(row('live')['phase']).toBe('forge-init')
  })

  test('RESURRECTION GUARD: an orphan cannot lift a cancelled run back to live', () => {
    // Cancelling does NOT kill the detached workflow (rjunee/neutron#177), so it
    // keeps checkpointing at a terminal row. `isTerminalPhase` is what keeps that
    // row out of the tick driver — flipping it back to `argus` would have the run
    // re-loaded, re-driven and re-merged after the owner cancelled it.
    for (const id of ['cancelled', 'failed-run']) {
      const before = row(id)['phase']
      for (const cp of ['forge-done', 'fix-round-3', 'argus-request-changes', 'ralph-task-built']) {
        expect(sh([id, 'inner_checkpoint', cp]).code).toBe(0)
        expect(row(id)['phase']).toBe(before) // never resurrected
      }
      // ...while the orphan stays TRACEABLE — the checkpoint itself still lands.
      expect(row(id)['inner_checkpoint']).toBe('ralph-task-built')
    }
  })

  test('the terminal freeze still covers the liveness pair alongside the phase', () => {
    expect(sh(['cancelled', 'inner_checkpoint', 'forge-done', 'subagent_status', 'running']).code).toBe(0)
    const r = row('cancelled')
    expect(r['phase']).toBe('stopped')
    expect(r['subagent_status']).toBeNull()
    expect(r['last_advanced_at']).toBe(SEEDED_HEARTBEAT)
  })

  test('a live run DOES still get its heartbeat re-stamped when the phase moves', () => {
    // Positive control for the test above: the freeze must be terminal-only, not
    // a blanket refusal that would silence the hang watchdog on healthy runs.
    expect(sh(['live', 'inner_checkpoint', 'forge-done']).code).toBe(0)
    const r = row('live')
    expect(r['phase']).toBe('argus')
    expect(r['last_advanced_at']).not.toBe(SEEDED_HEARTBEAT)
  })
})

describe('hasArgusProvenance — did the reviewer actually speak?', () => {
  test('the checkpoints that can only exist AFTER a review are provenance', () => {
    expect(hasArgusProvenance('argus-approved')).toBe(true)
    expect(hasArgusProvenance('argus-request-changes')).toBe(true)
    expect(hasArgusProvenance('argus-request-changes-round-1')).toBe(true)
    expect(hasArgusProvenance('argus-request-changes-round-10')).toBe(true)
    // A fix round only ever follows an `argus-request-changes`.
    expect(hasArgusProvenance('fix-round-1')).toBe(true)
    expect(hasArgusProvenance('fix-round-7')).toBe(true)
  })

  test('forge-done is NOT provenance — review is what runs NEXT', () => {
    // The measured hole: 68 terminal rows sat at `forge-done` carrying the suite
    // gate's own blocker finding, and every one was recorded as a reviewed
    // REQUEST_CHANGES. The build finished; nobody reviewed it.
    expect(hasArgusProvenance('forge-done')).toBe(false)
  })

  test('the throw path and the pre-review checkpoints are NOT provenance', () => {
    expect(hasArgusProvenance('inner-error')).toBe(false) // 45 more of the same
    expect(hasArgusProvenance('awaiting-trailer')).toBe(false)
    expect(hasArgusProvenance('ralph-task-built')).toBe(false)
    expect(hasArgusProvenance('pr-merged')).toBe(false)
    expect(hasArgusProvenance('outer-published:abc123:0:3')).toBe(false)
    expect(hasArgusProvenance(null)).toBe(false)
    expect(hasArgusProvenance('')).toBe(false)
  })

  test('near-miss shapes are NOT coerced into provenance', () => {
    // Same discipline the phase table gets: a name that merely LOOKS like a
    // reviewed checkpoint must not buy a verdict.
    expect(hasArgusProvenance('fix-round-x')).toBe(false)
    expect(hasArgusProvenance('fix-round-')).toBe(false)
    expect(hasArgusProvenance('argus-request-changes-round-')).toBe(false)
    expect(hasArgusProvenance('ARGUS-APPROVED')).toBe(false)
    expect(hasArgusProvenance('argus-approved ')).toBe(false)
    expect(hasArgusProvenance('not-argus-approved')).toBe(false)
    expect(hasArgusProvenance('a-checkpoint-invented-next-week')).toBe(false)
  })
})
