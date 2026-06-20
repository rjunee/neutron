/**
 * Unit tests — onboarding/telemetry/event-emitter (P2 S6).
 *
 * Per docs/plans/P2-onboarding.md § 5 + § 9.5. Asserts:
 *   - every event in OnboardingEventName emits a JSON line via mock logger
 *     AND inserts a row into gateway_events
 *   - per-event payload type narrowing works (TS-level — covered by file
 *     compiling) and JSON round-trips faithfully
 *   - module is derived from event-name routing (signup.* → signup;
 *     onboarding.* → onboarding)
 *   - duration_ms is optional and round-trips when set
 *   - structured-JSON sink failure does NOT roll back the SQL row
 *   - the migration's CREATE VIEW body matches
 *     onboarding-metrics-view.sql (drift guard)
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import {
  ALL_ONBOARDING_EVENT_NAMES,
  OnboardingTelemetry,
  buildStdoutEventLogger,
  moduleForEventName,
  type EventLogger,
  type OnboardingEvent,
  type PersistedOnboardingEvent,
} from '../event-emitter.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'event-emitter-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function deterministicUuid(): () => string {
  let n = 0
  return (): string => {
    n += 1
    const hex = n.toString(16).padStart(8, '0')
    return `${hex}-${hex.slice(0, 4)}-4${hex.slice(0, 3)}-8${hex.slice(0, 3)}-${hex.padEnd(12, '0')}`
  }
}

/** Build one event of each name with realistic payloads so the table
 *  insert exercises every code path. */
