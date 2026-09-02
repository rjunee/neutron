import { describe, expect, test } from 'bun:test'
import {
  buildFireEvidenceGatherer,
  defaultBranchHolderProbe,
  FRESH_WORKTREE_SKEW_MS,
  parseProcStartTime,
  parseWorktreeList,
  type FireProbeFs,
} from './fire-evidence-probes.ts'
import type { HostCommandResult } from './git-mode.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTridentRun } from './testing/make-trident-run.ts'
import type { TridentRun } from './store.ts'

const SHA = '7'.repeat(40)
const OID = 'a'.repeat(40)
const FIRE_AT = 1_700_000_000_000
const BRANCH = 'trident/a-fire-turn-settle-timeout'
const HOLDER = '/repo/.claude/worktrees/wf_9d6cb66c-408-2'
const HOLDER_BASE = 'wf_9d6cb66c-408-2'

function run(over: Partial<TridentRun> = {}): TridentRun {
  return makeTridentRun({ id: 'run-1', repo_path: '/repo', branch: BRANCH, ...over })
}

function okHost(stdout: string): HostCommandResult {
  return { ok: true, stdout, stderr: '', exit_code: 0 }
}

/** A main-worktree block on `main`, plus whatever linked blocks a test needs. */
function porcelain(...linked: string[]): string {
  return [`worktree /repo\nHEAD ${OID}\nbranch refs/heads/main`, ...linked].join('\n\n')
}

function linkedBlock(opts: { path?: string; branch?: string | null; locked?: string | null } = {}): string {
  const lines = [`worktree ${opts.path ?? HOLDER}`, `HEAD ${OID}`]
  const branch = opts.branch === undefined ? BRANCH : opts.branch
  if (branch !== null) lines.push(`branch refs/heads/${branch}`)
  else lines.push('detached')
  if (opts.locked !== undefined && opts.locked !== null) {
    lines.push(opts.locked === '' ? 'locked' : `locked ${opts.locked}`)
  }
  return lines.join('\n')
}

/**
 * A `/proc/<pid>/stat` line whose comm contains BOTH spaces and a paren — the
 * shape that defeats a naive `split(' ')[21]` and proves the lastIndexOf-parse.
 * Token index 19 after the close paren is field 22, `starttime`.
 */
function procStat(pid: number, start: number): string {
  return `${pid} (cc (weird) name) S ${Array(18).fill('7').join(' ')} ${start} 0 0`
}

function makeFs(over: Partial<FireProbeFs> = {}): FireProbeFs {
  return {
    lstat: async () => ({ mtimeMs: FIRE_AT - 10 * 60_000 }),
    readFile: async () => '',
    ...over,
  }
}

describe('parseWorktreeList', () => {
  test('parses path, HEAD and full branch ref for every block', () => {
    const entries = parseWorktreeList(porcelain(linkedBlock()))
    expect(entries).toHaveLength(2)
    expect(entries[0]?.path).toBe('/repo')
    expect(entries[0]?.head).toBe(OID)
    expect(entries[0]?.branch).toBe('refs/heads/main')
    expect(entries[1]?.path).toBe(HOLDER)
    expect(entries[1]?.branch).toBe(`refs/heads/${BRANCH}`)
  })

  test('an unlocked worktree has lock_reason null; a bare `locked` line is the empty string', () => {
    expect(parseWorktreeList(porcelain(linkedBlock()))[1]?.lock_reason).toBeNull()
    expect(parseWorktreeList(porcelain(linkedBlock({ locked: '' })))[1]?.lock_reason).toBe('')
  })

  test('`locked <reason>` keeps the reason verbatim', () => {
    const entries = parseWorktreeList(porcelain(linkedBlock({ locked: 'claude agent wf_x (pid 4242 start 987654)' })))
    expect(entries[1]?.lock_reason).toBe('claude agent wf_x (pid 4242 start 987654)')
  })

  test('a detached block has a null branch, and `bare`/`prunable` lines are ignored', () => {
    const entries = parseWorktreeList(`${porcelain(linkedBlock({ branch: null }))}\nprunable gitdir file points to non-existent location`)
    expect(entries[1]?.branch).toBeNull()
  })

  test('a C-quoted path is unquoted (surrounding quotes stripped, \\" and \\\\ unescaped)', () => {
    const entries = parseWorktreeList('worktree "/repo/a \\"b\\" c"\nHEAD ' + OID)
    expect(entries[0]?.path).toBe('/repo/a "b" c')
  })
})

