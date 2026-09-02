import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  changeSignatureEntries,
  COLS,
  TridentEmptyFindingsRejectionError,
  TridentIncompleteSeedError,
  TridentRunStore,
  TridentUnresumableSeedError,
  waveChildSlug,
} from './store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-store-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('claimAgentWake', () => {
  test('returns true exactly once for a terminal run', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'wake-failed', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, { phase: 'failed' })

    expect(await store.claimAgentWake(run.id)).toBe(true)
    expect(await store.claimAgentWake(run.id)).toBe(false)
  })

  test('returns false for a non-terminal run', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'wake-active', project_slug: 't1', repo_path: '/r', task: 't' })
    expect(await store.claimAgentWake(run.id)).toBe(false)
  })

  test('returns false for an unknown id', async () => {
    const store = new TridentRunStore(db)
    expect(await store.claimAgentWake('missing')).toBe(false)
  })

  test('claim survives a full snapshot save', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'wake-save', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, { phase: 'done' })
    expect(await store.claimAgentWake(run.id)).toBe(true)

    await store.save(store.get(run.id)!)
    expect(await store.claimAgentWake(run.id)).toBe(false)
  })
})

describe('TridentRunStore', () => {
  test('migration applies — code_trident_runs table exists', () => {
    const row = db
      .prepare<{ name: string }, [string]>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get('code_trident_runs')
    expect(row?.name).toBe('code_trident_runs')
  })

  test('listDistinctRepos dedupes by repo, includes terminal runs, and uses the latest merge mode', async () => {
    let second = 0
    const store = new TridentRunStore(
      db,
      () => new Date(Date.UTC(2026, 7, 18, 0, 0, second++)).toISOString(),
    )
    const r1PrDone = await store.create({
      slug: 'repo-r1-pr-done', project_slug: 't1', repo_path: '/r1', task: 't', merge_mode: 'pr',
    })
    await store.create({
      slug: 'repo-r1-pr-active', project_slug: 't1', repo_path: '/r1', task: 't', merge_mode: 'pr',
    })
    await store.update(r1PrDone.id, { phase: 'done' })
    await store.create({
      slug: 'repo-r1-local', project_slug: 't1', repo_path: '/r1', task: 't', merge_mode: 'local',
    })
    await store.create({
      slug: 'repo-r2-pr', project_slug: 't1', repo_path: '/r2', task: 't', merge_mode: 'pr',
    })

    expect(store.listDistinctRepos()).toEqual([
      { repo_path: '/r2', merge_mode: 'pr' },
      { repo_path: '/r1', merge_mode: 'local' },
    ])
  })

  test('recordStageEvent + stageEvents round-trip nullable meta in insertion order', async () => {
    const times = [
      '2026-08-18T10:00:00.100Z',
      '2026-08-18T10:00:00.300Z',
      '2026-08-18T10:00:00.200Z',
      '2026-08-18T10:00:00.400Z',
    ]
    const store = new TridentRunStore(db, () => times.shift()!)
    await store.recordStageEvent('run-stage', 'launch-start', 'round=1 ralph_round=0')
    await store.recordStageEvent('run-stage', 'fire-dispatched')
    await store.recordStageEvent('run-stage', 'fire-settled', null)
    await store.recordStageEvent('other-run', 'wrapper-start')

    const got = store.stageEvents('run-stage')
    expect(got.map(({ stage, at, meta }) => ({ stage, at, meta }))).toEqual([
      { stage: 'launch-start', at: '2026-08-18T10:00:00.100Z', meta: 'round=1 ralph_round=0' },
      { stage: 'fire-dispatched', at: '2026-08-18T10:00:00.300Z', meta: null },
      { stage: 'fire-settled', at: '2026-08-18T10:00:00.200Z', meta: null },
    ])
    expect(got[0]!.id).toBeLessThan(got[1]!.id)
    expect(got[1]!.id).toBeLessThan(got[2]!.id)
  })

  test('stage events survive a reap and append across a re-fire', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'stage-survival',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'measure the launch',
    })
    for (const stage of ['launch-start', 'fire-dispatched', 'fire-settled']) {
      await store.recordStageEvent(run.id, stage)
    }

    await store.update(run.id, {
      phase: 'failed',
      subagent_status: 'failed',
      failure_reason: 'launcher reaped',
    })
    expect(store.stageEvents(run.id).map((event) => event.stage)).toEqual([
      'launch-start',
      'fire-dispatched',
      'fire-settled',
    ])

    await store.recordStageEvent(run.id, 'launch-start', 'round=2 ralph_round=0')
    await store.recordStageEvent(run.id, 'fire-dispatched')
    expect(store.stageEvents(run.id).map((event) => event.stage)).toEqual([
      'launch-start',
      'fire-dispatched',
      'fire-settled',
      'launch-start',
      'fire-dispatched',
    ])
  })

  test('listRepoPaths returns each distinct repo across terminal and non-terminal runs', async () => {
    const store = new TridentRunStore(db)
    await store.create({
      slug: 'active-a',
      project_slug: 't1',
      repo_path: '/repo/a',
      task: 'active',
    })
    await store.create({
      slug: 'done-a',
      project_slug: 't1',
      repo_path: '/repo/a',
      task: 'done',
      phase: 'done',
    })
    await store.create({
      slug: 'failed-b',
      project_slug: 't1',
      repo_path: '/repo/b',
      task: 'failed',
      phase: 'failed',
    })

    expect(store.listRepoPaths()).toEqual(['/repo/a', '/repo/b'])
  })

  test('create + get round-trips every column with defaults', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'fix-reminder-api',
      project_slug: 't1',
      repo_path: '/home/x/repos/neutron',
      task: 'Run /slfg to fix the reminder API',
    })
    expect(run.phase).toBe('forge-init')
    expect(run.round).toBe(1)
    expect(run.max_rounds).toBe(10)
    expect(run.ralph).toBe(false)
    expect(run.max_ralph_rounds).toBe(20)
    expect(run.merge_mode).toBe('local')
    expect(run.pr).toBeNull()
    expect(run.base_sha).toBeNull()
    expect(run.base_behind).toBeNull()
    expect(run.subagent_status).toBeNull()
    expect(run.infra_retries).toBe(0)
    expect(run.brief_alert).toBeNull()
    // #317 — channel_kind defaults to telegram (migration 0081 column default).
    expect(run.channel_kind).toBe('telegram')

    const got = store.get(run.id)
    expect(got).not.toBeNull()
    expect(got?.slug).toBe('fix-reminder-api')
    expect(got?.task).toBe('Run /slfg to fix the reminder API')
    expect(got?.repo_path).toBe('/home/x/repos/neutron')
    expect(got?.started_at).toBe(run.started_at)
    expect(got?.channel_kind).toBe('telegram')
    expect(got?.infra_retries).toBe(0)
  })

  test('brief_alert written by the host checkpoint maps onto the run object', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'brief-alert', project_slug: 't1', repo_path: '/r', task: 't' })
    const alert = 'CODEX_BUILD_BRIEF_PART_CORRUPT: measured bytes disagree. DEFERRED.'
    db.raw().run('UPDATE code_trident_runs SET brief_alert = ? WHERE id = ?', [alert, run.id])

    expect(store.get(run.id)?.brief_alert).toBe(alert)
  })

  test('save() and saveIfActive() preserve a workflow-owned brief_alert against stale snapshots', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'sticky-brief-alert', project_slug: 't1', repo_path: '/r', task: 't' })
    const stale = store.get(run.id)!

    const first = 'CODEX_BUILD_BRIEF_PART_CORRUPT: first durable alert. DEFERRED.'
    db.raw().run('UPDATE code_trident_runs SET brief_alert = ? WHERE id = ?', [first, run.id])
    await store.save(stale)
    expect(store.get(run.id)?.brief_alert).toBe(first)

    const second = 'CODEX_BUILD_BRIEF_PART_CORRUPT: second durable alert. DEFERRED.'
    db.raw().run('UPDATE code_trident_runs SET brief_alert = ? WHERE id = ?', [second, run.id])
    expect(await store.saveIfActive({ ...stale, phase: 'ralph-plan' })).toBe(true)
    expect(store.get(run.id)?.brief_alert).toBe(second)
  })

  test('base pin columns round-trip through update, save, and saveIfActive', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'base-pin', project_slug: 't1', repo_path: '/r', task: 't' })
    const sha = 'b'.repeat(40)
    const updated = await store.update(run.id, { base_sha: sha, base_behind: 16 })
    expect(updated?.base_sha).toBe(sha)
    expect(updated?.base_behind).toBe(16)
    await store.save({ ...updated!, base_behind: 17 })
    expect(store.get(run.id)?.base_behind).toBe(17)
    expect(await store.saveIfActive({ ...store.get(run.id)!, base_behind: 18 })).toBe(true)
    expect(store.get(run.id)?.base_behind).toBe(18)
  })

  test('REVIEW_NOT_RUN round-trips through create, update, save, and get', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'review-not-run',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'build without fabricating a review',
    })
    const updated = await store.update(run.id, {
      phase: 'failed',
      inner_verdict: 'REVIEW_NOT_RUN',
      failure_reason: 'reviewer never produced a verdict',
    })
    await store.save({ ...updated!, failure_reason: 'measured infrastructure stop' })

    const got = store.get(run.id)
    expect(got?.phase).toBe('failed')
    expect(got?.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(got?.failure_reason).toBe('measured infrastructure stop')
  })

  test('the checkpoint OID + findings start NULL and round-trip through update (0122)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'resume-columns',
      project_slug: 't1',
      repo_path: '/r',
      task: 'build the thing',
    })
    // A fresh run has no checkpoint, so it has no commit to be about either.
    expect(run.inner_checkpoint_head).toBeNull()
    expect(run.inner_checkpoint_findings).toBeNull()

    const head = 'a'.repeat(40)
    await store.update(run.id, {
      inner_checkpoint: 'argus-request-changes',
      inner_checkpoint_head: head,
      inner_checkpoint_findings: '[{"severity":"blocker"}]',
    })
    const got = store.get(run.id)
    expect(got?.inner_checkpoint_head).toBe(head)
    expect(got?.inner_checkpoint_findings).toBe('[{"severity":"blocker"}]')
  })

  test('save() leaves the checkpoint OID + findings alone (WORKFLOW-OWNED, like inner_result)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'resume-save', project_slug: 't1', repo_path: '/r', task: 't' })
    const head = 'a'.repeat(40)
    await store.update(run.id, {
      inner_checkpoint: 'argus-request-changes',
      inner_checkpoint_head: head,
      inner_checkpoint_findings: '[{"severity":"blocker"}]',
    })

    // An outer-loop snapshot whose in-memory copy carries stale nulls must not
    // strip the OID off a checkpoint the detached workflow wrote — a name paired
    // with a MISSING (or, worse, a stale) OID is exactly what a resume reads to
    // decide whether prior review work may be trusted.
    const stale = { ...store.get(run.id)!, inner_checkpoint_head: null, inner_checkpoint_findings: null }
    await store.save(stale)

    const got = store.get(run.id)
    expect(got?.inner_checkpoint_head).toBe(head)
    expect(got?.inner_checkpoint_findings).toBe('[{"severity":"blocker"}]')
  })

  test('save() with NON-NULL findings WRITES them — patch-wins, the same rule update() has', async () => {
    // The other direction of the same COALESCE, pinned because it is the one that
    // can lose data (Argus r20, minor): a snapshot carrying findings overwrites
    // whatever the row holds, so a STALE non-null copy would beat fresher findings
    // written out of band by checkpoint.sh. That is deliberate and it matches
    // `update()`'s patch-wins semantics — the caller brought a value, so the value
    // lands — and it is inert today because no production path calls `save()`
    // (`tick.ts` uses `saveIfActive`). Pinning it means a future round that DOES
    // wire `save()` into the loop has to decide this on purpose rather than
    // discover it.
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'save-nonnull', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, {
      inner_checkpoint: 'argus-request-changes',
      inner_checkpoint_findings: '[{"severity":"blocker","title":"the row already says this"}]',
    })

    const snapshot = {
      ...store.get(run.id)!,
      inner_checkpoint_findings: '[{"severity":"major","title":"and the snapshot says this"}]',
    }
    await store.save(snapshot)

    expect(store.get(run.id)?.inner_checkpoint_findings).toBe(
      '[{"severity":"major","title":"and the snapshot says this"}]',
    )
  })

  test('#317 create persists a non-telegram originating channel_kind', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'app-ws-build',
      project_slug: 't1',
      repo_path: '/r',
      task: 'build from the app',
      chat_id: 'web:u1',
      channel_kind: 'app_socket',
    })
    expect(run.channel_kind).toBe('app_socket')
    expect(store.get(run.id)?.channel_kind).toBe('app_socket')
  })

  test('#317 CHECK rejects an invalid channel_kind', async () => {
    const store = new TridentRunStore(db)
    await expect(
      store.create({
        slug: 'bad-ch',
        project_slug: 't1',
        repo_path: '/r',
        task: 't',
        // @ts-expect-error — exercising the DB CHECK with an out-of-enum value
        channel_kind: 'carrier-pigeon',
      }),
    ).rejects.toThrow()
  })

  test('create honours overrides (ralph, merge_mode, caps, routing)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'big-spec-build',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'build the whole spec',
      ralph: true,
      merge_mode: 'pr',
      max_rounds: 12,
      max_ralph_rounds: 30,
      branch: 'feature-x',
      worktree: '/wt/feature-x',
      chat_id: '-100',
      thread_id: '42',
    })
    const got = store.get(run.id)
    expect(got?.ralph).toBe(true)
    expect(got?.merge_mode).toBe('pr')
    expect(got?.max_rounds).toBe(12)
    expect(got?.max_ralph_rounds).toBe(30)
    expect(got?.branch).toBe('feature-x')
    expect(got?.worktree).toBe('/wt/feature-x')
    expect(got?.chat_id).toBe('-100')
    expect(got?.thread_id).toBe('42')
  })

  test('getBySlug is project-scoped + unique', async () => {
    const store = new TridentRunStore(db)
    await store.create({ slug: 'dup', project_slug: 't1', repo_path: '/r', task: 'a' })
    const found = store.getBySlug('t1', 'dup')
    expect(found?.slug).toBe('dup')
    expect(store.getBySlug('t2', 'dup')).toBeNull()
    // unique (project_slug, slug)
    await expect(
      store.create({ slug: 'dup', project_slug: 't1', repo_path: '/r', task: 'b' }),
    ).rejects.toThrow()
  })

  /**
   * SALVAGE-RESUME SEED (the built-but-never-reviewed card). `getBySlug` is
   * uniqueness-scoped to LIVE rows, so the dispatch chokepoint had no way to ask
   * "what happened the last time this card ran". These pins are what let it ask,
   * and what let the answer be carried onto the fresh row.
   */
  test('latestTerminalBySlug returns the NEWEST terminal row, ignoring the live one', async () => {
    let tick = 0
    const store = new TridentRunStore(
      db,
      () => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++)).toISOString(),
    )
    const first = await store.create({ slug: 'card-a', project_slug: 't1', repo_path: '/r', task: 'a' })
    await store.update(first.id, { phase: 'failed', inner_checkpoint: 'inner-error' })
    const second = await store.create({ slug: 'card-a', project_slug: 't1', repo_path: '/r', task: 'a' })
    await store.update(second.id, { phase: 'stopped', inner_checkpoint: 'forge-done' })
    // A LIVE row for the same card must never be mistaken for the prior attempt.
    const live = await store.create({ slug: 'card-a', project_slug: 't1', repo_path: '/r', task: 'a' })

    const latest = store.latestTerminalBySlug('t1', 'card-a')
    expect(latest?.id).toBe(second.id)
    expect(latest?.inner_checkpoint).toBe('forge-done')
    expect(latest?.id).not.toBe(live.id)
    // Project-scoped, exactly like getBySlug.
    expect(store.latestTerminalBySlug('t2', 'card-a')).toBeNull()
  })

  test('latestTerminalBySlug is null when the card has only ever had live rows', async () => {
    const store = new TridentRunStore(db)
    await store.create({ slug: 'card-b', project_slug: 't1', repo_path: '/r', task: 'b' })
    expect(store.latestTerminalBySlug('t1', 'card-b')).toBeNull()
    expect(store.latestTerminalBySlug('t1', 'never-existed')).toBeNull()
  })

  test('create round-trips the salvage-resume seed, and defaults all four to NULL', async () => {
    const store = new TridentRunStore(db)
    const HEAD = 'a'.repeat(40)
    const BASE = 'c'.repeat(40)
    const seeded = await store.create({
      slug: 'seeded',
      project_slug: 't1',
      repo_path: '/r',
      task: 't',
      inner_checkpoint: 'forge-done',
      inner_checkpoint_head: HEAD,
      inner_checkpoint_findings: '[{"title":"suite"}]',
      base_sha: BASE,
    })
    const stored = store.get(seeded.id)!
    expect(stored.inner_checkpoint).toBe('forge-done')
    expect(stored.inner_checkpoint_head).toBe(HEAD)
    expect(stored.inner_checkpoint_findings).toBe('[{"title":"suite"}]')
    // PERSISTED, not just returned: `base_sha` used to backfill through the column
    // default and was excluded from the INSERT, so a seeded pin was silently lost —
    // and with it the publish-time "not cut from origin/<base>" refusal, which is
    // gated on `base_sha !== null` and can never re-pin a non-fresh launch.
    expect(stored.base_sha).toBe(BASE)
    // A seeded row is NOT a reviewed row: no verdict travels with the evidence.
    expect(stored.inner_verdict).toBeNull()
    // …and no PR: `launch()` resolves it with `run.pr ?? detectExistingPr(run)`, so
    // a seeded number would short-circuit that probe onto a maybe-closed PR.
    expect(stored.pr).toBeNull()

    const plain = await store.create({ slug: 'plain', project_slug: 't1', repo_path: '/r', task: 't' })
    const plainStored = store.get(plain.id)!
    expect(plainStored.inner_checkpoint).toBeNull()
    expect(plainStored.inner_checkpoint_head).toBeNull()
    expect(plainStored.inner_checkpoint_findings).toBeNull()
    expect(plainStored.base_sha).toBeNull()
    expect(plainStored.pr).toBeNull()
  })

  // THE SEED DOMAIN IS A WRITE-SITE PRECONDITION, NOT A CALLER'S HABIT (Argus r23,
  // major). `create` persisted whatever `inner_checkpoint` it was handed while the
  // only thing that decided which names are safe lived in `builtButNeverReviewedSeed`
  // — the "check only in the caller" shape this card explicitly forbids. A row born
  // at `argus-approved` resumes as an already-approved run and writes a terminal
  // APPROVE having reviewed nothing, so the column's domain is enforced where the
  // column is written.
  test.each([
    'argus-approved',
    'argus-request-changes',
    'argus-request-changes-round-7',
    'pr-merged',
    'inner-error',
    'ralph-task-built',
    'awaiting-trailer',
    'who-knows',
    // Out of the round domain both round parsers accept, so no reader would call it
    // resumable either.
    'fix-round-1000000000',
    'fix-round-x',
    `outer-published:${'z'.repeat(40)}:1:2`,
  ])('create REFUSES a row seeded at %p', async (checkpoint) => {
    const store = new TridentRunStore(db)
    await expect(
      store.create({
        slug: 'refused',
        project_slug: 't1',
        repo_path: '/r',
        task: 't',
        inner_checkpoint: checkpoint,
        inner_checkpoint_head: 'a'.repeat(40),
        base_sha: 'c'.repeat(40),
      }),
    ).rejects.toThrow(TridentUnresumableSeedError)
    // AND THE ROW IS NOT THERE. A refusal that still inserted would be worse than
    // no check at all — the resume would run off a row nobody thinks exists.
    expect(store.latestTerminalBySlug('t1', 'refused')).toBeNull()
    expect(store.getBySlug('t1', 'refused')).toBeNull()
    expect(store.listNonTerminal().filter((r) => r.slug === 'refused')).toHaveLength(0)
  })

  // POSITIVE CONTROL: the three names a real salvage emits still create, and the
  // fresh (unseeded) shape is untouched. Without this, a `create` that threw for
  // every seed would satisfy the refusals above.
  test.each(['forge-done', 'fix-round-3', `outer-published:${'a'.repeat(40)}:2:6:deviated`, ' forge-done '])(
    'create ACCEPTS a row seeded at %p',
    async (checkpoint) => {
      const store = new TridentRunStore(db)
      const run = await store.create({
        slug: 'accepted',
        project_slug: 't1',
        repo_path: '/r',
        task: 't',
        inner_checkpoint: checkpoint,
        inner_checkpoint_head: 'a'.repeat(40),
        base_sha: 'c'.repeat(40),
      })
      // THE STORED VALUE IS THE ONE THAT WAS GUARDED (Argus r24, minor). It used to
      // be the RAW argument, so `' forge-done '` passed a guard reading the trimmed
      // name and then reached `classifyResume`, which compares exact names — a row
      // admitted as resumable and then rebuilt as unrecognised. The column now holds
      // what the check decided on.
      expect(store.get(run.id)?.inner_checkpoint).toBe(checkpoint.trim())
    },
  )

  // A SEEDED NAME IS ONLY HALF A SEED (Argus r24, major). The name guard above
  // answered "this checkpoint means a commit exists and nothing judged it", then let
  // the two columns saying WHICH commit through unchecked. Both gaps are permanent
  // once written: `launch()` re-pins a base only on a FRESH build, so a seeded row
  // born with a null `base_sha` can never acquire one and the publish-time
  // cut-from-origin refusal (gated on `base_sha !== null`) is disarmed for it
  // forever; and a seed with no 40-hex head cannot be revalidated against the live
  // tip, which is what arms the leftover-branch ownership check.
  test.each([
    ['base_sha', { inner_checkpoint_head: 'a'.repeat(40), base_sha: null }],
    ['base_sha omitted', { inner_checkpoint_head: 'a'.repeat(40) }],
    ['base_sha short', { inner_checkpoint_head: 'a'.repeat(40), base_sha: 'c'.repeat(39) }],
    ['base_sha not hex', { inner_checkpoint_head: 'a'.repeat(40), base_sha: 'z'.repeat(40) }],
    ['head null', { inner_checkpoint_head: null, base_sha: 'c'.repeat(40) }],
    ['head omitted', { base_sha: 'c'.repeat(40) }],
    ['head short', { inner_checkpoint_head: 'a'.repeat(39), base_sha: 'c'.repeat(40) }],
    ['head not hex', { inner_checkpoint_head: 'q'.repeat(40), base_sha: 'c'.repeat(40) }],
  ])('create REFUSES a forge-done seed with %s', async (_label, pins) => {
    const store = new TridentRunStore(db)
    await expect(
      store.create({
        slug: 'halfseed',
        project_slug: 't1',
        repo_path: '/r',
        task: 't',
        inner_checkpoint: 'forge-done',
        ...pins,
      }),
    ).rejects.toThrow(TridentIncompleteSeedError)
    // Refused means ABSENT, not inserted-then-complained-about.
    expect(store.getBySlug('t1', 'halfseed')).toBeNull()
    expect(store.listNonTerminal().filter((r) => r.slug === 'halfseed')).toHaveLength(0)
  })

  // POSITIVE CONTROLS for the pin guard, so a `create` that threw on every seed
  // could not satisfy the refusals above: a complete seed still lands, an UNSEEDED
  // row is still allowed to carry no pins at all, and the pins are stored in the
  // normalised form the guard read.
  test('a complete seed still lands, and its pins are stored as the guard read them', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'complete',
      project_slug: 't1',
      repo_path: '/r',
      task: 't',
      inner_checkpoint: 'fix-round-2',
      inner_checkpoint_head: ` ${'A'.repeat(40)} `,
      base_sha: `${'B'.repeat(40)}\n`,
    })
    const stored = store.get(run.id)!
    expect(stored.inner_checkpoint).toBe('fix-round-2')
    expect(stored.inner_checkpoint_head).toBe('a'.repeat(40))
    expect(stored.base_sha).toBe('b'.repeat(40))
  })

  test('an UNSEEDED row is untouched by the pin guard', async () => {
    // The fresh-dispatch shape carries no checkpoint and no pins, and `launch()`
    // pins the base itself. Demanding a pin here would refuse every real dispatch.
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'fresh', project_slug: 't1', repo_path: '/r', task: 't' })
    const stored = store.get(run.id)!
    expect(stored.inner_checkpoint).toBeNull()
    expect(stored.inner_checkpoint_head).toBeNull()
    expect(stored.base_sha).toBeNull()
  })

  test('the refusal is on CREATE only — `update` still records any checkpoint the loop reaches', async () => {
    // The live state machine writes `building`, `reviewing`, `inner-error`,
    // `argus-approved` … through `update`, and those are the row saying where it
    // IS, not a seed promising a resume. Narrowing them would blind the loop.
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'live', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, { inner_checkpoint: 'argus-approved' })
    expect(store.get(run.id)?.inner_checkpoint).toBe('argus-approved')
  })

  test('update applies a partial patch + re-stamps last_advanced_at', async () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const store = new TridentRunStore(db, () => clock)
    const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    expect(run.last_advanced_at).toBe('2026-01-01T00:00:00.000Z')

    clock = '2026-01-01T00:05:00.000Z'
    const updated = await store.update(run.id, {
      phase: 'argus',
      pr: 42,
      branch: 'feat',
      subagent_run_id: 'argus-1',
      subagent_status: 'running',
    })
    expect(updated?.phase).toBe('argus')
    expect(updated?.pr).toBe(42)
    expect(updated?.branch).toBe('feat')
    expect(updated?.subagent_run_id).toBe('argus-1')
    expect(updated?.subagent_status).toBe('running')
    expect(updated?.last_advanced_at).toBe('2026-01-01T00:05:00.000Z')
    // untouched columns survive
    expect(updated?.task).toBe('t')
    expect(updated?.round).toBe(1)
  })

  test('save persists a full run snapshot', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.save({
      ...run,
      phase: 'forge-fix',
      round: 3,
      pr: 7,
      branch: 'b',
      subagent_status: 'completed',
      failure_reason: null,
    })
    const got = store.get(run.id)
    expect(got?.phase).toBe('forge-fix')
    expect(got?.round).toBe(3)
    expect(got?.pr).toBe(7)
  })

  test('listNonTerminal excludes done/failed/stopped, oldest-advanced first', async () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const store = new TridentRunStore(db, () => clock)
    const a = await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    clock = '2026-01-01T00:01:00.000Z'
    const b = await store.create({ slug: 'b', project_slug: 't1', repo_path: '/r', task: 't' })
    clock = '2026-01-01T00:02:00.000Z'
    const c = await store.create({ slug: 'c', project_slug: 't1', repo_path: '/r', task: 't' })

    // Move two into terminal states.
    await store.save({ ...a, phase: 'done' })
    await store.save({ ...b, phase: 'failed', failure_reason: 'boom' })

    const active = store.listNonTerminal()
    expect(active.map((r) => r.slug)).toEqual(['c'])

    // A 'stopped' run is also excluded.
    await store.save({ ...c, phase: 'stopped' })
    expect(store.listNonTerminal()).toEqual([])
  })

  test('listFailedPrRuns filters exactly, orders newest first, and respects the limit', async () => {
    let clock = '2026-08-17T00:00:00.000Z'
    const store = new TridentRunStore(db, () => clock)
    await store.create({
      slug: 'failed-pr-old', project_slug: 't1', repo_path: '/r', task: 't', phase: 'failed', merge_mode: 'pr',
    })
    clock = '2026-08-17T00:01:00.000Z'
    await store.create({
      slug: 'failed-local', project_slug: 't1', repo_path: '/r', task: 't', phase: 'failed', merge_mode: 'local',
    })
    clock = '2026-08-17T00:02:00.000Z'
    await store.create({
      slug: 'done-pr', project_slug: 't1', repo_path: '/r', task: 't', phase: 'done', merge_mode: 'pr',
    })
    clock = '2026-08-17T00:03:00.000Z'
    await store.create({
      slug: 'failed-pr-new', project_slug: 't1', repo_path: '/r', task: 't', phase: 'failed', merge_mode: 'pr',
    })

    expect(store.listFailedPrRuns().map((run) => run.slug)).toEqual([
      'failed-pr-new',
      'failed-pr-old',
    ])
    expect(store.listFailedPrRuns(1).map((run) => run.slug)).toEqual(['failed-pr-new'])
  })

  test('latestByProjectScope returns the most-recently-advanced run, scoped', async () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const store = new TridentRunStore(db, () => clock)
    // No run for a scope → null.
    expect(store.latestByProjectScope('t1')).toBeNull()

    const a = await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    clock = '2026-01-01T00:01:00.000Z'
    const b = await store.create({ slug: 'b', project_slug: 't1', repo_path: '/r', task: 't' })
    // A DIFFERENT scope's run must not leak in.
    await store.create({ slug: 'x', project_slug: 't2', repo_path: '/r', task: 't' })

    // b is newest for t1.
    expect(store.latestByProjectScope('t1')?.id).toBe(b.id)

    // Re-advancing a (a failed terminal) makes it the latest — the durable
    // failure signal the rail reads.
    clock = '2026-01-01T00:05:00.000Z'
    await store.save({ ...a, phase: 'failed', failure_reason: 'boom' })
    const latest = store.latestByProjectScope('t1')
    expect(latest?.id).toBe(a.id)
    expect(latest?.phase).toBe('failed')

    // Scope isolation holds.
    expect(store.latestByProjectScope('t2')?.slug).toBe('x')
    expect(store.latestByProjectScope('nope')).toBeNull()
  })

  test('delete removes a run', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.delete(run.id)
    expect(store.get(run.id)).toBeNull()
  })

  test('CHECK rejects an invalid phase', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    await expect(
      db.run(`UPDATE code_trident_runs SET phase = ? WHERE id = ?`, ['bogus', run.id]),
    ).rejects.toThrow()
  })

  test('crash marker beats a stale running tick, then permits the crash-to-failed save (#514)', async () => {
    const store = new TridentRunStore(db)
    const created = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(created.id, {
      subagent_status: 'running',
      subagent_run_id: 'wf-1',
      workflow_run_id: 'launcher-a',
    })
    const staleTickSnapshot = store.get(created.id)!

    await store.crashRunningByLauncher('launcher-a', 'pooled child exited')
    // Mutation killed: removing the subagent_status guard lets this stale full
    // snapshot overwrite `crashed` back to `running`.
    expect(await store.saveIfActive(staleTickSnapshot)).toBe(false)
    expect(store.get(created.id)?.subagent_status).toBe('crashed')

    const crashSnapshot = store.get(created.id)!
    expect(await store.saveIfActive({ ...crashSnapshot, phase: 'failed' })).toBe(true)
    expect(store.get(created.id)?.phase).toBe('failed')
  })

  test('one stale launcher key cannot crash a healthy rotated-key run (#514)', async () => {
    const store = new TridentRunStore(db)
    const stale = await store.create({ slug: 'stale', project_slug: 't1', repo_path: '/same', task: 'old' })
    const healthy = await store.create({ slug: 'healthy', project_slug: 't1', repo_path: '/same', task: 'new' })
    await store.update(stale.id, { subagent_status: 'running', workflow_run_id: 'credential-a-key' })
    await store.update(healthy.id, { subagent_status: 'running', workflow_run_id: 'credential-b-key' })

    await store.crashRunningByLauncher('credential-a-key', 'old child exited')

    // Mutation killed: replacing launcher-key ownership with repo_path marks
    // both rows crashed and destroys the healthy rotated-key workflow.
    expect(store.get(stale.id)?.subagent_status).toBe('crashed')
    expect(store.get(healthy.id)?.subagent_status).toBe('running')
  })

  test('a crashed child generation does not poison the next generation in the same pool slot (#514)', async () => {
    const store = new TridentRunStore(db)
    await store.crashRunningByLauncher('pool-generation-1', 'old child exited')
    const fresh = await store.create({ slug: 'fresh', project_slug: 't1', repo_path: '/same', task: 'new' })
    const freshSnapshot = {
      ...fresh,
      subagent_status: 'running' as const,
      workflow_run_id: 'pool-generation-2',
    }

    // Mutation killed: using the stable pool key for both incarnations makes
    // this save lose forever and re-fire a new detached workflow every tick.
    expect(await store.saveIfActive(freshSnapshot)).toBe(true)
    expect(store.get(fresh.id)?.subagent_status).toBe('running')
  })

  test('update cannot resurrect a row after the crash sink wins (#514)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'update-race', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, { subagent_status: 'running', workflow_run_id: 'generation-a' })
    await store.crashRunningByLauncher('generation-a', 'child exited')

    // Mutation killed: removing update's crashed-state predicate lets an
    // out-of-band partial writer resurrect the phantom running row.
    await store.update(run.id, { subagent_status: 'running' })
    expect(store.get(run.id)?.subagent_status).toBe('crashed')
  })

  test('a crash committed before launch persistence vetoes the racing running snapshot (#514)', async () => {
    const store = new TridentRunStore(db)
    const created = await store.create({ slug: 'race', project_slug: 't1', repo_path: '/r', task: 't' })
    const firedSnapshot = {
      ...created,
      subagent_status: 'running' as const,
      subagent_run_id: 'wf-race',
      workflow_run_id: 'dead-before-save',
    }

    await store.crashRunningByLauncher('dead-before-save', 'child exited before tick save')

    // Mutation killed: deleting the launcher-crash NOT EXISTS predicate lets
    // the detached workflow persist as running after its owning child died.
    expect(await store.saveIfActive(firedSnapshot)).toBe(false)
    expect(store.get(created.id)?.subagent_status).toBe('crashed')
    expect(store.get(created.id)?.failure_reason).toBe('child exited before tick save')
  })

  describe('beginCrashRecovery — the atomic claim that recovers a killed launcher', () => {
    test('claims a crashed run: latch cleared, slot + dead generation released, budget spent', async () => {
      let clock = '2026-08-14T07:13:00.000Z'
      const store = new TridentRunStore(db, () => clock)
      const run = await store.create({ slug: 'claim', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.update(run.id, {
        subagent_status: 'running', subagent_run_id: 'wf-1', workflow_run_id: 'gen-dead',
      })
      await store.crashRunningByLauncher('gen-dead', 'pooled child exited')
      clock = '2026-08-14T07:14:32.000Z'

      const claimed = await store.beginCrashRecovery(run.id)

      expect(claimed).not.toBeNull()
      expect(claimed?.subagent_status).toBeNull()
      expect(claimed?.subagent_run_id).toBeNull()
      // Nulled so `launch()`'s `?? workflow_run_id` fallback cannot re-adopt a
      // generation that already carries a durable crash tombstone.
      expect(claimed?.workflow_run_id).toBeNull()
      expect(claimed?.crash_recoveries).toBe(1)
      expect(claimed?.last_advanced_at).toBe('2026-08-14T07:14:32.000Z')
    })

    test('a post-claim `running` save with a FRESH generation LANDS — the veto no longer blocks', async () => {
      // The whole point of clearing the latch out-of-band: with it still set,
      // `saveIfActive` vetoes every non-crashed write and the relaunch could never
      // persist. Mutation killed: drop `subagent_status = NULL` from the claim.
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 'relaunch', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.update(run.id, { subagent_status: 'running', workflow_run_id: 'gen-dead' })
      await store.crashRunningByLauncher('gen-dead', 'pooled child exited')
      const claimed = (await store.beginCrashRecovery(run.id))!

      const landed = await store.saveIfActive({
        ...claimed, subagent_status: 'running', subagent_run_id: 'wf-2', workflow_run_id: 'gen-fresh',
      })

      expect(landed).toBe(true)
      expect(store.get(run.id)?.subagent_status).toBe('running')
    })

    test('the claim LOSES on a terminal row and on a non-crashed row — no budget spent', async () => {
      const store = new TridentRunStore(db)
      // Terminal: a build cancelled between the crash latch and this tick.
      const dead = await store.create({ slug: 'dead', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.update(dead.id, { subagent_status: 'running', workflow_run_id: 'gen-a' })
      await store.crashRunningByLauncher('gen-a', 'pooled child exited')
      await store.terminalTransition(dead.id, { phase: 'stopped' })
      expect(await store.beginCrashRecovery(dead.id)).toBeNull()
      expect(store.get(dead.id)?.crash_recoveries).toBe(0)
      expect(store.get(dead.id)?.phase).toBe('stopped')

      // Not crashed: a healthy in-flight run must never be reset by a stray claim
      // (and a second tick racing the first loses cleanly, for the same reason).
      const live = await store.create({ slug: 'live', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.update(live.id, { subagent_status: 'running', workflow_run_id: 'gen-b' })
      expect(await store.beginCrashRecovery(live.id)).toBeNull()
      expect(store.get(live.id)?.crash_recoveries).toBe(0)
      expect(store.get(live.id)?.subagent_status).toBe('running')
      expect(store.get(live.id)?.workflow_run_id).toBe('gen-b')

      // A vanished row is not a claim either.
      expect(await store.beginCrashRecovery('no-such-run')).toBeNull()
    })
  })

  describe('beginInfraRetry — the single-writer executor/transport retry claim', () => {
    test('increments durably and clears result + every dispatch slot in one claim', async () => {
      let clock = '2026-08-14T20:10:00.000Z'
      const store = new TridentRunStore(db, () => clock)
      const run = await store.create({ slug: 'infra-claim', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.update(run.id, {
        subagent_run_id: 'wf-1',
        subagent_status: 'completed',
        workflow_run_id: 'generation-1',
        inner_result: '{"verdict":"REQUEST_CHANGES"}',
      })
      await db.run(
        'UPDATE code_trident_runs SET inner_verdict = ? WHERE id = ?',
        ['REQUEST_CHANGES', run.id],
      )
      clock = '2026-08-14T20:11:00.000Z'

      const claimed = await store.beginInfraRetry(run.id)

      expect(claimed).toMatchObject({
        infra_retries: 1,
        inner_result: null,
        inner_verdict: null,
        subagent_run_id: null,
        subagent_status: null,
        workflow_run_id: null,
        last_advanced_at: clock,
      })
      expect(claimed?.round).toBe(1)
      expect(claimed?.ralph_round).toBe(0)
      expect(claimed?.harvested_at).toBeNull()
    })

    test('legacy NULL reads as zero and update() cannot write the owned counter', async () => {
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 'infra-owned', project_slug: 't1', repo_path: '/r', task: 't' })
      await db.run(`UPDATE code_trident_runs SET infra_retries = NULL WHERE id = ?`, [run.id])
      expect(store.get(run.id)?.infra_retries).toBe(0)

      await store.update(run.id, {
        // @ts-expect-error — the durable retry budget is deliberately not patchable.
        infra_retries: 99,
      })
      expect(store.get(run.id)?.infra_retries).toBe(0)
    })
  })

  describe('terminalTransition — atomic conditional terminal write (§F6a race guard)', () => {
    test('wins on a non-terminal run: flips the phase + reason and reports won', async () => {
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
      const res = await store.terminalTransition(run.id, { phase: 'stopped', failure_reason: 'user cancel' })
      expect(res.won).toBe(true)
      expect(res.run?.phase).toBe('stopped')
      expect(res.run?.failure_reason).toBe('user cancel')
      expect(store.get(run.id)?.phase).toBe('stopped')
    })

    test('LOSES against an already-terminal run: no clobber, no phantom win', async () => {
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
      // Simulate the tick loop persisting a real `done` result + delivery.
      await store.save({ ...run, phase: 'done' })
      // A racing board delete tries to cancel the SAME run.
      const res = await store.terminalTransition(run.id, { phase: 'stopped', failure_reason: 'user cancel' })
      // The SQL `AND phase NOT IN (terminal)` predicate matched no row.
      expect(res.won).toBe(false)
      // The real result stands — NOT overwritten to `stopped`, reason untouched.
      expect(res.run?.phase).toBe('done')
      expect(res.run?.failure_reason).toBeNull()
      expect(store.get(run.id)?.phase).toBe('done')
    })

    test('two concurrent transitions on one run: exactly one wins', async () => {
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
      const [a, b] = await Promise.all([
        store.terminalTransition(run.id, { phase: 'stopped' }),
        store.terminalTransition(run.id, { phase: 'failed' }),
      ])
      expect([a.won, b.won].filter(Boolean).length).toBe(1)
      // The row is terminal at whichever phase the winner wrote (never a mix).
      const finalPhase = store.get(run.id)?.phase
      expect(finalPhase === 'stopped' || finalPhase === 'failed').toBe(true)
    })

    test('missing run → run null, not won', async () => {
      const store = new TridentRunStore(db)
      const res = await store.terminalTransition('does-not-exist', { phase: 'stopped' })
      expect(res.run).toBeNull()
      expect(res.won).toBe(false)
    })
  })
})

describe('wave children (migration 0137)', () => {
  test('ordinary rows default both wave-child fields to null', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'ordinary', project_slug: 't1', repo_path: '/r', task: 't',
    })

    expect(store.get(run.id)).toMatchObject({ parent_run_id: null, wave_task_id: null })
  })

  test('a wave child round-trips its parent and task identity', async () => {
    const store = new TridentRunStore(db)
    const parent = await store.create({
      slug: 'wave-parent', project_slug: 't1', repo_path: '/r', task: 'parent',
    })
    const child = await store.create({
      slug: waveChildSlug(parent.slug, 'T3'),
      project_slug: parent.project_slug,
      repo_path: '/r',
      task: 'child',
      parent_run_id: parent.id,
      wave_task_id: 'T3',
    })

    expect(store.get(child.id)).toMatchObject({ parent_run_id: parent.id, wave_task_id: 'T3' })
    expect(store.get(child.id)).toEqual(child)
  })

  test('create refuses a half-declared or empty wave-child pair', async () => {
    const store = new TridentRunStore(db)
    const parent = await store.create({
      slug: 'pair-parent', project_slug: 't1', repo_path: '/r', task: 'parent',
    })
    const base = { project_slug: 't1', repo_path: '/r', task: 'child' }

    await expect(
      store.create({ ...base, slug: 'parent-only', parent_run_id: parent.id }),
    ).rejects.toThrow(/BOTH/)
    await expect(
      store.create({ ...base, slug: 'task-only', wave_task_id: 'T3' }),
    ).rejects.toThrow(/BOTH/)
    await expect(
      store.create({ ...base, slug: 'empty-parent', parent_run_id: '', wave_task_id: 'T3' }),
    ).rejects.toThrow(/BOTH/)
  })

  test('wave spawn is idempotent per parent and task', async () => {
    const store = new TridentRunStore(db)
    const parentA = await store.create({
      slug: 'spawn-parent-a', project_slug: 't1', repo_path: '/r', task: 'parent A',
    })
    const parentB = await store.create({
      slug: 'spawn-parent-b', project_slug: 't1', repo_path: '/r', task: 'parent B',
    })
    await store.create({
      id: 'spawn-a-t3-1', slug: 'spawn-a-t3-1', project_slug: 't1', repo_path: '/r', task: 'T3',
      parent_run_id: parentA.id, wave_task_id: 'T3',
    })

    await expect(store.create({
      id: 'spawn-a-t3-2', slug: 'spawn-a-t3-2', project_slug: 't1', repo_path: '/r', task: 'T3 retry',
      parent_run_id: parentA.id, wave_task_id: 'T3',
    })).rejects.toThrow(/UNIQUE/)
    await expect(store.create({
      slug: 'spawn-a-t4', project_slug: 't1', repo_path: '/r', task: 'T4',
      parent_run_id: parentA.id, wave_task_id: 'T4',
    })).resolves.toMatchObject({ parent_run_id: parentA.id, wave_task_id: 'T4' })
    await expect(store.create({
      slug: 'spawn-b-t3', project_slug: 't1', repo_path: '/r', task: 'T3',
      parent_run_id: parentB.id, wave_task_id: 'T3',
    })).resolves.toMatchObject({ parent_run_id: parentB.id, wave_task_id: 'T3' })
  })

  test('ordinary rows stay out of the wave-child unique index', async () => {
    const store = new TridentRunStore(db)

    await expect(store.create({
      slug: 'plain-one', project_slug: 't1', repo_path: '/r', task: 'one',
    })).resolves.toMatchObject({ parent_run_id: null, wave_task_id: null })
    await expect(store.create({
      slug: 'plain-two', project_slug: 't1', repo_path: '/r', task: 'two',
    })).resolves.toMatchObject({ parent_run_id: null, wave_task_id: null })
  })

  test('listChildren returns only one parent\'s members in spawn order', async () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const store = new TridentRunStore(db, () => clock)
    const parentA = await store.create({
      slug: 'list-parent-a', project_slug: 't1', repo_path: '/r', task: 'parent A',
    })
    const parentB = await store.create({
      slug: 'list-parent-b', project_slug: 't1', repo_path: '/r', task: 'parent B',
    })
    clock = '2026-01-01T00:01:00.000Z'
    const aT2 = await store.create({
      slug: 'list-a-t2', project_slug: 't1', repo_path: '/r', task: 'T2',
      parent_run_id: parentA.id, wave_task_id: 'T2',
    })
    clock = '2026-01-01T00:02:00.000Z'
    const aT3 = await store.create({
      slug: 'list-a-t3', project_slug: 't1', repo_path: '/r', task: 'T3',
      parent_run_id: parentA.id, wave_task_id: 'T3',
    })
    clock = '2026-01-01T00:03:00.000Z'
    await store.create({
      slug: 'list-b-t2', project_slug: 't1', repo_path: '/r', task: 'T2',
      parent_run_id: parentB.id, wave_task_id: 'T2',
    })

    expect(store.listChildren(parentA.id).map((run) => run.id)).toEqual([aT2.id, aT3.id])
    expect(store.listChildren(parentA.id).some((run) => run.id === parentA.id)).toBe(false)
    expect(store.listChildren('missing')).toEqual([])
  })

  test('latestByProjectScope ignores later and failed wave members', async () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const store = new TridentRunStore(db, () => clock)
    const parent = await store.create({
      slug: 'latest-parent', project_slug: 't1', repo_path: '/r', task: 'parent',
    })
    clock = '2026-01-01T00:01:00.000Z'
    const child = await store.create({
      slug: 'latest-child', project_slug: 't1', repo_path: '/r', task: 'child',
      parent_run_id: parent.id, wave_task_id: 'T3',
    })
    clock = '2026-01-01T00:02:00.000Z'
    await store.update(child.id, {})

    expect(store.latestByProjectScope('t1')?.id).toBe(parent.id)
    clock = '2026-01-01T00:03:00.000Z'
    await store.update(child.id, { phase: 'failed' })
    expect(store.latestByProjectScope('t1')?.id).toBe(parent.id)
  })

  test('a child needs its deterministic suffix to avoid its live parent slug', async () => {
    const store = new TridentRunStore(db)
    const parent = await store.create({
      slug: 'collision-parent', project_slug: 't1', repo_path: '/r', task: 'parent',
    })

    await expect(store.create({
      slug: parent.slug, project_slug: 't1', repo_path: '/r', task: 'child',
      parent_run_id: parent.id, wave_task_id: 'T3',
    })).rejects.toThrow(/UNIQUE/)
    await expect(store.create({
      slug: waveChildSlug(parent.slug, 'T3'), project_slug: 't1', repo_path: '/r', task: 'child',
      parent_run_id: parent.id, wave_task_id: 'T3',
    })).resolves.toMatchObject({ slug: 'collision-parent--wT3' })
  })

  test('waveChildSlug identifies the parent and task', () => {
    expect(waveChildSlug('a-slug', 'T12')).toBe('a-slug--wT12')
  })
})