function eventForName(name: typeof ALL_ONBOARDING_EVENT_NAMES[number]): OnboardingEvent {
  const base = { project_slug: 't1', user_id: 'u1', ts: 1_700_000_000_000 }
  switch (name) {
    case 'signup.started':
      return { ...base, event: name, payload: { via: 'tg' } }
    case 'signup.oauth_complete':
      return { ...base, event: name, payload: { provider: 'google', oauth_user_id: 'oid' } }
    case 'signup.instance_provisioned':
      return { ...base, event: name, payload: { slug: 't1', tier: 'managed-shared', durationMs: 1000 } }
    case 'onboarding.phase_advanced':
      return { ...base, event: name, payload: { from: 'signup', to: 'agent_name_chosen' } }
    case 'onboarding.button_emitted':
      return {
        ...base,
        event: name,
        payload: { prompt_id: 'p1', idempotency_collapsed: false, options_count: 3 },
      }
    case 'onboarding.button_chosen':
      return { ...base, event: name, payload: { prompt_id: 'p1', choice_value: 'a', latency_ms: 5_000 } }
    case 'onboarding.button_freeform':
      return { ...base, event: name, payload: { prompt_id: 'p1', freeform_length: 42 } }
    case 'onboarding.button_timeout':
      return { ...base, event: name, payload: { prompt_id: 'p1' } }
    case 'onboarding.import_started':
      return { ...base, event: name, payload: { source: 'chatgpt-zip', payload_size_bytes: 12345 } }
    case 'onboarding.import_pass1_chunk_done':
      return {
        ...base,
        event: name,
        payload: { source: 'chatgpt-zip', chunk_index: 0, chunk_dollars: 0.05 },
      }
    case 'onboarding.import_pass2_complete':
      return {
        ...base,
        event: name,
        payload: { source: 'chatgpt-zip', total_dollars: 0.5, entities: 10, projects: 3, tasks: 5 },
      }
    case 'onboarding.archetype_picked':
      return { ...base, event: name, payload: { archetype_slugs: ['athena'], used_llm_extension: false } }
    case 'onboarding.archetype_llm_extension':
      return { ...base, event: name, payload: { archetype_name: 'Beethoven', cache_hit: false } }
    case 'onboarding.persona_drafted':
      return { ...base, event: name, payload: { draft_id: 'd1', files: ['soul', 'user', 'priority_map'] } }
    case 'onboarding.persona_cringe_flagged':
      return { ...base, event: name, payload: { file: 'soul', flags: 5, reasons: ['em-dash'] } }
    case 'onboarding.persona_regen':
      return { ...base, event: name, payload: { file: 'soul', attempt: 1 } }
    case 'onboarding.persona_committed':
      return { ...base, event: name, payload: { draft_id: 'd1', git_sha: 'abc' } }
    case 'onboarding.profile_pic_generated':
      return { ...base, event: name, payload: { job_id: 'pp1', candidate_count: 3 } }
    case 'onboarding.profile_pic_user_uploaded':
      return { ...base, event: name, payload: { job_id: 'pp1' } }
    case 'onboarding.profile_pic_fallback':
      return { ...base, event: name, payload: { job_id: 'pp1', archetype_slug: 'athena' } }
    case 'onboarding.wow_dispatched':
      return { ...base, event: name, payload: { fired_count: 7, total_actions: 7 } }
    case 'onboarding.wow_action_fired':
      return { ...base, event: name, payload: { action_id: '01-first-week-brief', success: true } }
    case 'onboarding.wow_action_engaged':
      return { ...base, event: name, payload: { action_id: '01-first-week-brief', engagement: 'tapped' } }
    case 'onboarding.wow_action_skipped':
      return { ...base, event: name, payload: { action_id: '05-followup-email-draft', reason: 'scope_missing' } }
    case 'onboarding.completed':
      return {
        ...base,
        event: name,
        payload: {
          time_to_wow_ms: 30 * 60 * 1000,
          total_dollars: 1.25,
          wow_actions_fired: ['01-first-week-brief', '02-lifestyle-reminders'],
        },
      }
    case 'onboarding.abandoned':
      return { ...base, event: name, payload: { last_phase: 'personality_offered', gap_ms: 86_400_000 } }
    case 'onboarding.failed':
      return { ...base, event: name, payload: { phase: 'persona_review', reason: 'cringe_cap_exceeded' } }
    case 'onboarding.sean_ellis_prompt_emitted':
      return { ...base, event: name, payload: { prompt_id: 'sp1', weeks_since_completed: 4 } }
    case 'onboarding.sean_ellis_response':
      return {
        ...base,
        event: name,
        payload: { response: 'very_disappointed', freeform: 'I love it' },
      }
    case 'onboarding.pass2_sonnet_fallback_used':
      return {
        ...base,
        event: name,
        payload: {
          reason: '429_exhausted_on_opus',
          source: 'chatgpt-zip',
          synthesizer_model: 'claude-sonnet-4-6',
          primary_model: 'claude-opus-4-7',
          primary_error_message: 'pass2 substrate error: HTTP 429: rate_limit_error',
        },
      }
    case 'onboarding.router_decision':
      return {
        ...base,
        event: name,
        payload: {
          phase: 'import_upload_pending',
          action: 'answer',
          confidence: 0.92,
          escalated_to_sonnet: false,
          timed_out: false,
          clarify_synthesised: false,
          reasoning_redacted: 'tangent_route_to_claude_export_steps',
          latency_ms: 412,
        },
      }
  }
  // exhaustiveness check
  const _exhaustive: never = name
  void _exhaustive
  throw new Error('unreachable')
}

