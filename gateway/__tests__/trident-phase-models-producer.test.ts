/**
 * THE PER-PHASE MODEL CONFIG GETS A PRODUCER — and this file is mostly about the
 * producer, not the config.
 *
 * WHAT WAS WRONG. `trident/phase-models.ts` (the vocabulary + validation),
 * `InnerLoopInput.phase_models` (the workflow argument) and the workflow's own
 * router were all built, tested and correct — and **nothing ever supplied a
 * value**. The orchestrator did not pass one when it fired a workflow, and no
 * surface wrote one. A complete seam with no producer: every run silently used the
 * defaults no matter what was configured, and nothing could go red, because every
 * piece worked in isolation.
 *
 * That is the built-but-never-connected shape `SPEC.md` names as this repo's repeat
 * offender, and it was found by an independent design review rather than by a test.
 * So the tests here weight the CHAIN over the parts: store round-trip, the
 * orchestrator actually passing the value, and the composer actually supplying the
 * resolver — each asserted separately, because each was independently absent.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  readTridentPhaseModels,
  readTridentPhaseModelsWithRejected,
  writeTridentPhaseModels,
} from '@neutronai/gateway/storage/owner-metadata.ts'
import type { CodexAvailability } from '@neutronai/trident/codex-credential.ts'
import { TRIDENT_PHASES } from '@neutronai/trident/phase-models.ts'

const SCOPE = 'owner'
let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'phase-models-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('the store — a written override comes back', () => {
  it('round-trips a valid config', async () => {
    const res = await writeTridentPhaseModels(db, SCOPE, {
      build: { model: 'opus', effort: 'xhigh' },
    })
    expect(res).toEqual({ ok: true, errors: [] })
    expect(readTridentPhaseModels(db, SCOPE)).toEqual({
      build: { model: 'opus', effort: 'xhigh' },
    })
  })

  it('returns {} when nothing was ever written', () => {
    expect(readTridentPhaseModels(db, SCOPE)).toEqual({})
  })

  it('REJECTS THE WHOLE WRITE when any entry is invalid, and stores nothing', async () => {
    await writeTridentPhaseModels(db, SCOPE, { build: { model: 'opus' } })
    const res = await writeTridentPhaseModels(db, SCOPE, {
      build: { model: 'sonnet' },
      nonsense: { effort: 'max' },
    })
    expect(res.ok).toBe(false)
    expect(res.errors[0]).toContain('nonsense')
    // The PRIOR value survives untouched. A partial write here is the worst
    // outcome available: the owner would see one of their two changes applied and
    // have no way to tell which.
    expect(readTridentPhaseModels(db, SCOPE)).toEqual({ build: { model: 'opus' } })
  })

  it('clears to NULL rather than storing an empty object', async () => {
    await writeTridentPhaseModels(db, SCOPE, { build: { model: 'opus' } })
    await writeTridentPhaseModels(db, SCOPE, {})
    expect(readTridentPhaseModels(db, SCOPE)).toEqual({})
    const row = db
      .prepare<{ trident_phase_models: string | null }, [string]>(
        `SELECT trident_phase_models FROM instance_metadata WHERE instance_slug = ? LIMIT 1`,
      )
      .get(SCOPE)
    // "never configured" and "configured to nothing" must be ONE state, not two.
    expect(row?.trident_phase_models).toBeNull()
  })

  it('re-validates ON READ, so a row from a looser build cannot reach the workflow', async () => {
    // Written straight past the validator, as an older or hand-edited build could.
    await db.run(
      `INSERT INTO instance_metadata (instance_slug, trident_phase_models) VALUES (?, ?)`,
      [SCOPE, JSON.stringify({ build: { model: 'opus' }, invented_phase: { effort: 'max' } })],
    )
    // The valid half survives; the phase that no longer exists is dropped here
    // rather than in the workflow, whose only response would be a log line in a
    // detached background run.
    expect(readTridentPhaseModels(db, SCOPE)).toEqual({ build: { model: 'opus' } })
  })

  it('treats corrupt JSON as "no overrides" instead of throwing into a build launch', async () => {
    await db.run(
      `INSERT INTO instance_metadata (instance_slug, trident_phase_models) VALUES (?, ?)`,
      [SCOPE, '{not json'],
    )
    expect(readTridentPhaseModels(db, SCOPE)).toEqual({})
  })

  it('does not disturb a sibling setting on the same row', async () => {
    // `instance_metadata` is one row per scope with additive columns, so an upsert
    // that forgot `ON CONFLICT` would silently blank the timezone next door.
    await db.run(
      `INSERT INTO instance_metadata (instance_slug, timezone) VALUES (?, ?)
         ON CONFLICT(instance_slug) DO UPDATE SET timezone = excluded.timezone`,
      [SCOPE, 'America/Los_Angeles'],
    )
    await writeTridentPhaseModels(db, SCOPE, { build: { model: 'opus' } })
    const row = db
      .prepare<{ timezone: string | null }, [string]>(
        `SELECT timezone FROM instance_metadata WHERE instance_slug = ? LIMIT 1`,
      )
      .get(SCOPE)
    expect(row?.timezone).toBe('America/Los_Angeles')
  })
})

describe('the chain is actually connected — each link asserted separately', () => {
  /**
   * SOURCE assertions, deliberately. Booting the real orchestrator needs a live
   * substrate, a socket registry and a database, which is a heavy and flaky way to
   * check that one argument is passed. What these must NOT be is the shape the
   * composition gate exists to catch — a hand-built config literal asserting the
   * consumer honours a value it was handed, which passes whether or not anything
   * supplies one.
   *
   * Every regex is SCOPED to the construct it is about: an unscoped match on a
   * symbol name passes on an unrelated mention elsewhere in the file, which has
   * bitten this repo twice in one day.
   */
  const strip = (src: string): string =>
    src
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')

  it('the ORCHESTRATOR passes phase_models when it fires a workflow', async () => {
    const src = strip(
      await Bun.file(new URL('../../trident/orchestrator.ts', import.meta.url)).text(),
    )
    const call = src.slice(src.indexOf('const firePromise = fireWorkflow({'))
    const block = call.slice(0, call.indexOf('\n    })'))
    expect(block.includes('phase_models: opts.resolve_phase_models()')).toBe(true)
  })

  it('the COMPOSITION layer copies the resolver onto the orchestrator options', async () => {
    const src = strip(
      await Bun.file(
        new URL('../composition/build-core-modules.ts', import.meta.url),
      ).text(),
    )
    expect(
      src.includes('orchestratorOpts.resolve_phase_models = tridentWiring.resolve_phase_models'),
    ).toBe(true)
  })

  it('the COMPOSER supplies a resolver that reads the store', async () => {
    // The link that was missing. Without it the other two are inert plumbing.
    const src = strip(
      await Bun.file(new URL('../../open/composer.ts', import.meta.url)).text(),
    )
    expect(src.includes('resolve_phase_models:')).toBe(true)
    expect(src.includes('readTridentPhaseModels(db, owner_handle)')).toBe(true)
  })

  it('the COMPOSER answers availability from the SAME resolvers the build uses', async () => {
    // A pane with its own notion of "configured" would grey the wrong option — or
    // offer a tier whose review then defers and blocks the merge for a reason the
    // owner cannot see.
    const src = strip(
      await Bun.file(new URL('../../open/composer.ts', import.meta.url)).text(),
    )
    const start = src.indexOf('const tridentPhaseModelsSurface = createTridentPhaseModelsSurface({')
    expect(start).toBeGreaterThan(-1)
    const block = src.slice(start, src.indexOf('\n    })', start))
    expect(block.includes('codexCredentialService.resolveActiveCodexHome')).toBe(true)
    // ALL THREE PRECONDITIONS OF "CAN CODEX RUN HERE", via the ONE function that
    // decides them (`codexExecutorAvailability` — credential, `codex` CLI, `perl`;
    // exits 10, 11 and 3 respectively). Asserted as the call rather than as the
    // conditions themselves precisely so the conditions live somewhere a test can
    // drive with a real PATH — `trident/codex-credential.test.ts` does exactly that.
    expect(block.includes('codexExecutorAvailability({')).toBe(true)
    expect(block.includes('env,')).toBe(true)
    // THE KIMI HALF IS UNTOUCHED BY THE BUILD MOVE, and it is asserted here so that
    // stays true: the pane's answer and the trident launch's come from the one
    // function, or a greyed row and a dispatching panelist disagree.
    expect(block.includes('kimi: kimiConfigured()')).toBe(true)
    expect(src.includes('resolve_kimi_configured: kimiConfigured')).toBe(true)
  })

  it('the HTTP surface is registered, not merely written', async () => {
    // A surface factory that no composer mounts is a route that 404s while its
    // tests pass.
    const src = strip(
      await Bun.file(new URL('../../open/composer.ts', import.meta.url)).text(),
    )
    expect(
      src.includes('app_trident_phase_models_surface: { handler: tridentPhaseModelsSurface.handler }'),
    ).toBe(true)
  })
})