describe('empty-findings rejection guard — an empty finding set is never a rejection', () => {
  test('FALSIFICATION 2 — update() refuses REQUEST_CHANGES on a row with no findings (delete the guard in update() and this goes RED)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-update-empty', project_slug: 't1', repo_path: '/r', task: 't' })

    await expect(
      store.update(run.id, { inner_verdict: 'REQUEST_CHANGES' }),
    ).rejects.toThrow(TridentEmptyFindingsRejectionError)

    expect(store.get(run.id)?.inner_verdict).toBeNull()
  })

  test('update() refuses REQUEST_CHANGES paired with findings=[] and with unparseable findings in the same patch', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-update-invalid', project_slug: 't1', repo_path: '/r', task: 't' })

    await expect(
      store.update(run.id, {
        inner_verdict: 'REQUEST_CHANGES',
        inner_checkpoint_findings: '[]',
      }),
    ).rejects.toThrow(TridentEmptyFindingsRejectionError)
    await expect(
      store.update(run.id, {
        inner_verdict: 'REQUEST_CHANGES',
        inner_checkpoint_findings: 'not json',
      }),
    ).rejects.toThrow(TridentEmptyFindingsRejectionError)
  })

  test('update() refuses REQUEST_CHANGES whose findings nest DEEPER THAN SQLITE ACCEPTS', async () => {
    // json_valid enforces JSON_MAX_DEPTH (1000), so checkpoint.sh's CASE records
    // REVIEW_NOT_RUN for this and the counting SQL scores it legacy. JSON.parse
    // reads it as a 1-element array, so without the parser's explicit bound this
    // write site alone called it a real rejection (Argus r7, reproduced).
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-update-deep', project_slug: 't1', repo_path: '/r', task: 't' })

    await expect(
      store.update(run.id, {
        inner_verdict: 'REQUEST_CHANGES',
        inner_checkpoint_findings: '['.repeat(1001) + '0' + ']'.repeat(1001),
      }),
    ).rejects.toThrow(TridentEmptyFindingsRejectionError)

    expect(store.get(run.id)?.inner_verdict).toBeNull()
  })

  test('POSITIVE CONTROL: findings nested exactly 1000 deep are ACCEPTED and stored verbatim', async () => {
    // The boundary is >1000, not >=1000 — both dialects call this one real, so
    // the refusal above is a bound and not a blanket rejection of deep content.
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-update-deep-ok', project_slug: 't1', repo_path: '/r', task: 't' })
    const findings = '['.repeat(1000) + '0' + ']'.repeat(1000)

    await store.update(run.id, { inner_verdict: 'REQUEST_CHANGES', inner_checkpoint_findings: findings })

    expect(store.get(run.id)).toMatchObject({
      inner_verdict: 'REQUEST_CHANGES',
      inner_checkpoint_findings: findings,
    })
  })

  test('update() accepts REQUEST_CHANGES with non-empty findings in the same patch', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-update-paired', project_slug: 't1', repo_path: '/r', task: 't' })
    const findings = '[{"severity":"blocker"}]'

    await store.update(run.id, {
      inner_verdict: 'REQUEST_CHANGES',
      inner_checkpoint_findings: findings,
    })

    expect(store.get(run.id)).toMatchObject({
      inner_verdict: 'REQUEST_CHANGES',
      inner_checkpoint_findings: findings,
    })
  })

  test('update() accepts REQUEST_CHANGES when the ROW already carries findings', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-update-row', project_slug: 't1', repo_path: '/r', task: 't' })
    const findings = '[{"severity":"blocker"}]'
    await store.update(run.id, {
      inner_checkpoint: 'argus-request-changes',
      inner_checkpoint_findings: findings,
    })

    await store.update(run.id, { inner_verdict: 'REQUEST_CHANGES' })

    expect(store.get(run.id)).toMatchObject({
      inner_verdict: 'REQUEST_CHANGES',
      inner_checkpoint_findings: findings,
    })
  })

  test('update() refuses CLEARING findings on a row recorded REQUEST_CHANGES', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-update-clear', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, {
      inner_verdict: 'REQUEST_CHANGES',
      inner_checkpoint_findings: '[{"severity":"blocker"}]',
    })

    await expect(
      store.update(run.id, { inner_checkpoint_findings: null }),
    ).rejects.toThrow(TridentEmptyFindingsRejectionError)

    expect(store.get(run.id)?.inner_checkpoint_findings).toBe('[{"severity":"blocker"}]')
  })

  test('FALSIFICATION 2 — save() and saveIfActive() refuse an RC snapshot when the row carries no findings (delete either guard and this goes RED)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-snapshots-empty', project_slug: 't1', repo_path: '/r', task: 't' })

    await expect(
      store.save({ ...run, phase: 'failed', inner_verdict: 'REQUEST_CHANGES' }),
    ).rejects.toThrow(TridentEmptyFindingsRejectionError)
    expect(store.get(run.id)?.phase).toBe('forge-init')

    await expect(
      store.saveIfActive({ ...run, phase: 'failed', inner_verdict: 'REQUEST_CHANGES' }),
    ).rejects.toThrow(TridentEmptyFindingsRejectionError)
    expect(store.get(run.id)?.phase).toBe('forge-init')
  })

  test("FALSIFICATION 3 — an incoming '[]' cannot ERASE the stored findings and land beside REQUEST_CHANGES", async () => {
    // THE HOLE THE FALLBACK OPENED (Argus r1 blocker). Both guards fell back to the
    // STORED row whenever the incoming findings decoded empty — but `'[]'` is not the
    // same as "brought nothing": it is non-null, so the COALESCE in the very same
    // UPDATE OVERWRITES the column with it. A snapshot carrying `'[]'` therefore
    // cleared the guard on evidence it was about to delete, and persisted exactly the
    // `REQUEST_CHANGES` + `[]` row this card exists to make unwritable. NULL is the
    // only incoming value COALESCE leaves the stored evidence alone for, so NULL is
    // the only one allowed to be judged against it.
    const store = new TridentRunStore(db)
    const REAL = '[{"severity":"blocker","title":"a reviewer actually said this"}]'

    for (const writer of ['save', 'saveIfActive'] as const) {
      const run = await store.create({
        slug: `guard-empty-over-stored-${writer.toLowerCase()}`,
        project_slug: 't1',
        repo_path: '/r',
        task: 't',
      })
      await store.update(run.id, {
        inner_checkpoint: 'argus-request-changes',
        inner_checkpoint_findings: REAL,
      })

      // The checkpoint write above derives a phase; capture it so "nothing moved"
      // is measured against the row as it stood, not against a guessed constant.
      const phaseBefore = store.get(run.id)!.phase
      expect(phaseBefore).not.toBe('failed') // the write below would be a real move

      const snapshot = {
        ...store.get(run.id)!,
        phase: 'failed' as const,
        inner_verdict: 'REQUEST_CHANGES' as const,
        inner_checkpoint_findings: '[]',
      }
      await expect(
        writer === 'save' ? store.save(snapshot) : store.saveIfActive(snapshot),
      ).rejects.toThrow(TridentEmptyFindingsRejectionError)

      // Nothing moved: not the phase, and above all not the evidence.
      expect({ [writer]: store.get(run.id)?.phase }).toEqual({ [writer]: phaseBefore })
      expect({ [writer]: store.get(run.id)?.inner_checkpoint_findings }).toEqual({ [writer]: REAL })

      // The legacy shape is not merely absent — it is unwritable. Counted with the
      // canonical SQL from docs/AS_BUILT.md so this asserts the number the card
      // promises to make trustworthy, not a JS re-reading of it.
      const legacy = db.raw().query(
        `SELECT COUNT(*) AS n FROM code_trident_runs
          WHERE id = ? AND inner_verdict = 'REQUEST_CHANGES'
            AND NOT CASE WHEN json_valid(inner_checkpoint_findings)
                           THEN json_type(inner_checkpoint_findings) = 'array'
                                AND json_array_length(inner_checkpoint_findings) > 0
                           ELSE 0 END`,
      ).get(run.id) as { n: number }
      expect({ [writer]: legacy.n }).toEqual({ [writer]: 0 })
    }
  })

  test("POSITIVE CONTROL for FALSIFICATION 3 — a snapshot that brings NULL findings is still judged against the stored ones, and commits", async () => {
    // The other half of patch-wins: a save that legitimately leaves the column alone
    // (NULL, which COALESCE preserves) must still be able to commit a genuine
    // rejection on the evidence already on record. Without this, tightening the guard
    // would read as correct while having broken every real terminal RC write.
    const store = new TridentRunStore(db)
    const REAL = '[{"severity":"blocker","title":"a reviewer actually said this"}]'
    const run = await store.create({
      slug: 'guard-null-over-stored',
      project_slug: 't1',
      repo_path: '/r',
      task: 't',
    })
    await store.update(run.id, {
      inner_checkpoint: 'argus-request-changes',
      inner_checkpoint_findings: REAL,
    })

    expect(
      await store.saveIfActive({
        ...store.get(run.id)!,
        phase: 'failed',
        inner_verdict: 'REQUEST_CHANGES',
        inner_checkpoint_findings: null,
      }),
    ).toBe(true)

    expect(store.get(run.id)).toMatchObject({
      phase: 'failed',
      inner_verdict: 'REQUEST_CHANGES',
      inner_checkpoint_findings: REAL,
    })
  })

  test('saveIfActive() commits a genuine RC terminal snapshot when the row carries findings', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-save-active-genuine', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, {
      inner_checkpoint: 'argus-request-changes',
      inner_checkpoint_findings: '[{"severity":"blocker"}]',
    })

    expect(await store.saveIfActive({
      ...store.get(run.id)!,
      phase: 'failed',
      inner_verdict: 'REQUEST_CHANGES',
    })).toBe(true)
    expect(store.get(run.id)).toMatchObject({ phase: 'failed', inner_verdict: 'REQUEST_CHANGES' })
  })

  test('save() commits a genuine RC snapshot that BRINGS its findings, and persists them (Argus r1)', async () => {
    // The satisfiability control for save()'s guard. It used to read the STORED
    // column while this writer never populated it, so a caller holding the findings
    // in hand could not satisfy it by any means — a real rejection would throw on
    // every tick (swallowed as `advance_failed`) and the run would retry forever.
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-save-carries-findings', project_slug: 't1', repo_path: '/r', task: 't' })
    expect(store.get(run.id)?.inner_checkpoint_findings).toBeNull() // the row has nothing

    await store.save({
      ...store.get(run.id)!,
      phase: 'failed',
      inner_verdict: 'REQUEST_CHANGES',
      inner_checkpoint_findings: '[{"severity":"blocker","title":"a reviewer actually said this"}]',
    })

    expect(store.get(run.id)).toMatchObject({
      phase: 'failed',
      inner_verdict: 'REQUEST_CHANGES',
      // The verdict and its evidence landed in the SAME statement — a rejection
      // recorded beside an empty column is the row this whole card forbids.
      inner_checkpoint_findings: '[{"severity":"blocker","title":"a reviewer actually said this"}]',
    })
  })

  test('the guard ignores APPROVE and REVIEW_NOT_RUN', async () => {
    const store = new TridentRunStore(db)
    for (const verdict of ['APPROVE', 'REVIEW_NOT_RUN'] as const) {
      const updated = await store.create({
        slug: `guard-update-${verdict.toLowerCase()}`,
        project_slug: 't1',
        repo_path: '/r',
        task: 't',
      })
      await store.update(updated.id, { inner_verdict: verdict })
      expect(store.get(updated.id)?.inner_verdict).toBe(verdict)

      const saved = await store.create({
        slug: `guard-save-${verdict.toLowerCase()}`,
        project_slug: 't1',
        repo_path: '/r',
        task: 't',
      })
      expect(await store.saveIfActive({
        ...saved,
        phase: 'ralph-plan',
        inner_verdict: verdict,
      })).toBe(true)
      expect(store.get(saved.id)?.inner_verdict).toBe(verdict)
    }
  })

  test('a raw out-of-band write still lands (checkpoint.sh is outside the store contract)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'guard-raw-writer', project_slug: 't1', repo_path: '/r', task: 't' })

    await db.run(
      'UPDATE code_trident_runs SET inner_verdict = ? WHERE id = ?',
      ['REQUEST_CHANGES', run.id],
    )

    expect(store.get(run.id)?.inner_verdict).toBe('REQUEST_CHANGES')
    expect(store.get(run.id)?.inner_checkpoint_findings).toBeNull()
  })
})