test('every event in the schema emits a structured-JSON line + lands a gateway_events row', async () => {
  const logged: PersistedOnboardingEvent[] = []
  const logger: EventLogger = (e) => logged.push(e)
  const telemetry = new OnboardingTelemetry({ db, eventLogger: logger, uuid: deterministicUuid() })

  for (const name of ALL_ONBOARDING_EVENT_NAMES) {
    await telemetry.emit(eventForName(name))
  }

  // Every event landed via the structured-JSON sink.
  expect(logged.length).toBe(ALL_ONBOARDING_EVENT_NAMES.length)
  for (let i = 0; i < ALL_ONBOARDING_EVENT_NAMES.length; i++) {
    expect(logged[i]?.event).toBe(ALL_ONBOARDING_EVENT_NAMES[i] as never)
  }

  // Every event landed in gateway_events.
  const rowCount = db
    .raw()
    .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM gateway_events`)
    .get()
  expect(rowCount?.c).toBe(ALL_ONBOARDING_EVENT_NAMES.length)

  // Module routing: signup.* → 'signup'; everything else → 'onboarding'.
  for (const e of logged) {
    expect(e.module).toBe(e.event.startsWith('signup.') ? 'signup' : 'onboarding')
  }

  // No drift between the schema and the persisted set.
  const persisted = telemetry.list('t1').map((e) => e.event)
  expect(new Set(persisted)).toEqual(new Set(ALL_ONBOARDING_EVENT_NAMES))
})

test('moduleForEventName routes signup.* → signup, onboarding.* → onboarding', () => {
  expect(moduleForEventName('signup.started')).toBe('signup')
  expect(moduleForEventName('signup.instance_provisioned')).toBe('signup')
  expect(moduleForEventName('onboarding.completed')).toBe('onboarding')
  expect(moduleForEventName('onboarding.sean_ellis_response')).toBe('onboarding')
})

test('payload JSON round-trips faithfully through the SQL row', async () => {
  const telemetry = new OnboardingTelemetry({ db, uuid: deterministicUuid() })
  await telemetry.emit({
    project_slug: 't1',
    user_id: 'u1',
    event: 'onboarding.completed',
    payload: {
      time_to_wow_ms: 1234,
      total_dollars: 0.75,
      wow_actions_fired: ['01-first-week-brief', '02-lifestyle-reminders'],
    },
  })
  const events = telemetry.list('t1')
  expect(events.length).toBe(1)
  expect(events[0]?.payload.time_to_wow_ms).toBe(1234)
  expect(events[0]?.payload.wow_actions_fired).toEqual([
    '01-first-week-brief',
    '02-lifestyle-reminders',
  ])
})

test('duration_ms is optional and round-trips when set', async () => {
  const telemetry = new OnboardingTelemetry({ db, uuid: deterministicUuid() })
  await telemetry.emit({
    project_slug: 't1',
    user_id: 'u1',
    event: 'onboarding.import_pass2_complete',
    payload: { source: 'chatgpt-zip', total_dollars: 1, entities: 1, projects: 1, tasks: 1 },
    duration_ms: 5_000,
  })
  await telemetry.emit({
    project_slug: 't1',
    user_id: 'u1',
    event: 'onboarding.import_started',
    payload: { source: 'chatgpt-zip' },
  })
  const events = telemetry.list('t1')
  expect(events.length).toBe(2)
  const withDuration = events.find((e) => e.event === 'onboarding.import_pass2_complete')
  const withoutDuration = events.find((e) => e.event === 'onboarding.import_started')
  expect(withDuration?.duration_ms).toBe(5_000)
  expect(withoutDuration?.duration_ms).toBeUndefined()
})

test('eventLogger throw does NOT roll back the SQL row', async () => {
  const telemetry = new OnboardingTelemetry({
    db,
    eventLogger: () => {
      throw new Error('sink down')
    },
    uuid: deterministicUuid(),
  })
  await telemetry.emit({
    project_slug: 't1',
    user_id: 'u1',
    event: 'onboarding.button_emitted',
    payload: { prompt_id: 'p1', idempotency_collapsed: false, options_count: 2 },
  })
  const rowCount = db
    .raw()
    .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM gateway_events`)
    .get()
  expect(rowCount?.c).toBe(1)
})

test('buildStdoutEventLogger writes one JSON line per event', () => {
  const captured: string[] = []
  const logger = buildStdoutEventLogger((s) => captured.push(s))
  logger({
    id: 'id-1',
    ts: 1,
    level: 'info',
    project_slug: 't',
    user_id: 'u',
    attempt_id: 'a-1',
    module: 'onboarding',
    event: 'onboarding.completed',
    payload: { time_to_wow_ms: 1, total_dollars: 1, wow_actions_fired: [] },
  })
  expect(captured.length).toBe(1)
  expect(captured[0]?.endsWith('\n')).toBe(true)
  // Deserializable.
  const parsed = JSON.parse((captured[0] ?? '').trim()) as { event: string }
  expect(parsed.event).toBe('onboarding.completed')
})