describe('parseProcStartTime', () => {
  test('reads field 22 even when comm holds spaces and parens', () => {
    expect(parseProcStartTime(procStat(4242, 987654))).toBe(987654)
  })

  test('garbage, too-few fields and non-numeric starttimes all read as null', () => {
    expect(parseProcStartTime('no parens at all')).toBeNull()
    expect(parseProcStartTime('1 (sh) S 2 3 4')).toBeNull()
    expect(parseProcStartTime(`1 (sh) S ${Array(18).fill('7').join(' ')} notanumber 0`)).toBeNull()
  })
})

describe('the row is read FIRST, and row evidence needs no filesystem at all', () => {
  test('a moved workflow-owned column reads as launched WITHOUT running git', async () => {
    let host_calls = 0
    const gather = buildFireEvidenceGatherer({
      read_run: () => run({ inner_checkpoint: 'forge-done' }),
      run_host: async () => {
        host_calls += 1
        return okHost('')
      },
      fs: makeFs(),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('launched')
    expect(host_calls).toBe(0)
  })

  test('a PINNED outer-published row is published even when the re-read THROWS (second shape)', async () => {
    const published = `outer-published:${SHA}:0:3`
    const gather = buildFireEvidenceGatherer({
      read_run: () => {
        throw new Error('store unreadable')
      },
      // Nothing holds the branch, so the worktree probe adds nothing and the
      // published classification stands.
      run_host: async () => okHost(porcelain()),
      fs: makeFs(),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({ run: run({ inner_checkpoint: published }), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('published')
    if (evidence.kind === 'published') expect(evidence.checkpoint).toBe(published)
  })

  // MAJOR (round 1): `published` used to return BEFORE the worktree probe ever
  // ran, so a re-fired round — the majority observed shape — was terminalized on
  // the PREVIOUS round's checkpoint without ever asking whether a lane was live.
  // `fire-evidence.ts`'s own rule is that a live delta OUTRANKS outer-published;
  // this is that rule applied to the filesystem.
  test('a live branch holder OUTRANKS an outer-published checkpoint (the re-fired round)', async () => {
    const published = `outer-published:${SHA}:0:3`
    const gather = buildFireEvidenceGatherer({
      read_run: () => run({ inner_checkpoint: published }),
      run_host: async () =>
        okHost(porcelain(linkedBlock({ locked: 'claude agent wf_x (pid 4242 start 987654)' }))),
      fs: makeFs({ readFile: async () => procStat(4242, 987654) }),
      probe_pid_alive: () => 'alive',
    })
    const evidence = await gather({
      run: run({ inner_checkpoint: published }),
      fire_started_at_ms: FIRE_AT,
    })
    expect(evidence.kind).toBe('launched')
    expect(evidence.detail).toContain(HOLDER_BASE)
    expect(evidence.detail).toContain('outranks the published checkpoint')
    // Still no path, still no raw lock reason.
    expect(evidence.detail).not.toContain(HOLDER)
  })

  test('a published row whose branch holder shows NO life stays published', async () => {
    const published = `outer-published:${SHA}:0:3`
    const gather = buildFireEvidenceGatherer({
      read_run: () => run({ inner_checkpoint: published }),
      run_host: async () => okHost(porcelain(linkedBlock({ locked: 'claude agent wf_x (pid 4242 start 1)' }))),
      fs: makeFs(),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({
      run: run({ inner_checkpoint: published }),
      fire_started_at_ms: FIRE_AT,
    })
    expect(evidence.kind).toBe('published')
  })

  test('a published row with NO branch to probe stays published', async () => {
    const published = `outer-published:${SHA}:0:3`
    const gather = buildFireEvidenceGatherer({
      read_run: () => run({ branch: null, inner_checkpoint: published }),
      run_host: async () => okHost(porcelain()),
      fs: makeFs(),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({
      run: run({ branch: null, inner_checkpoint: published }),
      fire_started_at_ms: FIRE_AT,
    })
    expect(evidence.kind).toBe('published')
  })

  // BLOCKER (round 1): the orchestrator writes the row it was given back through
  // `saveIfActive`, which assigns the workflow-owned columns plainly. The evidence
  // therefore has to hand back what it actually READ, or sparing a live lane
  // silently erases that lane's checkpoint.
  test('launched evidence carries the FRESH workflow-owned columns for the caller to apply', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run({ inner_checkpoint: 'forge-done', inner_verdict: 'REVIEW_NOT_RUN' }),
      run_host: async () => okHost(porcelain()),
      fs: makeFs(),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('launched')
    if (evidence.kind === 'launched') {
      expect(evidence.observed?.inner_checkpoint).toBe('forge-done')
      expect(evidence.observed?.inner_verdict).toBe('REVIEW_NOT_RUN')
      // ONLY the workflow-owned columns — never the whole row, or the caller's
      // spread would drag OUTER-owned columns back to their pre-fire values too.
      expect(Object.keys(evidence.observed ?? {}).sort()).toEqual([
        'inner_checkpoint',
        'inner_checkpoint_findings',
        'inner_checkpoint_head',
        'inner_result',
        'inner_verdict',
      ])
    }
  })
})

describe('the branch holder — a live lock is launch evidence', () => {
  const LIVE_LOCK = 'claude agent wf_x (pid 4242 start 987654)'

  test('a live, starttime-verified lock pid reads as launched and leaks no path', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock({ locked: LIVE_LOCK }))),
      fs: makeFs({ readFile: async () => procStat(4242, 987654) }),
      probe_pid_alive: (pid) => (pid === 4242 ? 'alive' : 'dead'),
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('launched')
    expect(evidence.detail).toContain(HOLDER_BASE)
    expect(evidence.detail).toContain('4242')
    // BASENAMES AND PIDS ONLY — the leak gate rejects host paths, and the raw
    // lock reason is free text a substrate wrote.
    expect(evidence.detail).not.toContain('/repo')
    expect(evidence.detail).not.toContain('refs/')
    expect(evidence.detail).not.toContain('claude agent')
  })

  test('MUST STAY FAILED — a RECYCLED pid (starttime mismatch) is not the recorded holder', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock({ locked: LIVE_LOCK }))),
      fs: makeFs({ readFile: async () => procStat(4242, 111111) }),
      probe_pid_alive: () => 'alive',
    })
    expect((await gather({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('none')
  })

  test('an unreadable /proc keeps the signal-0 answer', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock({ locked: LIVE_LOCK }))),
      fs: makeFs({
        readFile: async () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        },
      }),
      probe_pid_alive: () => 'alive',
    })
    expect((await gather({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('launched')
  })

  test('MUST STAY FAILED — a dead lock pid, and an UNKNOWN one, are both not evidence', async () => {
    for (const state of ['dead', 'unknown'] as const) {
      const gather = buildFireEvidenceGatherer({
        read_run: () => run(),
        run_host: async () => okHost(porcelain(linkedBlock({ locked: LIVE_LOCK }))),
        fs: makeFs(),
        probe_pid_alive: () => state,
      })
      expect((await gather({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('none')
    }
  })

  test('a STALE same-branch entry listed FIRST does not mask the live holder behind it', async () => {
    // `git worktree add --force --force` permits two linked trees on one branch.
    // Reading only the first entry reported pid_live:false while a live lane
    // held the branch — the false negative this probe exists to prevent.
    const STALE = '/repo/.claude/worktrees/wf_stale-1'
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () =>
        okHost(
          porcelain(
            linkedBlock({ path: STALE, locked: 'claude agent wf_stale (pid 999 start 111)' }),
            linkedBlock({ locked: LIVE_LOCK }),
          ),
        ),
      fs: makeFs({ readFile: async () => procStat(4242, 987654) }),
      probe_pid_alive: (pid) => (pid === 4242 ? 'alive' : 'dead'),
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('launched')
    // The LIVE holder is the one reported, not the stale one listed ahead of it.
    expect(evidence.detail).toContain(HOLDER_BASE)
    expect(evidence.detail).toContain('4242')
    expect(evidence.detail).not.toContain('wf_stale-1')
  })

  // ARGUS r5 (BLOCKER): preferring a LIVE candidate fixed only half of it. With
  // no live candidate the probe returned the FIRST one, and the caller can only
  // ask its other liveness question — is the tree's mtime at/after the fire? —
  // of the single probe it gets back. So a stale dead-pid entry listed first
  // masked a same-branch tree cut AFTER the fire, and the run terminalized under
  // a lane that had just started.
  test('a STALE dead-pid entry listed FIRST does not mask the FRESH worktree behind it', async () => {
    const STALE = '/repo/.claude/worktrees/wf_stale-1'
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () =>
        okHost(
          porcelain(
            linkedBlock({ path: STALE, locked: 'claude agent wf_stale (pid 999 start 111)' }),
            linkedBlock(),
          ),
        ),
      fs: makeFs({
        lstat: async (p) => ({ mtimeMs: p === STALE ? FIRE_AT - 10 * 60_000 : FIRE_AT + 500 }),
        readFile: async () => procStat(999, 111),
      }),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('launched')
    expect(evidence.detail).toContain('touched at/after the fire')
    expect(evidence.detail).toContain(HOLDER_BASE)
    expect(evidence.detail).not.toContain('wf_stale-1')
  })

  test('an UNREADABLE mtime never displaces a readable one', async () => {
    // A stat that could not happen is not evidence of recency, so the freshest
    // READABLE candidate stays the answer even when it is listed first.
    const BLIND = '/repo/.claude/worktrees/wf_blind-1'
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock(), linkedBlock({ path: BLIND }))),
      fs: makeFs({
        lstat: async (p) => {
          if (p === BLIND) throw new Error('ENOENT')
          return { mtimeMs: FIRE_AT + 500 }
        },
      }),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('launched')
    expect(evidence.detail).toContain(HOLDER_BASE)
  })

  test('MUST STAY FAILED — two same-branch entries, both stale, are still no evidence', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () =>
        okHost(porcelain(linkedBlock({ path: '/repo/.claude/worktrees/wf_stale-1' }), linkedBlock())),
      fs: makeFs({ lstat: async () => ({ mtimeMs: FIRE_AT - 10 * 60_000 }) }),
      probe_pid_alive: () => 'dead',
    })
    expect((await gather({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('none')
  })

  test('MUST STAY FAILED — pid 1 in the lock reason is treated as absent', async () => {
    const asked: number[] = []
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock({ locked: 'claude agent wf_x (pid 1 start 5)' }))),
      fs: makeFs(),
      probe_pid_alive: (pid) => {
        asked.push(pid)
        return 'alive'
      },
    })
    expect((await gather({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('none')
    expect(asked).toEqual([])
  })
})

describe('the branch holder — a fresh worktree is launch evidence on its own', () => {
  test('an unlocked worktree touched after the fire reads as launched', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock())),
      fs: makeFs({ lstat: async () => ({ mtimeMs: FIRE_AT + 500 }) }),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('launched')
    expect(evidence.detail).toContain('touched at/after the fire')
  })

  test('the skew edge is INCLUSIVE — exactly fire minus the skew still counts', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock())),
      fs: makeFs({ lstat: async () => ({ mtimeMs: FIRE_AT - FRESH_WORKTREE_SKEW_MS }) }),
      probe_pid_alive: () => 'dead',
    })
    expect((await gather({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('launched')
  })

  test('MUST STAY FAILED — a stale pre-existing worktree with no live lock is not evidence', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock())),
      fs: makeFs({ lstat: async () => ({ mtimeMs: FIRE_AT - 10 * 60_000 }) }),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('none')
    expect(evidence.detail).toContain('shows no life')
  })

  test('a failed lstat does not veto a live lock, but alone it is not evidence', async () => {
    const throwing = makeFs({
      lstat: async () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      },
      readFile: async () => procStat(4242, 987654),
    })
    const live = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock({ locked: 'agent (pid 4242 start 987654)' }))),
      fs: throwing,
      probe_pid_alive: () => 'alive',
    })
    expect((await live({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('launched')

    const unlocked = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock())),
      fs: throwing,
      probe_pid_alive: () => 'alive',
    })
    expect((await unlocked({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('none')
  })
})