describe('round persistence (canary)', () => {
  test('update() derives round from a fix checkpoint', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-update', project_slug: 't1', repo_path: '/r', task: 't' })

    await store.update(run.id, { inner_checkpoint: 'fix-round-3' })

    expect(store.get(run.id)?.round).toBe(3)
    expect(store.get(run.id)?.inner_checkpoint).toBe('fix-round-3')
  })

  test('update() keeps round monotonic while storing an older checkpoint', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-monotonic', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, { inner_checkpoint: 'fix-round-3' })

    await store.update(run.id, { inner_checkpoint: 'fix-round-2' })

    expect(store.get(run.id)?.round).toBe(3)
    expect(store.get(run.id)?.inner_checkpoint).toBe('fix-round-2')
  })

  test('update() does not guess a round from an unrelated checkpoint', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-no-guess', project_slug: 't1', repo_path: '/r', task: 't' })

    await store.update(run.id, { inner_checkpoint: 'argus-approved' })

    expect(store.get(run.id)?.round).toBe(1)
  })

  test('update() lets an explicit round win without a duplicate SET', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-explicit', project_slug: 't1', repo_path: '/r', task: 't' })

    await store.update(run.id, { round: 9, inner_checkpoint: 'fix-round-4' })

    expect(store.get(run.id)?.round).toBe(9)
  })

  test('update() persists outer-published group 3 as the round', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-published', project_slug: 't1', repo_path: '/r', task: 't' })

    await store.update(run.id, {
      inner_checkpoint: `outer-published:${'b'.repeat(40)}:2:6`,
    })

    expect(store.get(run.id)?.round).toBe(6)
  })

  test('saveIfActive() derives round from a fix checkpoint', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-save-active', project_slug: 't1', repo_path: '/r', task: 't' })

    expect(await store.saveIfActive({ ...store.get(run.id)!, inner_checkpoint: 'fix-round-5' })).toBe(true)

    expect(store.get(run.id)?.round).toBe(5)
  })

  test('save() derives round and never lowers the stored value from a stale snapshot', async () => {
    const store = new TridentRunStore(db)
    const staleRun = await store.create({ slug: 'round-save-stale', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(staleRun.id, { inner_checkpoint: 'fix-round-5' })

    await store.save({ ...staleRun, round: 1, inner_checkpoint: 'argus-approved' })

    expect(store.get(staleRun.id)?.round).toBe(5)

    const derivedRun = await store.create({ slug: 'round-save-derived', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.save({ ...store.get(derivedRun.id)!, inner_checkpoint: 'fix-round-4' })
    expect(store.get(derivedRun.id)?.round).toBe(4)
  })
})

describe('terminalTransition retracts a stale in-flight claim', () => {
  // Observed live 2026-08-10: the owner cancelled a running build and the row sat at
  // `phase='stopped'` with `subagent_status='running'` — a finished run still
  // presenting itself as working. Whether the child process was still alive is a
  // separate question (usually it is — #177), and it is why the fix
  // needs a durability half in `trident/checkpoint.sh` as well as this write.
  //
  // Not cosmetic, but not for the reason it is tempting to write down either: #143's
  // harvest gate and orphan recovery never see a terminal row (`step()` returns early
  // on `isTerminalPhase`), and the hang watchdog keys on `last_advanced_at`. The
  // reader that IS load-bearing is the CRASH VETO on `update()` — the ONE writer
  // with no `phase NOT IN (terminal)` predicate, so its `AND subagent_status IS NOT
  // 'crashed'` is all that latches a crash on a terminal row (`saveIfActive()` has
  // the same veto but also the phase predicate, so on a terminal row it is
  // unreachable). Hence the 'crashed'-survives cases below must never regress.

  // Every value migration 0077's `subagent_status` CHECK admits, plus null. The
  // matrix below covers ALL of them: a case-by-case CASE is exactly the kind of
  // code where one unlisted value silently takes the wrong branch.
  async function runAt(status: 'running' | 'pending' | 'completed' | 'failed' | 'crashed' | null) {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'email-core-p1',
      project_slug: 'neutron-open',
      repo_path: '/repos/neutron-open',
      task: 'build the email core',
    })
    if (status !== null) await store.update(run.id, { subagent_status: status })
    // Non-empty precondition: without this the assertions below could pass on a row
    // that never carried the claim in the first place.
    expect(store.get(run.id)?.subagent_status).toBe(status)
    return { store, id: run.id }
  }

  test('cancelling a RUNNING build clears the running claim, and keeps the reason', async () => {
    const { store, id } = await runAt('running')

    const { won } = await store.terminalTransition(id, {
      phase: 'stopped',
      failure_reason: 'cancelled via codegen_cancel',
    })

    expect(won).toBe(true)
    const after = store.get(id)
    expect(after?.phase).toBe('stopped')
    expect(after?.subagent_status).toBeNull()
    // The reason survives, so nulling the status loses no information.
    expect(after?.failure_reason).toBe('cancelled via codegen_cancel')
  })

  test("a PENDING claim is retracted too — 'pending' asserts a child just as 'running' does", async () => {
    // Not currently written by any production path (the orchestrator writes only
    // running/completed/failed/crashed/null), but it is in the type and in migration
    // 0077's CHECK, and it means "about to be in flight" — a claim, not an outcome. If
    // a writer ever appears, a cancelled run must not be left asserting it.
    const { store, id } = await runAt('pending')

    await store.terminalTransition(id, { phase: 'stopped', failure_reason: 'cancelled' })

    expect(store.get(id)?.subagent_status).toBeNull()
  })

  test('a CRASHED marker SURVIVES — this restriction is load-bearing, not incidental', async () => {
    // Nulling unconditionally would erase 'crashed' whenever anything terminated an
    // already-crashed run as 'failed', silently disarming `update()`'s crash veto while
    // looking like a cleanup. NOT `saveIfActive()`'s identical veto — that statement also
    // carries `phase NOT IN (terminal)`, so on the row this test produces it cannot land
    // at all and its veto is unreachable (see the docblock over `terminalTransition`).
    // 'running'/'pending' are live CLAIMS; the others are OUTCOMES.
    const { store, id } = await runAt('crashed')

    await store.terminalTransition(id, { phase: 'failed', failure_reason: 'reaped' })

    expect(store.get(id)?.subagent_status).toBe('crashed')
  })

  test('a COMPLETED outcome also survives', async () => {
    const { store, id } = await runAt('completed')

    await store.terminalTransition(id, { phase: 'done', failure_reason: null })

    expect(store.get(id)?.subagent_status).toBe('completed')
  })

  test("a FAILED outcome survives too — the last value the CHECK admits, and the one most easily forgotten", async () => {
    // 'failed' is the fifth and last value in migration 0077's subagent_status
    // CHECK, and the only one this matrix originally missed. Without it a mutant
    // that ALSO cleared 'failed' (`IN ('running','pending','failed')`) passed the
    // whole suite while erasing the subagent-level outcome of every failed build.
    const { store, id } = await runAt('failed')

    await store.terminalTransition(id, { phase: 'failed', failure_reason: 'the build failed' })

    expect(store.get(id)?.subagent_status).toBe('failed')
  })

  test('a run with no subagent status stays null', async () => {
    const { store, id } = await runAt(null)

    await store.terminalTransition(id, { phase: 'stopped', failure_reason: 'cancelled' })

    expect(store.get(id)?.subagent_status).toBeNull()
  })

  test('a LOSER transition writes NOTHING — not even a status the CASE would have cleared', async () => {
    // The atomic guard means a second terminate finds the row already terminal and
    // writes nothing at all. Pinning that with a 'crashed' status could not prove it:
    // the CASE preserves 'crashed' anyway, so the assertion would pass whether the
    // loser wrote nothing or wrote the preserving CASE. Put back the one value the
    // CASE *would* clear — if the loser's UPDATE landed, this goes null.
    const { store, id } = await runAt('running')
    await store.terminalTransition(id, { phase: 'stopped', failure_reason: 'first' })
    expect(store.get(id)?.subagent_status).toBeNull() // the winner retracted it
    await store.update(id, { subagent_status: 'running' })
    expect(store.get(id)?.subagent_status).toBe('running')

    const second = await store.terminalTransition(id, { phase: 'failed', failure_reason: 'second' })

    // Row state FIRST, deliberately: asserting `won` first would short-circuit the
    // failure and hide which part of the loser's write leaked.
    expect(store.get(id)?.subagent_status).toBe('running')
    expect(store.get(id)?.phase).toBe('stopped')
    expect(store.get(id)?.failure_reason).toBe('first')
    expect(second.won).toBe(false)
  })

  test('with NO failure_reason — the SHORT params branch — binding is still correct', async () => {
    // The CASE takes no bound parameter, so it sits in the SET list between two
    // clauses that DO. Omitting `failure_reason` makes `params` one shorter, and
    // this is not a rare shape: the board X-cancel (`work-board-surface.ts`) and
    // `/code stop` (`code-command.ts`) BOTH terminate without a reason, so two of
    // the four production callers take this branch. An off-by-one would either
    // fail LOUDLY (a timestamp bound to `phase` violates 0077's phase CHECK) or
    // land QUIETLY in a column nothing asserts on — `failure_reason` being the one
    // this shape would actually hit — so pin the columns individually rather than
    // trusting the status assertion plus the CHECK to catch every shift.
    const { store, id } = await runAt('running')
    await store.update(id, { failure_reason: 'pre-existing reason' })
    const before = store.get(id)!.last_advanced_at

    const { won } = await store.terminalTransition(id, { phase: 'failed' })

    expect(won).toBe(true)
    const after = store.get(id)!
    expect(after.phase).toBe('failed') // not a timestamp
    expect(after.subagent_status).toBeNull()
    // An untouched column, so a stray bound value would show up here.
    expect(after.failure_reason).toBe('pre-existing reason')
    expect(Number.isFinite(Date.parse(after.last_advanced_at))).toBe(true)
    expect(after.last_advanced_at >= before).toBe(true)
  })

  test('a preserved CRASHED latch still vetoes a later update() — the restriction is load-bearing HERE', async () => {
    // The tempting justification for keeping 'crashed' is #143's harvest gate, and it
    // is wrong: `step()` no-ops on an already-terminal phase
    // (`orchestrator.ts:678-683`), so that gate is unreachable once the row is
    // terminal. This is the path where preserving it still bites: of the writers that
    // can reach a terminal row, `update()` is the only one that both lacks a
    // `phase NOT IN (terminal)` guard and carries the `subagent_status IS NOT 'crashed'`
    // veto (`store.ts:447-449`), so that veto is all that latches a crash there.
    // (`saveIfActive` has the veto but also the phase predicate; `save` has neither, and
    // is inert only because nothing in production calls it.) Nulling unconditionally
    // would lift the veto — the real reason a future "simplify to NULL" must not land.
    const { store, id } = await runAt('crashed')

    await store.terminalTransition(id, { phase: 'failed' })
    expect(store.get(id)?.subagent_status).toBe('crashed')

    await store.update(id, { subagent_status: 'completed' })

    expect(store.get(id)?.subagent_status).toBe('crashed')
  })
})