test('signup events filter to module=signup; onboarding_metrics view aggregates both', async () => {
  const telemetry = new OnboardingTelemetry({ db, uuid: deterministicUuid() })
  const start = 1_700_000_000_000
  await telemetry.emit({
    project_slug: 't1',
    user_id: 'u1',
    event: 'signup.started',
    payload: { via: 'tg' },
    ts: start,
  })
  await telemetry.emit({
    project_slug: 't1',
    user_id: 'u1',
    event: 'onboarding.wow_dispatched',
    payload: { fired_count: 4, total_actions: 7 },
    ts: start + 30 * 60 * 1000,
  })
  await telemetry.emit({
    project_slug: 't1',
    user_id: 'u1',
    event: 'onboarding.completed',
    payload: { time_to_wow_ms: 30 * 60 * 1000, total_dollars: 1, wow_actions_fired: [] },
    ts: start + 31 * 60 * 1000,
  })
  interface Row {
    user_id: string
    signup_started_at: number | null
    wow_dispatched_at: number | null
    completed_at: number | null
    time_to_wow_ms: number | null
  }
  const row = db
    .raw()
    .query<Row, [string]>(
      `SELECT user_id, signup_started_at, wow_dispatched_at, completed_at, time_to_wow_ms
         FROM onboarding_metrics
        WHERE project_slug = ?`,
    )
    .get('t1')
  expect(row?.signup_started_at).toBe(start)
  expect(row?.wow_dispatched_at).toBe(start + 30 * 60 * 1000)
  expect(row?.completed_at).toBe(start + 31 * 60 * 1000)
  expect(row?.time_to_wow_ms).toBe(30 * 60 * 1000)
})

test('Codex r2 P1: view scopes wow_actions / sean_ellis on (project_slug, user_id) — no instance-wide leakage', async () => {
  // Two users in the same instance, each with their own wow events +
  // sean_ellis response. The view should attribute outcomes per-user;
  // no row should inherit the other user's data.
  const telemetry = new OnboardingTelemetry({ db })
  const OWNER_W = 'workspace-project'
  const userA = 'user-a'
  const userB = 'user-b'
  const baseAt = 1_700_000_000_000

  // Both users start onboarding so the view has rows for both.
  for (const user_id of [userA, userB]) {
    await telemetry.emit({
      project_slug: OWNER_W,
      user_id,
      event: 'signup.started',
      payload: { via: 'tg' },
      ts: baseAt,
    })
    await telemetry.emit({
      project_slug: OWNER_W,
      user_id,
      event: 'onboarding.completed',
      payload: { time_to_wow_ms: 1, total_dollars: 1, wow_actions_fired: [] },
      ts: baseAt + 1000,
    })
  }

  // userA has 3 wow_action_fired events (2 succeeded), userB has 1 (failed).
  for (let i = 0; i < 3; i++) {
    await telemetry.emit({
      project_slug: OWNER_W,
      user_id: userA,
      event: 'onboarding.wow_action_fired',
      payload: { action_id: `0${i + 1}`, success: i < 2 },
      ts: baseAt + 100 + i,
    })
  }
  await telemetry.emit({
    project_slug: OWNER_W,
    user_id: userB,
    event: 'onboarding.wow_action_fired',
    payload: { action_id: '01', success: false },
    ts: baseAt + 200,
  })

  // Each user has their own sean_ellis response.
  await telemetry.emit({
    project_slug: OWNER_W,
    user_id: userA,
    event: 'onboarding.sean_ellis_response',
    payload: { response: 'very_disappointed' },
    ts: baseAt + 1000,
  })
  await telemetry.emit({
    project_slug: OWNER_W,
    user_id: userB,
    event: 'onboarding.sean_ellis_response',
    payload: { response: 'somewhat_disappointed' },
    ts: baseAt + 2000,
  })

  interface Row {
    user_id: string
    wow_actions_fired: number
    wow_actions_succeeded: number
    sean_ellis_response: string | null
  }
  const rows = db
    .raw()
    .query<Row, [string]>(
      `SELECT user_id, wow_actions_fired, wow_actions_succeeded, sean_ellis_response
         FROM onboarding_metrics
        WHERE project_slug = ?
        ORDER BY user_id`,
    )
    .all(OWNER_W)
  expect(rows.length).toBe(2)
  const aRow = rows.find((r) => r.user_id === userA)
  const bRow = rows.find((r) => r.user_id === userB)
  expect(aRow?.wow_actions_fired).toBe(3)
  expect(aRow?.wow_actions_succeeded).toBe(2)
  expect(aRow?.sean_ellis_response).toBe('very_disappointed')
  expect(bRow?.wow_actions_fired).toBe(1)
  expect(bRow?.wow_actions_succeeded).toBe(0)
  expect(bRow?.sean_ellis_response).toBe('somewhat_disappointed')
})