describe('MUST STAY FAILED — a look that could not happen contributes NOTHING (the positive-only inversion)', () => {
  const hosts: Array<[string, () => Promise<HostCommandResult>]> = [
    ['a non-zero `git worktree list`', async () => ({ ok: false, stdout: '', stderr: 'not a repository', exit_code: 128 })],
    ['a TIMED-OUT `git worktree list`', async () => ({ ok: false, stdout: '', stderr: '', exit_code: -1, timed_out: true })],
    [
      'a host runner that THROWS',
      async () => {
        throw new Error('spawn ENOENT')
      },
    ],
  ]

  for (const [label, run_host] of hosts) {
    test(`${label} yields none, and the gatherer never rejects`, async () => {
      const gather = buildFireEvidenceGatherer({
        read_run: () => run(),
        run_host,
        fs: makeFs(),
        probe_pid_alive: () => 'alive',
      })
      const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
      expect(evidence.kind).toBe('none')
      // AND IT SAYS WHICH SILENCE IT IS. "no holder" and "could not ask" used to
      // render the same sentence; only the second is a look that never happened.
      expect(evidence.detail).toContain('the worktree probe could not run')
    })
  }

  // ARGUS r3 (minor), DECLINED IN PART AND PINNED: the review asked that the
  // `published` arm require a look that RAN. It must not. A probe that could not
  // run is silence, and silence does not outrank a checkpoint the outer loop
  // wrote AFTER pushing — downgrading that row to `failed` is precisely the
  // SECOND SHAPE this card exists to delete (a finished, pushed build announced
  // as a failure, whose wake then invites a rebuild). The distinction is spent
  // on the SENTENCE instead, above.
  for (const [label, run_host] of hosts) {
    test(`a PUBLISHED row still terminalizes when the probe could not run (${label})`, async () => {
      const published = `outer-published:${SHA}:0:3`
      const gather = buildFireEvidenceGatherer({
        read_run: () => run({ inner_checkpoint: published }),
        run_host,
        fs: makeFs(),
        probe_pid_alive: () => 'alive',
      })
      const evidence = await gather({
        run: run({ inner_checkpoint: published }),
        fire_started_at_ms: FIRE_AT,
      })
      expect(evidence.kind).toBe('published')
    })
  }
})

