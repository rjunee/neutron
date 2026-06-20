/**
 * Action 3 — project shells tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import action03 from '../03-project-shells.ts'
import { buildContext, makeFixture, teardown, type TestFixture } from '../../__tests__/test-helpers.ts'
import type { ImportResult } from '../../../history-import/types.ts'

let fix: TestFixture

beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

function emptyImport(): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
  }
}

describe('action 03-project-shells', () => {
  test('does not fire when fewer than 2 distinct projects', () => {
    expect(action03.triggerCondition(buildContext(fix))).toBe(false)
    const ctx = buildContext(fix, { captured_projects: [{ name: 'one' }] })
    expect(action03.triggerCondition(ctx)).toBe(false)
  })

  test('fires when interview captured ≥ 2 projects', () => {
    const ctx = buildContext(fix, {
      captured_projects: [{ name: 'Acme' }, { name: 'Topline' }],
    })
    expect(action03.triggerCondition(ctx)).toBe(true)
  })

  test('fires when import has ≥ 2 proposed projects', () => {
    const ir = emptyImport()
    ir.proposed_projects = [
      { name: 'a', rationale: 'r', suggested_topics: [] },
      { name: 'b', rationale: 'r', suggested_topics: [] },
    ]
    const ctx = buildContext(fix, { import_result: ir })
    expect(action03.triggerCondition(ctx)).toBe(true)
  })

  test('dedupes captured projects case-insensitively (single source)', () => {
    // 2026-05-28 — captured_projects is the authoritative source when
    // populated; the pre-fix dedup-across-sources behavior is gone
    // (any project in `import_result` that the user dropped at
    // `projects_proposed` would otherwise resurrect here). The
    // single-source case-insensitive dedup is still meaningful for
    // pathological inputs.
    const ctx = buildContext(fix, {
      captured_projects: [
        { name: 'topline' },
        { name: 'TOPLINE' },
        { name: 'Northwind' },
      ],
    })
    expect(action03.triggerCondition(ctx)).toBe(true)
  })

  test('inserts every confirmed project (no cap) — shells created SILENTLY (GAP3)', async () => {
    // 2026-05-28 sprint — the legacy 5-project cap was a re-filter at
    // the wow-action layer that silently dropped projects the user
    // explicitly confirmed at `projects_proposed`. The brief is
    // explicit: respect `primary_projects_confirmed` verbatim through
    // every downstream emit. This test pins the new behavior — 7
    // captured (mirrors Sam's 2026-05-28 walkthrough) all land.
    //
    // GAP3 (onboarding-wow-handoff-fix, 2026-06-09): the action no longer
    // emits a chat receipt. Shells are created silently (DB rows below);
    // the engine's final-handoff GUIDE is the single terminal General
    // message. The created list rides out on `redacted_payload.created_names`.
    const ctx = buildContext(fix, {
      captured_projects: [
        { name: 'Topline' },
        { name: 'Northwind Labs' },
        { name: 'Acme' },
        { name: 'Acme Holdco' },
        { name: 'n8n Automation' },
        { name: 'Home Assistant' },
        { name: 'LA Property' },
      ],
    })
    const result = await action03.run(ctx)
    expect(result.fired).toBe(true)
    expect(result.reason).toBe('shells_created')
    expect(result.redacted_payload?.count).toBe(7)
    // No chat receipt is emitted (GAP3) — but the DB shells are still written.
    expect(fix.channelCalls.prompts.length).toBe(0)
    expect(result.follow_up_prompt_id).toBeUndefined()
    expect((result.redacted_payload?.created_names as string[]).length).toBe(7)
    const rows = fix.db
      .raw()
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM topics WHERE channel_topic_id LIKE 'wow-shell-%'`,
      )
      .get()
    expect(rows?.count).toBe(7)
  })

  test('confirmed captured_projects is authoritative — import_result merge is skipped', async () => {
    // Pre-fix `mergedProjects` appended every `import_result` entry not
    // already in captured_projects. When the user dropped a project at
    // `projects_proposed` via freeform amend, that project still lived
    // in `import_result.proposed_projects` and silently resurrected
    // here. Fix: when the dispatcher signals `projects_confirmed: true`
    // the import_result merge is skipped — the user's confirmed list
    // is verbatim.
    const ir = emptyImport()
    ir.proposed_projects = [
      { name: 'Resurrected', rationale: 'user explicitly dropped this', suggested_topics: [] },
    ]
    const ctx = {
      ...buildContext(fix, {
        captured_projects: [{ name: 'Confirmed-A' }, { name: 'Confirmed-B' }],
        import_result: ir,
      }),
      projects_confirmed: true,
    }
    const result = await action03.run(ctx)
    expect(result.fired).toBe(true)
    expect(result.redacted_payload?.count).toBe(2)
    // GAP3 — no chat receipt; assert the created set via created_names.
    const created = result.redacted_payload?.created_names as string[]
    expect(created).toContain('Confirmed-A')
    expect(created).toContain('Confirmed-B')
    expect(created).not.toContain('Resurrected')
  })

  test('legacy unconfirmed shape merges captured + import_result (Codex r2 contract preservation)', async () => {
    // Codex review pickup r2: when `projects_confirmed` is unset
    // (legacy m2-casey-style fixtures, pre-confirm flows) the action
    // must preserve the pre-fix merge contract. Captured + import are
    // deduped together so a fixture with 1 captured + 2 imported still
    // triggers (1-captured-only is < MIN_PROJECTS = 2).
    const ir = emptyImport()
    ir.proposed_projects = [
      { name: 'Imported-A', rationale: '', suggested_topics: [] },
      { name: 'Imported-B', rationale: '', suggested_topics: [] },
    ]
    const ctx = buildContext(fix, {
      captured_projects: [{ name: 'Captured-X' }],
      import_result: ir,
    })
    expect(action03.triggerCondition(ctx)).toBe(true)
    const result = await action03.run(ctx)
    expect(result.fired).toBe(true)
    expect(result.redacted_payload?.count).toBe(3)
    // GAP3 — no chat receipt; assert the created set via created_names.
    const created = result.redacted_payload?.created_names as string[]
    expect(created).toContain('Captured-X')
    expect(created).toContain('Imported-A')
    expect(created).toContain('Imported-B')
  })

  test('falls back to import_result when captured_projects is empty AND not confirmed (legacy contract)', async () => {
    // Zero-confirm / pre-confirm flows: when the engine has not yet
    // populated `captured_projects` AND the user never reached
    // confirmation, fall back to the import-derived candidate set so
    // the trigger still fires.
    const ir = emptyImport()
    ir.proposed_projects = [
      { name: 'Fallback-A', rationale: '', suggested_topics: [] },
      { name: 'Fallback-B', rationale: '', suggested_topics: [] },
    ]
    const ctx = buildContext(fix, { import_result: ir })
    const result = await action03.run(ctx)
    expect(result.fired).toBe(true)
    expect(result.redacted_payload?.count).toBe(2)
  })

  test('deliberate zero-project confirmation skips the import fallback', async () => {
    // Codex review pickup: `PROJECTS_PROPOSED_SKIP_AHEAD` writes
    // `primary_projects_confirmed: []` — the user explicitly declined
    // the import-derived list. Pre-fix `captured_projects.length === 0`
    // was indistinguishable from "never reached confirmation," so the
    // import fallback fired and shells got created anyway. With
    // `projects_confirmed: true` flowing through, the action correctly
    // short-circuits.
    const ir = emptyImport()
    ir.proposed_projects = [
      { name: 'Declined-A', rationale: '', suggested_topics: [] },
      { name: 'Declined-B', rationale: '', suggested_topics: [] },
    ]
    // buildContext doesn't yet accept projects_confirmed via overrides;
    // patch the produced context directly so we don't widen the
    // helper surface for one edge case.
    const ctx = { ...buildContext(fix, { import_result: ir }), projects_confirmed: true }
    expect(action03.triggerCondition(ctx)).toBe(false)
    const result = await action03.run(ctx)
    expect(result.fired).toBe(false)
    expect(result.reason).toBe('all_failed')
    // No INSERT happens because the run loop sees zero projects.
    const rows = fix.db
      .raw()
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM topics WHERE channel_topic_id LIKE 'wow-shell-%'`,
      )
      .get()
    expect(rows?.count).toBe(0)
  })

  test('shells are created with NO chat receipt at all (GAP3 — guide owns the terminal message)', async () => {
    // 2026-05-28 sprint — Sam called out that the
    // "Keep all / Drop one / Drop all" keyboard is useless on this
    // emit. GAP3 (2026-06-09) goes further: the action emits NO chat
    // message at all. The receipt ("I created shells for these projects…
    // Let me know if any of these need changing.") contended with the
    // final-handoff GUIDE for the terminal General slot and ended in a
    // pointless question. The engine's guide is now the single terminal
    // message; the shells are created silently here.
    const ctx = buildContext(fix, {
      captured_projects: [{ name: 'A' }, { name: 'B' }],
    })
    const result = await action03.run(ctx)
    expect(result.fired).toBe(true)
    // Zero prompts emitted — the receipt is gone.
    expect(fix.channelCalls.prompts.length).toBe(0)
    expect(result.follow_up_prompt_id).toBeUndefined()
    // The "let me know if any of these need changing" copy must not appear
    // in ANY emitted text (there is none).
    const allText = fix.channelCalls.prompts.map((p) => p.prompt.body).join('\n')
    expect(allText).not.toContain('Let me know if any of these need changing.')
  })

  test('engagement decoder (back-compat for in-flight legacy prompts)', () => {
    expect(action03.decodeEngagement?.('kept')).toBe('kept')
    expect(action03.decodeEngagement?.('tweaked')).toBe('tweaked')
    expect(action03.decodeEngagement?.('skipped')).toBe('skipped')
  })
})

// ISSUES #95 — project shells must be REAL projects, not bare cli topics.
// These are the reproduce-first assertions: a `projects` row per confirmed
// project, idempotent across re-runs, with orphan cleanup + honest metrics.
describe('action 03-project-shells — real projects (ISSUES #95)', () => {
  function countProjects(fix: TestFixture): number {
    return (
      fix.db
        .raw()
        .query<{ count: number }, []>(`SELECT COUNT(*) as count FROM projects`)
        .get()?.count ?? 0
    )
  }
  function countShellTopics(fix: TestFixture): number {
    return (
      fix.db
        .raw()
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM topics WHERE channel_topic_id LIKE 'wow-shell-%'`,
        )
        .get()?.count ?? 0
    )
  }

  test('creates a real `projects` row (name + description + bound topic) per confirmed project', async () => {
    const ctx = buildContext(fix, {
      captured_projects: [
        { name: 'Northwind', rationale: 'DTC supplement brand launch' },
        { name: 'Topline' },
        { name: 'Acme' },
      ],
    })
    const result = await action03.run(ctx)
    expect(result.fired).toBe(true)

    const rows = fix.db
      .raw()
      .query<
        { id: string; name: string; description: string | null; topic_id: string | null },
        []
      >(`SELECT id, name, description, topic_id FROM projects ORDER BY name`)
      .all()
    // One named row per confirmed project — this is the core #95 fix.
    expect(rows.map((r) => r.name).sort()).toEqual(['Acme', 'Northwind', 'Topline'])
    // Every row carries non-empty synthesized context. `projects.topic_id`
    // stays NULL — it's the Telegram message_thread_id (migration 0053),
    // not the cli-shell binding marker (that's the wow-shell topic below).
    for (const r of rows) {
      expect(r.topic_id).toBeNull()
      expect((r.description ?? '').length).toBeGreaterThan(0)
    }
    // The captured rationale flows into the at-rest context.
    const northwind = rows.find((r) => r.name === 'Northwind')
    expect(northwind?.description).toContain('DTC supplement brand launch')

    // Each project has a bound `wow-shell-<id>` cli topic pointing back at it.
    for (const r of rows) {
      const topic = fix.db
        .raw()
        .query<{ project_id: string }, [string]>(
          `SELECT project_id FROM topics
             WHERE channel_kind = 'cli' AND channel_topic_id = ?`,
        )
        .get(`wow-shell-${r.id}`)
      expect(topic?.project_id).toBe(r.id)
    }
  })

  test('project_id is the deterministic slug (converges with the handoff seed identity)', async () => {
    const { slugifyProjectId } = await import('../../project-identity.ts')
    const ctx = buildContext(fix, {
      captured_projects: [{ name: 'Northwind Labs' }, { name: 'Acme Holdco' }],
    })
    await action03.run(ctx)
    const ids = fix.db
      .raw()
      .query<{ id: string }, []>(`SELECT id FROM projects ORDER BY id`)
      .all()
      .map((r) => r.id)
    expect(ids).toEqual(
      [slugifyProjectId('Northwind Labs'), slugifyProjectId('Acme Holdco')].sort(),
    )
  })

  test('idempotent — a second run does not duplicate projects or topics', async () => {
    const captured = [{ name: 'Topline' }, { name: 'Northwind' }, { name: 'Acme' }]
    const first = await action03.run(buildContext(fix, { captured_projects: captured }))
    expect(first.redacted_payload?.created).toBe(3)
    expect(countProjects(fix)).toBe(3)
    expect(countShellTopics(fix)).toBe(3)

    // Re-fire (session restart / overnight-pass re-trigger) — no dupes.
    const second = await action03.run(buildContext(fix, { captured_projects: captured }))
    expect(countProjects(fix)).toBe(3)
    expect(countShellTopics(fix)).toBe(3)
    // Honest metrics: nothing new was created on the second run.
    expect(second.redacted_payload?.created).toBe(0)
    expect(second.redacted_payload?.existing).toBe(3)
  })

  test('cleans up legacy orphan wow-shell topics (no matching projects row)', async () => {
    // Simulate the prod state: pre-#95 code left bare cli topics with a
    // random project_id and NO projects row.
    const now = 1_700_000_000
    for (let i = 0; i < 4; i += 1) {
      const orphan = `orphan-${i}`
      fix.db
        .raw()
        .run(
          `INSERT INTO topics (id, project_slug, project_id, channel_kind, channel_topic_id, privacy_mode, status, created_at, updated_at)
           VALUES (?, 't1', ?, 'cli', ?, 'regular', 'active', ?, ?)`,
          [`t-${orphan}`, orphan, `wow-shell-${orphan}`, now, now],
        )
    }
    expect(countShellTopics(fix)).toBe(4)

    const ctx = buildContext(fix, {
      captured_projects: [{ name: 'Topline' }, { name: 'Northwind' }],
    })
    await action03.run(ctx)

    // Orphans gone, only the 2 real (projects-backed) shells remain.
    expect(countProjects(fix)).toBe(2)
    expect(countShellTopics(fix)).toBe(2)
    const remaining = fix.db
      .raw()
      .query<{ project_id: string }, []>(
        `SELECT project_id FROM topics WHERE channel_topic_id LIKE 'wow-shell-%'`,
      )
      .all()
    for (const t of remaining) {
      const proj = fix.db
        .raw()
        .query<{ id: string }, [string]>(`SELECT id FROM projects WHERE id = ?`)
        .get(t.project_id)
      expect(proj).not.toBeNull()
    }
  })

  test('honest metrics — redacted_payload reports created/existing/failures', async () => {
    const ctx = buildContext(fix, {
      captured_projects: [{ name: 'Topline' }, { name: 'Northwind' }],
    })
    const result = await action03.run(ctx)
    expect(result.redacted_payload?.created).toBe(2)
    expect(result.redacted_payload?.existing).toBe(0)
    expect(result.redacted_payload?.failure_count).toBe(0)
  })

  test('binds + corrects a pre-seeded demo row (topic_id NULL) instead of ignoring it', async () => {
    // Production `seedDefaults` materializes demo rows (neutron/acme/
    // northwind) with topic_id NULL. Sam's real instance confirmed
    // "Northwind" + "Acme" — which slug EXACTLY to the demo ids — so
    // the action must BIND + CORRECT the demo row (name/description/topic_id)
    // rather than INSERT-OR-IGNORE leaving the generic demo placeholder
    // unbound + mis-described.
    const iso = new Date(1_700_000_000_000).toISOString()
    fix.db
      .raw()
      .run(
        `INSERT INTO projects (id, name, description, persona, privacy_mode, billing_mode, created_at, updated_at)
         VALUES ('northwind', 'Northwind Demo Placeholder', 'demo default', NULL, 'private', 'personal', ?, ?)`,
        [iso, iso],
      )
    const ctx = buildContext(fix, {
      captured_projects: [
        { name: 'Northwind', rationale: 'DTC supplement brand' },
        { name: 'Topline' },
      ],
    })
    const result = await action03.run(ctx)
    expect(result.redacted_payload?.created).toBe(2) // demo-bind counts as created

    const row = fix.db
      .raw()
      .query<{ name: string; description: string | null; topic_id: string | null }, [string]>(
        `SELECT name, description, topic_id FROM projects WHERE id = ?`,
      )
      .get('northwind')
    expect(row?.name).toBe('Northwind') // demo placeholder name corrected
    expect(row?.description).toContain('DTC supplement brand')
    expect(row?.topic_id).toBeNull() // projects.topic_id reserved for telegram thread id
    // Binding is the wow-shell cli topic, which points back at the project.
    const topic = fix.db
      .raw()
      .query<{ project_id: string }, [string]>(
        `SELECT project_id FROM topics
           WHERE channel_kind = 'cli' AND channel_topic_id = ?`,
      )
      .get('wow-shell-northwind')
    expect(topic?.project_id).toBe('northwind')
  })

  test('confirmed name matching an UNBOUND seed row of a DIFFERENT id binds it (no duplicate)', async () => {
    // THE #95 BLOCKER: the boot seed (`KNOWN_PROJECTS`) inserts id
    // `northwind` with name "Northwind Labs". "Northwind Labs" slugifies to
    // `northwind-labs` ≠ `northwind`, so keying only on the slug missed the
    // seed row and minted a SECOND live "Northwind Labs" (id `northwind-labs`)
    // while the unbound seed lingered. The fix resolves the unbound seed by
    // normalized name and binds IT — one row, not two.
    const iso = new Date(1_700_000_000_000).toISOString()
    fix.db
      .raw()
      .run(
        `INSERT INTO projects (id, name, description, persona, privacy_mode, billing_mode, created_at, updated_at)
         VALUES ('northwind', 'Northwind Labs', 'Northwind Labs — supplement formulation + brand assets.', NULL, 'private', 'personal', ?, ?)`,
        [iso, iso],
      )
    const ctx = buildContext(fix, {
      captured_projects: [
        { name: 'Northwind Labs', rationale: 'DTC supplement brand' },
        { name: 'Topline' },
      ],
    })
    const result = await action03.run(ctx)
    expect(result.redacted_payload?.created).toBe(2)

    // EXACTLY ONE "Northwind Labs" row — the seed `northwind`, now bound. No
    // second `northwind-labs` row was minted.
    const northwindRows = fix.db
      .raw()
      .query<{ id: string }, [string]>(`SELECT id FROM projects WHERE name = ?`)
      .all('Northwind Labs')
    expect(northwindRows.map((r) => r.id)).toEqual(['northwind'])
    const labsRow = fix.db
      .raw()
      .query<{ id: string }, [string]>(`SELECT id FROM projects WHERE id = ?`)
      .get('northwind-labs')
    expect(labsRow ?? null).toBeNull()
    // The seed row's description was corrected to the confirmed rationale.
    const seed = fix.db
      .raw()
      .query<{ description: string | null }, [string]>(
        `SELECT description FROM projects WHERE id = ?`,
      )
      .get('northwind')
    expect(seed?.description).toContain('DTC supplement brand')
    // It's bound to a `wow-shell-northwind` cli topic.
    const topic = fix.db
      .raw()
      .query<{ project_id: string }, [string]>(
        `SELECT project_id FROM topics
           WHERE channel_kind = 'cli' AND channel_topic_id = ?`,
      )
      .get('wow-shell-northwind')
    expect(topic?.project_id).toBe('northwind')

    // Idempotent: a second run binds the same seed row, no new duplicate.
    await action03.run(ctx)
    const after = fix.db
      .raw()
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) as count FROM projects WHERE name = ?`,
      )
      .get('Northwind Labs')
    expect(after?.count).toBe(1)
  })

  test('never clobbers an already-bound project on re-fire (overnight pass safety)', async () => {
    // A real bound project the user later renamed must survive the daily
    // overnight-pass re-dispatch unchanged.
    const ctx = buildContext(fix, {
      captured_projects: [{ name: 'Topline' }, { name: 'Northwind' }],
    })
    await action03.run(ctx)
    // User renames the project + edits its description out-of-band.
    fix.db
      .raw()
      .run(`UPDATE projects SET name = 'Topline (renamed)', description = 'user edit' WHERE id = 'topline'`)
    // Overnight re-fire.
    const second = await action03.run(ctx)
    expect(second.redacted_payload?.created).toBe(0)
    expect(second.redacted_payload?.existing).toBe(2)
    const row = fix.db
      .raw()
      .query<{ name: string; description: string | null }, [string]>(
        `SELECT name, description FROM projects WHERE id = ?`,
      )
      .get('topline')
    expect(row?.name).toBe('Topline (renamed)') // NOT clobbered
    expect(row?.description).toBe('user edit')
  })

  test('a soft-deleted slug row is NOT bound, resurrected, or reported created (#95 Argus r2)', async () => {
    // THE r2 BLOCKER: resolveBindTarget's byId lookup (and the mirror
    // existingRow query in reconcileProject) lacked `deleted_at IS NULL`.
    // On the DAILY overnight re-fire, a user who soft-deleted an onboarding
    // project whose id == slug of a re-confirmed name (e.g. deleted
    // "Northwind Labs", id `northwind-labs`) would have the deleted row bound
    // as the shell target: reconcileProject reported it created/present and
    // re-INSERTed a wow-shell topic on a row that stays HIDDEN behind the
    // /api/app/projects `deleted_at IS NULL` filter — so the wow body claimed
    // "I created a shell for X" while X never appeared in the sidebar
    // (ships-as-no-op-logging-success). Honest fix: the slug `id` is the PK,
    // so a fresh visible row can't be minted on top of the deleted one
    // (INSERT OR IGNORE would silently collide); we instead SKIP it — the
    // user deleted it, we honor that, and the body never mentions it.
    const { slugifyProjectId } = await import('../../project-identity.ts')
    const slug = slugifyProjectId('Northwind Labs')
    const iso = new Date(1_700_000_000_000).toISOString()
    // Pre-seed a SOFT-DELETED row at the exact slug the confirmed name maps to.
    fix.db
      .raw()
      .run(
        `INSERT INTO projects (id, name, description, persona, privacy_mode, billing_mode, created_at, updated_at, deleted_at)
         VALUES (?, 'Northwind Labs (deleted)', 'user soft-deleted this', NULL, 'private', 'personal', ?, ?, ?)`,
        [slug, iso, iso, iso],
      )
    const ctx = buildContext(fix, {
      captured_projects: [
        { name: 'Northwind Labs', rationale: 'DTC supplement brand' },
        { name: 'Topline' },
      ],
    })
    const result = await action03.run(ctx)
    // Only Topline is honestly created — Northwind Labs is skipped (absent), so
    // metrics do NOT claim a shell that the sidebar can't show.
    expect(result.redacted_payload?.created).toBe(1)
    expect(result.redacted_payload?.count).toBe(1)

    // The soft-deleted row is UNTOUCHED — name/description NOT clobbered (no
    // resurrection), and it stays soft-deleted (hidden behind the filter).
    const deletedRow = fix.db
      .raw()
      .query<{ name: string; description: string | null; deleted_at: string | null }, [string]>(
        `SELECT name, description, deleted_at FROM projects WHERE id = ?`,
      )
      .get(slug)
    expect(deletedRow?.name).toBe('Northwind Labs (deleted)')
    expect(deletedRow?.description).toBe('user soft-deleted this')
    expect(deletedRow?.deleted_at).not.toBeNull()

    // No VISIBLE "Northwind Labs" row exists — honestly absent, not a hidden
    // claim. (The slug row remains the single soft-deleted one.)
    const visible = fix.db
      .raw()
      .query<{ id: string }, []>(
        `SELECT id FROM projects WHERE name = 'Northwind Labs' AND deleted_at IS NULL`,
      )
      .all()
    expect(visible.length).toBe(0)
    // No wow-shell topic was bound to the soft-deleted slug row.
    const ghostTopic = fix.db
      .raw()
      .query<{ project_id: string }, [string]>(
        `SELECT project_id FROM topics
           WHERE channel_kind = 'cli' AND channel_topic_id = ?`,
      )
      .get(`wow-shell-${slug}`)
    expect(ghostTopic ?? null).toBeNull()
    // Topline DID get a real visible row + bound shell — the skip is surgical.
    const tabs = fix.db
      .raw()
      .query<{ id: string }, []>(
        `SELECT id FROM projects WHERE name = 'Topline' AND deleted_at IS NULL`,
      )
      .all()
    expect(tabs.length).toBe(1)
  })

  test('slug collision between two confirmed names does not over-report', async () => {
    // "Home/Assistant" and "Home Assistant" both slug to "home-assistant".
    const ctx = buildContext(fix, {
      captured_projects: [{ name: 'Home/Assistant' }, { name: 'Home Assistant' }, { name: 'Topline' }],
    })
    const result = await action03.run(ctx)
    // Two distinct projects, not three — the collision is deduped.
    expect(result.redacted_payload?.count).toBe(2)
    const count = fix.db
      .raw()
      .query<{ count: number }, []>(`SELECT COUNT(*) as count FROM projects`)
      .get()?.count
    expect(count).toBe(2)
  })
})