test('P2 v2 S18: onboarding_metrics view exposes gap_fill_iterations, llm_fallback_count, llm_picked_actions', () => {
  // The view columns themselves — proves migration 0029 applied + columns
  // are visible at query time even before any events are emitted (the
  // forward-compat window during which the 3 v2 emit sites are not yet
  // routed through OnboardingTelemetry).
  interface ColumnRow {
    name: string
  }
  const columns = db
    .raw()
    .query<ColumnRow, []>(`PRAGMA table_info(onboarding_metrics)`)
    .all()
    .map((r) => r.name)
  expect(columns).toContain('gap_fill_iterations')
  expect(columns).toContain('llm_fallback_count')
  expect(columns).toContain('llm_picked_actions')
})

test('P2 v2 S18: view populates the three new columns from raw gateway_events', () => {
  // The three event names are NOT yet in the typed OnboardingEventName
  // enum (the emit sites are unwired — flagged as a follow-up in the
  // PR description). Insert rows directly so we can prove the view's
  // aggregation works end-to-end the moment the emits land.
  const ATTEMPT = 'attempt-1'
  const OWNER = 't-s18'
  const USER = 'u-s18'
  const baseAt = 1_700_000_000_000

  const insert = db.raw().prepare<
    void,
    [string, number, string, string, string, string, string]
  >(
    `INSERT INTO gateway_events
       (id, ts, level, project_slug, user_id, attempt_id, module, event_name, payload_json)
       VALUES (?, ?, 'info', ?, ?, ?, 'onboarding', ?, ?)`,
  )

  // signup.started so the view has a row at all (no signup → no aggregate).
  db.raw().run(
    `INSERT INTO gateway_events
       (id, ts, level, project_slug, user_id, attempt_id, module, event_name, payload_json)
       VALUES ('seed', ?, 'info', ?, ?, ?, 'signup', 'signup.started', '{}')`,
    [baseAt, OWNER, USER, ATTEMPT],
  )

  // 2 gap_fill iterations.
  insert.run('gf1', baseAt + 1, OWNER, USER, ATTEMPT, 'onboarding.gap_fill_iteration', '{}')
  insert.run('gf2', baseAt + 2, OWNER, USER, ATTEMPT, 'onboarding.gap_fill_iteration', '{}')

  // 3 llm_rephrase events: 1 fallback_used=1, 1 fallback_used=0, 1 missing field.
  insert.run(
    'lr1',
    baseAt + 3,
    OWNER,
    USER,
    ATTEMPT,
    'onboarding.llm_rephrase_completed',
    JSON.stringify({ fallback_used: 1 }),
  )
  insert.run(
    'lr2',
    baseAt + 4,
    OWNER,
    USER,
    ATTEMPT,
    'onboarding.llm_rephrase_completed',
    JSON.stringify({ fallback_used: 0 }),
  )
  insert.run(
    'lr3',
    baseAt + 5,
    OWNER,
    USER,
    ATTEMPT,
    'onboarding.llm_rephrase_completed',
    '{}',
  )

  // One wow_action_selected with a picks array.
  insert.run(
    'pick1',
    baseAt + 6,
    OWNER,
    USER,
    ATTEMPT,
    'onboarding.wow_action_selected',
    JSON.stringify({
      picks: ['01-first-week-brief', '02-lifestyle-reminders'],
      explanations: {},
      fallback_used: false,
    }),
  )

  interface Row {
    gap_fill_iterations: number
    llm_fallback_count: number
    llm_picked_actions: string | null
  }
  const row = db
    .raw()
    .query<Row, [string, string, string]>(
      `SELECT gap_fill_iterations, llm_fallback_count, llm_picked_actions
         FROM onboarding_metrics
        WHERE project_slug = ? AND user_id = ? AND attempt_id = ?`,
    )
    .get(OWNER, USER, ATTEMPT)
  expect(row?.gap_fill_iterations).toBe(2)
  expect(row?.llm_fallback_count).toBe(1)
  // SQLite's JSON_EXTRACT on an array returns the JSON text representation.
  expect(row?.llm_picked_actions).toBe('["01-first-week-brief","02-lifestyle-reminders"]')
})