describe('MUST STAY FAILED — a pid the lock reason never named', () => {
  // ARGUS r3 (minor): `/pid (\d+)/` matched the tail of ANY word, so the lock
  // reason `stupid 45` parsed as pid 45 — and a pid the kernel happens to know
  // then reads as a LIVE holder, sparing a run on evidence made of a word.
  test('`stupid 45` is not a pid, even with every pid alive', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock({ locked: 'stupid 45' }))),
      fs: makeFs(),
      probe_pid_alive: () => 'alive',
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('none')
    expect(evidence.detail).toContain('no live lock pid')
  })

  test('the shapes the substrate really writes still parse — leading, and after `(`', async () => {
    for (const locked of [`pid ${process.pid} start 1`, `claude agent wf_x (pid ${process.pid} start 1)`]) {
      const gather = buildFireEvidenceGatherer({
        read_run: () => run(),
        run_host: async () => okHost(porcelain(linkedBlock({ locked }))),
        fs: makeFs(),
        probe_pid_alive: () => 'alive',
      })
      const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
      // The pid parsed and read alive; the starttime check is what decides it,
      // and `readFile` returns '' here — unparsable, so the signal-0 answer stands.
      expect(evidence.kind).toBe('launched')
      expect(evidence.detail).toContain(String(process.pid))
    }
  })
})