describe('INSERT column/placeholder/bound-array alignment — the silent-corruption guard (BLOCKING addendum)', () => {
  test('COLS matches the 41 snapshot-writable table columns', () => {
    // The INSERT placeholder list is derived from COLS, so placeholder count =
    // column count by construction. What is NOT free is COLS agreeing with the
    // TABLE: a column added, dropped or renamed by a migration without touching
    // COLS corrupts every insert silently (STRICT only catches affinity, not
    // arity/order). The literal count is deliberate — adding a column must be a
    // conscious edit here, not an invisible drift. It moved 40 -> 41 when
    // `claimed_paths` arrived with migration 0139: the guard refused to let a
    // real column land silently, which is exactly its job.
    const cols = COLS.split(', ')
    const pragma = db
      .prepare<{ name: string }, []>(`PRAGMA table_info(code_trident_runs)`)
      .all()

    expect(cols).toHaveLength(41)
    // agent_waked_at is deliberately absent from COLS: claimAgentWake is its sole
    // writer, so a full snapshot can never clear an already-won delivery claim.
    // The table therefore has 42 columns and COLS has 41 — compare against the
    // snapshot-writable set, not the raw pragma count.
    const snapshotWritable = pragma.filter((c) => c.name !== 'agent_waked_at')
    expect(cols).toHaveLength(snapshotWritable.length)
    // Same members, order-independent: a rename or a drop goes red.
    expect([...cols].sort()).toEqual([...snapshotWritable.map((c) => c.name)].sort())
  })

  test('FIX-ROUND CONTRACT fields round-trip and default to unconstrained nulls', async () => {
    const store = new TridentRunStore(db)
    const reviewedHead = 'a'.repeat(40)
    const constrained = await store.create({
      slug: 'contract-set', project_slug: 't1', repo_path: '/r', task: 't',
      reviewed_head: reviewedHead, bound_pr: 289, fenced_paths: '["trident/tick.ts"]',
    })
    expect(store.get(constrained.id)).toMatchObject({
      reviewed_head: reviewedHead, bound_pr: 289, fenced_paths: '["trident/tick.ts"]',
    })
    const legacy = await store.create({ slug: 'contract-null', project_slug: 't1', repo_path: '/r', task: 't' })
    expect(store.get(legacy.id)).toMatchObject({ reviewed_head: null, bound_pr: null, fenced_paths: null })
  })

  test('bound-array order and length survive a distinct-value create()/get() round-trip', async () => {
    // WHY THIS IS MUTATION-RED: create() returns the JS object it INTENDED to
    // write; get() re-reads what the DB actually stored through COLS. Swapping
    // any two entries of the bound array — or shortening it — makes the two
    // disagree. STRICT typing catches cross-affinity swaps at insert time; the
    // distinct, non-default value for EVERY input field catches the same-affinity
    // swaps (slug/project_slug, chat_id/thread_id, repo_path/worktree/task)
    // that no type or constraint would ever notice.
    const store = new TridentRunStore(db)
    const run = await store.create({
      id: 'run-distinct-0001',
      slug: 'slug-distinct',
      project_slug: 'project-slug-distinct',
      phase: 'ralph-plan',
      max_rounds: 7,
      ralph: true,
      max_ralph_rounds: 13,
      branch: 'branch-distinct',
      merge_mode: 'pr',
      repo_path: '/repo/path/distinct',
      worktree: '/worktree/path/distinct',
      task: 'task text distinct',
      chat_id: 'chat-id-distinct',
      thread_id: 'thread-id-distinct',
      channel_kind: 'cli',
      parent_run_id: 'parent-run-distinct',
      wave_task_id: 'T7',
    })

    expect(store.get(run.id)).toEqual(run)
  })

  /**
   * `changeSignature()` is the wake-on-change watcher's ENTIRE detector: one query,
   * one `<stamp>\t<id>` line per non-terminal run, compared against the last
   * observation. Anything it cannot see waits out the 90 s backstop — which is the
   * latency the watcher exists to remove — so the cases below are about what MOVES
   * it, not about the string it happens to produce.
   */
  describe('changeSignature', () => {
    /** Write `last_advanced_at` directly: the point is the shape a foreign writer
     *  (trident/checkpoint.sh) puts in the column, which `update()` cannot express. */
    const stamp = (id: string, at: string): void => {
      db.raw().run(`UPDATE code_trident_runs SET last_advanced_at = ? WHERE id = ?`, [at, id])
    }

    test('a LATER millisecond stamp on one run is not masked by a whole-second stamp on another', async () => {
      // THE MIXED-PRECISION BUG, which needs TWO runs to show itself because the
      // first shape of this signature took MAX ACROSS the active set. `store.now()`
      // writes `…T03:15:45.900Z`; checkpoint.sh writes `…T03:15:45Z`. SQLite compares
      // them as TEXT and 'Z' (0x5A) sorts ABOVE '.' (0x2E), so run A's whole-second
      // stamp read as GREATER than run B's later millisecond one: the raw MAX never
      // moved, the watcher saw no change, and B's advance waited out the 90 s
      // backstop. Per-run equality has no ordering in it at all, so the case is now
      // structurally impossible — kept as the regression guard for the class.
      const store = new TridentRunStore(db)
      const a = await store.create({ slug: 'cs1a', project_slug: 't1', repo_path: '/r', task: 't' })
      const b = await store.create({ slug: 'cs1b', project_slug: 't1', repo_path: '/r', task: 't' })

      // A checkpointed at :45 (whole seconds); B is behind it.
      stamp(a.id, '2026-08-15T03:15:45Z')
      stamp(b.id, '2026-08-15T03:15:44.100Z')
      const before = store.changeSignature()

      // B then advances at :45.900 — LATER than A's stamp by 900 ms.
      stamp(b.id, '2026-08-15T03:15:45.900Z')

      expect(store.changeSignature()).not.toBe(before)
    })

    test('the count moves when a run is created and when one leaves the active set', async () => {
      const store = new TridentRunStore(db)
      const empty = store.changeSignature()
      const run = await store.create({ slug: 'cs2', project_slug: 't1', repo_path: '/r', task: 't' })
      const one = store.changeSignature()
      expect(one).not.toBe(empty)

      // A terminal run is not in the watched set at all, so its transition is itself
      // a change — the sweep needs to fire to drop it from the live rail.
      await store.save({ ...run, phase: 'done' })
      expect(store.changeSignature()).not.toBe(one)
    })

    test('an unchanged active set produces the SAME signature every call', async () => {
      // The other half of the contract: the detector must be quiet when nothing
      // happens, or it is just a 2 s tick loop wearing a disguise.
      const store = new TridentRunStore(db)
      await store.create({ slug: 'cs3', project_slug: 't1', repo_path: '/r', task: 't' })
      const a = store.changeSignature()
      expect(store.changeSignature()).toBe(a)
      expect(store.changeSignature()).toBe(a)
    })

    test('a re-stamp that does NOT move the newest stamp is still a change', async () => {
      // WHY THE DETECTOR IS PER-RUN (Argus r2). A checkpoint on run B while run A
      // already holds a later stamp moves neither COUNT nor MAX — the aggregate
      // signature was identical before and after, so the sweep's settle could not
      // tell that checkpoint apart from its own writes and the handoff fell back to
      // the 90 s backstop. Under the sweep's own timing (it stamps the run it
      // advanced LAST, after seconds of git/gh work) this is the ordinary case, not
      // a contrived one.
      const store = new TridentRunStore(db)
      const a = await store.create({ slug: 'cs4a', project_slug: 't1', repo_path: '/r', task: 't' })
      const b = await store.create({ slug: 'cs4b', project_slug: 't1', repo_path: '/r', task: 't' })
      stamp(a.id, '2026-08-15T03:15:50.000Z') // A is the newest — MAX is pinned here
      stamp(b.id, '2026-08-15T03:15:40.000Z')
      const before = store.changeSignature()

      stamp(b.id, '2026-08-15T03:15:45.000Z') // B advances, still behind A
      expect(store.changeSignature()).not.toBe(before)
    })

    test('changeSignatureEntries reads the signature back as run id → stamp', async () => {
      // The settle's ONE structural dependency on the format: it must be able to ask
      // WHICH run moved, not just whether something did.
      const store = new TridentRunStore(db)
      const a = await store.create({ slug: 'cs5a', project_slug: 't1', repo_path: '/r', task: 't' })
      const b = await store.create({ slug: 'cs5b', project_slug: 't1', repo_path: '/r', task: 't' })
      stamp(a.id, '2026-08-15T03:15:50.000Z')
      stamp(b.id, '2026-08-15T03:15:40Z') // checkpoint.sh's whole-second shape

      const entries = changeSignatureEntries(store.changeSignature())
      expect(entries.size).toBe(2)
      expect(entries.get(a.id)).toBe('2026-08-15T03:15:50.000Z')
      expect(entries.get(b.id)).toBe('2026-08-15T03:15:40Z')
      // The empty active set is the empty signature, and reads back as no entries.
      expect(changeSignatureEntries('').size).toBe(0)
    })
  })
})