test('P2 v2 S18: llm_picked_actions is scoped per (project_slug, user_id, attempt_id)', () => {
  // Two users in one instance — verify userA's picks never leak to userB.
  const OWNER = 't-pick-scope'
  const ATTEMPT = 'a-pick'
  const baseAt = 1_700_000_000_000
  const seed = db.raw().prepare<
    void,
    [string, number, string, string, string, string, string, string]
  >(
    `INSERT INTO gateway_events
       (id, ts, level, project_slug, user_id, attempt_id, module, event_name, payload_json)
       VALUES (?, ?, 'info', ?, ?, ?, ?, ?, ?)`,
  )
  for (const u of ['u-A', 'u-B']) {
    seed.run(
      `seed-${u}`,
      baseAt,
      OWNER,
      u,
      ATTEMPT,
      'signup',
      'signup.started',
      '{}',
    )
  }
  seed.run(
    'pickA',
    baseAt + 10,
    OWNER,
    'u-A',
    ATTEMPT,
    'onboarding',
    'onboarding.wow_action_selected',
    JSON.stringify({ picks: ['01-first-week-brief'], explanations: {}, fallback_used: false }),
  )
  // userB has no picks → llm_picked_actions must be NULL, not userA's array.

  interface Row {
    user_id: string
    llm_picked_actions: string | null
  }
  const rows = db
    .raw()
    .query<Row, [string]>(
      `SELECT user_id, llm_picked_actions FROM onboarding_metrics WHERE project_slug = ? ORDER BY user_id`,
    )
    .all(OWNER)
  expect(rows.length).toBe(2)
  expect(rows.find((r) => r.user_id === 'u-A')?.llm_picked_actions).toBe('["01-first-week-brief"]')
  expect(rows.find((r) => r.user_id === 'u-B')?.llm_picked_actions).toBeNull()
})

test('latest view migration (0069) body matches onboarding-metrics-view.sql modulo whitespace', () => {
  // The canonical file always reflects the LATEST migration that defines
  // the view. v1 shipped via 0017; v2 (S18) re-defined it via 0029; the
  // OSS-split renames re-defined it via 0066 (project vocabulary) and
  // 0069 (instance_provisioned event family, C4-a2). Subsequent view
  // changes should land as a new migration AND update both this test's
  // filename and the canonical file.
  const migration = readFileSync(
    join(
      HERE,
      '..',
      '..',
      '..',
      'migrations',
      '0069_telemetry_instance_provisioned.sql',
    ),
    'utf8',
  )
  const canonical = readFileSync(join(HERE, '..', 'onboarding-metrics-view.sql'), 'utf8')

  const extractView = (s: string): string => {
    const idx = s.indexOf('DROP VIEW IF EXISTS onboarding_metrics')
    if (idx < 0) throw new Error('view DDL not found')
    return s.slice(idx).replace(/\s+/g, ' ').trim()
  }
  expect(extractView(migration)).toBe(extractView(canonical))
})