describe('the HTTP surface', () => {
  const auth = { resolve: async () => ({ user_id: 'owner', project_slug: SCOPE }) } as never
  const surfaceFor = async (
    connections: { codex: CodexAvailability; kimi: boolean } = {
      codex: { usable: true },
      kimi: true,
    },
  ) => {
    const { createTridentPhaseModelsSurface } = await import(
      '@neutronai/gateway/http/trident-phase-models-surface.ts'
    )
    return createTridentPhaseModelsSurface({
      auth,
      read: (scope) => readTridentPhaseModelsWithRejected(db, scope),
      write: (scope, input) => writeTridentPhaseModels(db, scope, input),
      connections: () => connections,
    })
  }
  const req = (method: string, body?: unknown): Request =>
    new Request('http://x/api/app/trident/phase-models', {
      method,
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  it('GET carries the phase vocabulary, so neither client keeps its own copy', async () => {
    const s = await surfaceFor()
    const res = await s.handler(req('GET'))
    const json = (await res!.json()) as Record<string, unknown>
    const phases = json['phases'] as Array<{ key: string; label: string; description: string }>
    expect(phases.length).toBeGreaterThanOrEqual(7)
    expect(phases.some((p) => p.key === 'build')).toBe(true)
    // A row with no subtitle is a control whose meaning the owner has to guess.
    expect(phases.every((p) => p.description.length > 20)).toBe(true)
    expect(json['efforts']).toContain('xhigh')
    expect(json['overrides']).toEqual({})
    // Both cross-model review lanes are rows, not invisible parts of the pipeline.
    expect(phases.some((p) => p.key === 'review_codex')).toBe(true)
    expect(phases.some((p) => p.key === 'review_kimi')).toBe(true)
  })

  it('OMITS a follower phase — one step must not be two rows that disagree', async () => {
    // `build_mechanical` is the build step under the planner's internal `[mechanical]`
    // tag and takes `build`'s override when it has none of its own
    // (`TridentPhase.follows`). Rendered, it would show its own `sonnet` default while
    // the run dispatched the owner's codex tier — and "which of my two Build rows
    // applies" is not a question the owner has any way to answer.
    const s = await surfaceFor()
    const res = await s.handler(req('GET'))
    const json = (await res!.json()) as Record<string, unknown>
    const phases = json['phases'] as Array<{ key: string }>
    expect(phases.some((p) => p.key === 'build_mechanical')).toBe(false)
    // The filter must be the DECLARATION, not a hard-coded key: every phase the
    // registry does not mark as a follower is still a row.
    expect(phases.map((p) => p.key).sort()).toEqual(
      TRIDENT_PHASES.filter((p) => p.follows === undefined)
        .map((p) => p.key)
        .sort(),
    )
    // …and the key it follows IS one of the rows, or the setting it inherits could
    // never be made.
    expect(phases.some((p) => p.key === 'build')).toBe(true)
    // EVERY MAP IN THE PAYLOAD OMITS IT TOO, not just the row list. `defaults` keyed
    // by a phase with no row hands the clients a value they cannot render and the run
    // contradicts — and it is the same key inconsistency that let an override survive
    // below.
    expect(Object.keys(json['defaults'] as object)).toEqual(phases.map((p) => p.key))
  })

  it('a STORED follower override never reaches the client, and cannot be written', async () => {
    // THE BLOCKER THIS PINS, end to end through the real storage. The pane round-trips
    // whatever `overrides` it is sent: a `build_mechanical` entry stored by an older
    // build came back on every GET, went back out on every PUT, and kept the
    // `[mechanical]` half of the build dispatching on Anthropic after the owner moved
    // Build to codex — invisibly, because the row it belongs to is not drawn.
    //
    // WRITTEN THE ONLY WAY IT CAN EXIST NOW: straight into the metadata row, which is
    // exactly the shape of a value persisted before the rule.
    await db.run(
      `INSERT INTO instance_metadata (instance_slug, trident_phase_models) VALUES (?, ?)
         ON CONFLICT(instance_slug) DO UPDATE SET trident_phase_models = excluded.trident_phase_models`,
      [SCOPE, JSON.stringify({ build: { model: 'sol' }, build_mechanical: { model: 'sonnet' } })],
    )
    const s = await surfaceFor()
    const json = (await (await s.handler(req('GET')))!.json()) as Record<string, unknown>
    // The owner's real choice survives; the unrenderable one is gone from the payload.
    expect(json['overrides']).toEqual({ build: { model: 'sol' } })
    expect(JSON.stringify(json)).not.toContain('build_mechanical')

    // …and a client that sends one back is refused whole, by name, rather than
    // storing a pin no row can clear.
    const res = await s.handler(req('PUT', { overrides: { build_mechanical: { model: 'sonnet' } } }))
    expect(res!.status).toBe(400)
    expect(await res!.text()).toContain('build_mechanical')
    expect(readTridentPhaseModels(db, SCOPE)).toEqual({ build: { model: 'sol' } })
  })

  it('tells each row EVERY executor it can dispatch on, not just its default', async () => {
    // The field the greying rule reads. `group` alone was enough only while every
    // phase had exactly one executor; the build now has two, and a payload that sent
    // only `group` would leave both clients greying an option the run can honour.
    const s = await surfaceFor()
    const res = await s.handler(req('GET'))
    const json = (await res!.json()) as Record<string, unknown>
    const phases = json['phases'] as Array<{ key: string; group: string; groups: string[] }>
    const build = phases.find((p) => p.key === 'build')!
    expect(build.group).toBe('claude')
    expect(build.groups).toEqual(['claude', 'codex'])
    // A REVIEW SEAT IS A SLOT THE OWNER CAN EMPTY, so it offers `none` alongside
    // the executors that can fill it. A synthesis row is not a slot — the run
    // cannot proceed without it — so it offers exactly its own executor and no
    // `none`. **That asymmetry is the product decision, and it is why these two
    // rows are asserted separately rather than under one "single-executor" rule:**
    // an earlier version of this test predated `none` and read the two as the same
    // shape, which made it assert that a review seat could not be switched off.
    // Every row still includes its own default — a row that omitted it could not
    // offer the model it already runs (pinned by the loop below).
    expect(phases.find((p) => p.key === 'review_codex')!.groups).toEqual(['none', 'codex', 'kimi'])
    expect(phases.find((p) => p.key === 'synthesis')!.groups).toEqual(['claude'])
    expect(phases.find((p) => p.key === 'synthesis')!.groups).not.toContain('none')
    for (const p of phases) expect(p.groups).toContain(p.group)
  })

  it('RESOLVES every tier, so a row can name the model it will actually use', async () => {
    const s = await surfaceFor()
    const res = await s.handler(req('GET'))
    const json = (await res!.json()) as Record<string, unknown>
    const tiers = json['model_tiers'] as Array<Record<string, unknown>>
    // The tier is what the owner picks; the resolved id is what the build runs. A
    // pane showing only the tier cannot answer "which model is that today", and a
    // pane hardcoding the id needs an edit every time a tier's target moves.
    expect(tiers.find((t) => t['tier'] === 'sol')).toMatchObject({
      model_id: 'gpt-5.6-sol',
      group: 'codex',
      available: true,
    })
    const fast = tiers.find((t) => t['tier'] === 'fast')!
    expect(String(fast['model_id'])).toStartWith('claude-haiku')
    expect(fast['group']).toBe('claude')
  })

  it('says PER TIER whether picking it leaves the effort cell live', async () => {
    // `effort_supported` on a PHASE answers for its default executor. That was the
    // whole answer while every row had one; the build row has two, and a pane that
    // asked only the phase kept a live effort dropdown after the owner moved the row
    // to codex — then posted the effort alongside the model, and the server refused
    // the entire save. The per-tier flag is the missing half, derived here so the
    // rule is stated once rather than re-derived from `group` by each client.
    const s = await surfaceFor()
    const res = await s.handler(req('GET'))
    const json = (await res!.json()) as Record<string, unknown>
    const tiers = json['model_tiers'] as Array<Record<string, unknown>>
    const flag = (tier: string): unknown => tiers.find((t) => t['tier'] === tier)!['effort_supported']
    // An Anthropic tier is dispatched as `agent({model, effort})` and reads it.
    expect(flag('opus')).toBe(true)
    expect(flag('fast')).toBe(true)
    // A subprocess picks its own reasoning effort, whichever wrapper reaches it.
    expect(flag('sol')).toBe(false)
    expect(flag('terra')).toBe(false)
    // Every tier carries the field — a missing one reads as `false` in a client and
    // would silently disable a control that works.
    for (const t of tiers) expect(typeof t['effort_supported']).toBe('boolean')
    // The BUILD row keeps its phase-level answer, which is the pair the clients
    // combine: true here, false on `sol`, and the cell is live only when both are.
    const phases = json['phases'] as Array<Record<string, unknown>>
    expect(phases.find((p) => p['key'] === 'build')!['effort_supported']).toBe(true)
    expect(phases.find((p) => p['key'] === 'review_codex')!['effort_supported']).toBe(false)
  })

  it('shows an unrunnable tier DISABLED WITH THE REASON, never omitted', async () => {
    // The install that cannot run codex — no credential, or no CLI. Dropping those
    // options would leave the owner unable to account for a missing choice, which is
    // how a whole capability stayed invisible for weeks (ISSUES #551).
    const s = await surfaceFor({
      codex: { usable: false, reason: 'needs a Codex connection' },
      kimi: false,
    })
    const res = await s.handler(req('GET'))
    const json = (await res!.json()) as Record<string, unknown>
    const tiers = json['model_tiers'] as Array<Record<string, unknown>>
    for (const tier of ['sol', 'terra', 'luna']) {
      expect(tiers.find((t) => t['tier'] === tier)).toMatchObject({
        available: false,
        unavailable_reason: 'needs a Codex connection',
      })
    }
    // …and each credential answers for its OWN tiers: the reason names the thing to
    // go and set up, so a shared string would send a Kimi owner to connect Codex.
    expect(tiers.find((t) => t['tier'] === 'k3')).toMatchObject({
      available: false,
      unavailable_reason: 'needs a Kimi key',
    })
    // The Claude tiers need nothing and stay selectable.
    expect(tiers.find((t) => t['tier'] === 'opus')!['available']).toBe(true)
  })

  it('the codex reason is the CALLER\'S, so a missing CLI does not read as a missing login', async () => {
    // THE DEFECT THIS PINS. Codex needs a credential, the `codex` CLI and `perl`, and
    // the wrapper hard-fails on each. The pane used to answer "needs a Codex
    // connection" for all three, so an owner whose login was fine ran `codex login`,
    // watched it succeed, and was exactly where they started. The surface must not own
    // that sentence at all — it renders whichever one the availability check produced.
    const s = await surfaceFor({
      codex: { usable: false, reason: 'needs the Codex CLI installed on this machine' },
      kimi: true,
    })
    const json = (await (await s.handler(req('GET')))!.json()) as Record<string, unknown>
    const tiers = json['model_tiers'] as Array<Record<string, unknown>>
    expect(tiers.find((t) => t['tier'] === 'sol')).toMatchObject({
      available: false,
      unavailable_reason: 'needs the Codex CLI installed on this machine',
    })
    // And no tier is ever unavailable without saying why — `available` is DERIVED from
    // the reason, so the two cannot disagree.
    for (const t of tiers) {
      expect(t['available']).toBe(t['unavailable_reason'] === null)
    }
  })

  it('hands back a REFUSED stored value so the row can show what was dropped', async () => {
    // Written straight past the validator, as a build predating the tier registry
    // could have: a literal vendor id where a tier is now required.
    await db.run(
      `INSERT INTO instance_metadata (instance_slug, trident_phase_models) VALUES (?, ?)`,
      [SCOPE, JSON.stringify({ build: { model: 'gpt-5.6-sol' } })],
    )
    const s = await surfaceFor()
    const res = await s.handler(req('GET'))
    const json = (await res!.json()) as Record<string, unknown>
    // Not applied…
    expect(json['overrides']).toEqual({})
    // …and not silently forgotten either: the pane strikes it through and names the
    // default it fell back to.
    expect(json['rejected']).toEqual({ build: { model: 'gpt-5.6-sol' } })
  })

  it('PUT stores a valid set and echoes it back', async () => {
    const s = await surfaceFor()
    const res = await s.handler(req('PUT', { overrides: { build: { effort: 'xhigh' } } }))
    expect(res!.status).toBe(200)
    const json = (await res!.json()) as Record<string, unknown>
    expect(json['overrides']).toEqual({ build: { effort: 'xhigh' } })
  })

  it('PUT rejects an invalid set with 400 and names every problem', async () => {
    const s = await surfaceFor()
    const res = await s.handler(
      req('PUT', { overrides: { build: { effort: 'ultra' }, nope: { model: 'x' } } }),
    )
    expect(res!.status).toBe(400)
    const body = await res!.text()
    // Both, not just the first — fixing a config one rejected field per round trip
    // is worse than the silent drop this rejection exists to prevent.
    expect(body).toContain('ultra')
    expect(body).toContain('nope')
    expect(readTridentPhaseModels(db, SCOPE)).toEqual({})
  })

  it('PUT with NO overrides key is a 400, not an accidental wipe', async () => {
    await writeTridentPhaseModels(db, SCOPE, { build: { model: 'opus' } })
    const s = await surfaceFor()
    const res = await s.handler(req('PUT', { something_else: 1 }))
    expect(res!.status).toBe(400)
    // An absent key is ambiguous between "clear everything" and "the client forgot
    // the field"; clearing every pin by accident is not a mistake to make possible.
    expect(readTridentPhaseModels(db, SCOPE)).toEqual({ build: { model: 'opus' } })
  })

  it('PUT with an EXPLICIT empty object clears', async () => {
    await writeTridentPhaseModels(db, SCOPE, { build: { model: 'opus' } })
    const s = await surfaceFor()
    const res = await s.handler(req('PUT', { overrides: {} }))
    expect(res!.status).toBe(200)
    expect(readTridentPhaseModels(db, SCOPE)).toEqual({})
  })

  it('ignores a path it does not own', async () => {
    const s = await surfaceFor()
    const res = await s.handler(
      new Request('http://x/api/app/other', { headers: { authorization: 'Bearer t' } }),
    )
    expect(res).toBeNull()
  })
})