describe('update() derives the phase from the checkpoint', () => {
  /**
   * WHY THIS SUITE EXISTS — MEASURED. `phaseForCheckpoint` (the canonical
   * checkpoint → phase table) had ZERO production callers. `checkpoint.sh` mirrors
   * the table in bash and applies it, so the half of the system the INNER workflow
   * drives moved off `forge-init` correctly. The orchestrator does not checkpoint
   * through that script — it calls `update()` directly, at ~9 sites — so every
   * checkpoint the OUTER loop stamped left `phase` exactly as it found it. The
   * table was merged green and wired on one side only.
   *
   * Each test below is the assertion that the TS seam now answers the same way the
   * bash seam does. `checkpoint-phase.test.ts` separately pins the two TABLES
   * against each other; this pins the two WRITE PATHS.
   */
  const seed = async (store: TridentRunStore, slug: string) =>
    await store.create({ slug, project_slug: 't1', repo_path: '/r', task: 't' })

  test('a checkpoint the table recognises moves the phase off forge-init', async () => {
    const store = new TridentRunStore(db)
    const run = await seed(store, 'phase-forge-done')
    // POSITIVE CONTROL: prove the starting state, so a test that passes because
    // nothing happened cannot masquerade as a test that passes because it worked.
    expect(run.phase).toBe('forge-init')

    expect((await store.update(run.id, { inner_checkpoint: 'forge-done' }))?.phase).toBe('argus')
  })

  test('every live checkpoint name maps as the canonical table says', async () => {
    const store = new TridentRunStore(db)
    const cases: [string, string][] = [
      ['forge-done', 'argus'],
      ['argus-approved', 'argus'],
      ['fix-round-1', 'argus'],
      ['fix-round-10', 'argus'],
      ['argus-request-changes', 'forge-fix'],
      ['argus-request-changes-round-2', 'forge-fix'],
      ['ralph-task-built', 'ralph-task'],
    ]
    for (const [checkpoint, phase] of cases) {
      const run = await seed(store, `phase-map-${checkpoint}`)
      const got = await store.update(run.id, { inner_checkpoint: checkpoint })
      expect([checkpoint, got?.phase]).toEqual([checkpoint, phase])
    }
  })

  test('a checkpoint that implies NOTHING leaves the phase exactly as it was', async () => {
    const store = new TridentRunStore(db)
    // The three `null` cases from the table's header, which must not be conflated
    // with each other OR with a guess: terminal-adjacent, an outer-loop marker,
    // and a name the table has never seen.
    for (const cp of ['pr-merged', 'inner-error', 'awaiting-trailer', 'outer-published:abc123:0:3', 'a-checkpoint-invented-next-week']) {
      const run = await seed(store, `phase-null-${cp.slice(0, 12)}`)
      await store.update(run.id, { phase: 'argus' })
      const got = await store.update(run.id, { inner_checkpoint: cp })
      expect([cp, got?.phase]).toEqual([cp, 'argus'])
      // ...and the checkpoint itself still lands. Leaving the phase alone must not
      // mean dropping the write.
      expect(got?.inner_checkpoint).toBe(cp)
    }
  })

  test('an explicit phase in the same patch wins over the derivation', async () => {
    const store = new TridentRunStore(db)
    const run = await seed(store, 'phase-explicit')
    // The orchestrator's terminal writes pass BOTH — e.g. `{ phase: 'done',
    // inner_checkpoint: 'pr-merged' }`. A derivation that overrode the caller
    // would un-finish a finished run.
    const got = await store.update(run.id, { phase: 'done', inner_checkpoint: 'forge-done' })
    expect(got?.phase).toBe('done')
  })

  test('a terminal phase is frozen — a late checkpoint cannot resurrect a finished run', async () => {
    const store = new TridentRunStore(db)
    for (const terminal of ['done', 'failed', 'stopped'] as const) {
      const run = await seed(store, `phase-frozen-${terminal}`)
      await store.update(run.id, { phase: terminal })
      const got = await store.update(run.id, { inner_checkpoint: 'forge-done' })
      expect([terminal, got?.phase]).toEqual([terminal, terminal])
    }
  })

  test('the derivation does not disturb the round derivation beside it', async () => {
    const store = new TridentRunStore(db)
    const run = await seed(store, 'phase-and-round')
    const got = await store.update(run.id, { inner_checkpoint: 'fix-round-4' })
    expect([got?.phase, got?.round]).toEqual(['argus', 4])
  })
})