describe('what is NOT a holder', () => {
  test('the SHARED CHECKOUT is never launch evidence, even sitting on the run branch', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () =>
        okHost(
          [`worktree /repo\nHEAD ${OID}\nbranch refs/heads/${BRANCH}\nlocked agent (pid 4242 start 987654)`].join('\n'),
        ),
      fs: makeFs({ readFile: async () => procStat(4242, 987654), lstat: async () => ({ mtimeMs: FIRE_AT + 500 }) }),
      probe_pid_alive: () => 'alive',
    })
    expect((await gather({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('none')
  })

  test('a run with no branch is never probed', async () => {
    let host_calls = 0
    const gather = buildFireEvidenceGatherer({
      read_run: () => run({ branch: null }),
      run_host: async () => {
        host_calls += 1
        return okHost('')
      },
      fs: makeFs(),
      probe_pid_alive: () => 'alive',
    })
    const evidence = await gather({ run: run({ branch: null }), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('none')
    expect(evidence.detail).toContain('no branch to probe')
    expect(host_calls).toBe(0)
  })

  test('a linked worktree on ANOTHER branch is not the holder', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain(linkedBlock({ branch: 'trident/something-else' }))),
      fs: makeFs({ lstat: async () => ({ mtimeMs: FIRE_AT + 500 }) }),
      probe_pid_alive: () => 'alive',
    })
    expect((await gather({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('none')
  })
})

// BLOCKER (round 2): the row was read ONCE, at the top, and the branch-holder
// probe that follows may take the whole 15 s host bound. A checkpoint landing in
// that window was invisible — the gate returned the PRE-probe snapshot as
// `observed`, and the caller's `saveIfActive` wrote it straight back over the
// detached workflow's progress. The gate that exists to protect the lane was
// destroying its work.
describe('the probe window is closed — the row is re-read AFTER the worktree probe', () => {
  /** Read the pre-probe row first, then whatever the workflow wrote during the probe. */
  function readsInOrder(...rows: TridentRun[]): () => TridentRun {
    let i = 0
    return () => rows[Math.min(i++, rows.length - 1)]!
  }

  test('a checkpoint that lands DURING the probe is carried forward, not clobbered', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: readsInOrder(run(), run({ inner_checkpoint: 'forge-done', inner_checkpoint_head: OID })),
      run_host: async () => okHost(porcelain(linkedBlock({ locked: 'claude agent wf_x (pid 4242 start 987654)' }))),
      fs: makeFs({ readFile: async () => procStat(4242, 987654) }),
      probe_pid_alive: () => 'alive',
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('launched')
    if (evidence.kind !== 'launched') throw new Error('unreachable')
    expect(evidence.observed?.inner_checkpoint).toBe('forge-done')
    expect(evidence.observed?.inner_checkpoint_head).toBe(OID)
  })

  test('a row that moves during the probe is launch evidence on its OWN, with no live holder', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: readsInOrder(run(), run({ inner_checkpoint: 'ralph-task-built' })),
      // Nothing holds the branch: without the second read this is plain `none`.
      run_host: async () => okHost(porcelain()),
      fs: makeFs(),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({ run: run(), fire_started_at_ms: FIRE_AT })
    expect(evidence.kind).toBe('launched')
    if (evidence.kind === 'launched') {
      expect(evidence.detail).toContain('inner_checkpoint')
      expect(evidence.observed?.inner_checkpoint).toBe('ralph-task-built')
    }
  })

  test('MUST STAY FAILED — a second read that finds nothing new is still no evidence', async () => {
    const gather = buildFireEvidenceGatherer({
      read_run: () => run(),
      run_host: async () => okHost(porcelain()),
      fs: makeFs(),
      probe_pid_alive: () => 'dead',
    })
    expect((await gather({ run: run(), fire_started_at_ms: FIRE_AT })).kind).toBe('none')
  })

  test('a published row whose SECOND read throws still classifies from the first', async () => {
    let calls = 0
    const gather = buildFireEvidenceGatherer({
      read_run: () => {
        calls += 1
        if (calls > 1) throw new Error('store went away mid-probe')
        return run({ inner_checkpoint: `outer-published:${SHA}:0:3` })
      },
      run_host: async () => okHost(porcelain()),
      fs: makeFs(),
      probe_pid_alive: () => 'dead',
    })
    const evidence = await gather({
      run: run({ inner_checkpoint: `outer-published:${SHA}:0:3` }),
      fire_started_at_ms: FIRE_AT,
    })
    expect(evidence.kind).toBe('published')
  })
})

describe('defaultBranchHolderProbe — the dispatch-side default wiring', () => {
  test('a directory that is not a git repo yields null, because a failed look is silence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-fire-holder-'))
    try {
      expect(await defaultBranchHolderProbe(dir, 'trident/x')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
