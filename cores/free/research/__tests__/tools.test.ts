import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  CapabilityDeniedError,
  CapabilityGuard,
  SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import {
  ResearchInputError,
  ResearchStore,
  ResearchTaskNotFoundError,
  buildCannedResearchSubstrate,
  buildResearchOrchestrator,
  buildTools,
  loadManifest,
  validateResearchBrief,
  type ResearchBrief,
  type ResearchStartInput,
} from '../index.ts'

const OWNER = 't1'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'research-tools-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

const CANNED_BRIEF: ResearchBrief = {
  topic: 'How should Neutron price Tier 2 paid Cores?',
  key_findings: [
    'Stripe metered billing is the lowest-friction option for usage-based',
    'A flat $/mo per Core matches B2B SaaS norms and is easier to forecast',
    'Bundling 2–3 Tier 2 Cores at a single price reduces decision fatigue',
  ],
  sources: [
    { title: 'Stripe metered billing docs', url: 'https://stripe.com/docs/billing/subscriptions/metered' },
    { title: 'OpenView 2025 SaaS pricing report', note: 'industry benchmark' },
  ],
  confidence_level: 'medium',
  recommendations: [
    'Start with a flat monthly per-Core fee + a Pro bundle of 3 Cores',
    'Revisit metered billing once usage telemetry is in place',
  ],
}

function buildBackend(ownerSlug: string = OWNER) {
  const store = new ResearchStore({
    project_slug: ownerSlug,
    db: projectDb,
    // Use a monotonic clock so timestamps are strictly increasing per
    // call (helps assertions that look at ordering / completed_at).
    now: ((): (() => number) => {
      let n = 1_700_000_000_000
      return (): number => ++n
    })(),
  })
  const substrate = buildCannedResearchSubstrate({
    responses: [JSON.stringify(CANNED_BRIEF)],
  })
  return {
    store,
    substrate,
    backend: buildResearchOrchestrator({ store, substrate }),
  }
}

function makeTools(ownerSlug: string = OWNER) {
  const { backend, store, substrate } = buildBackend(ownerSlug)
  const manifest = loadManifest()
  return {
    tools: buildTools({
      manifest,
      project_slug: ownerSlug,
      audit,
      backend,
    }),
    backend,
    store,
    substrate,
  }
}

describe('buildTools — capability-gated dispatch', () => {
  test('research_start → research_status → research_fetch round-trip', async () => {
    const { tools, substrate } = makeTools()

    const started = await tools.research_start({
      query: 'How should Neutron price Tier 2 paid Cores?',
      depth: 'standard',
    })
    expect(started.task_id).toBeTruthy()
    // v1 is synchronous: by the time start() returns the task is terminal.
    expect(started.status).toBe('completed')

    const status = await tools.research_status({ task_id: started.task_id })
    expect(status.task_id).toBe(started.task_id)
    expect(status.status).toBe('completed')
    expect(status.created_at).toBeGreaterThan(0)
    expect(status.updated_at).toBeGreaterThanOrEqual(status.created_at)
    expect(status.completed_at).toBeGreaterThanOrEqual(status.updated_at - 1)
    expect(status.error).toBeUndefined()

    const fetched = await tools.research_fetch({ task_id: started.task_id })
    expect(fetched.task_id).toBe(started.task_id)
    expect(fetched.status).toBe('completed')
    expect(fetched.brief).toBeDefined()
    expect(fetched.brief?.topic).toBe(CANNED_BRIEF.topic)
    expect(fetched.brief?.key_findings).toHaveLength(CANNED_BRIEF.key_findings.length)
    expect(fetched.brief?.sources).toHaveLength(CANNED_BRIEF.sources.length)
    expect(fetched.brief?.confidence_level).toBe('medium')
    expect(fetched.brief?.recommendations.length).toBeGreaterThan(0)
    expect(fetched.error).toBeUndefined()

    // Substrate was called exactly once on the success path.
    expect(substrate.call_count).toBe(1)

    // Audit log: each capability-guarded dispatch records an `ok` row.
    const auditRows = await audit.list({
      project_slug: OWNER,
      core_slug: 'research_core',
    })
    const successRows = auditRows.filter((row) => row.outcome === 'ok')
    expect(successRows.length).toBeGreaterThanOrEqual(3)
    const toolNames = new Set(successRows.map((row) => row.label))
    expect(toolNames.has('research_start')).toBe(true)
    expect(toolNames.has('research_status')).toBe(true)
    expect(toolNames.has('research_fetch')).toBe(true)
  })

  test('research_start with a fenced JSON response parses through extractJson', async () => {
    const store = new ResearchStore({ project_slug: OWNER, db: projectDb })
    const substrate = buildCannedResearchSubstrate({
      responses: [
        '```json\n' + JSON.stringify(CANNED_BRIEF) + '\n```',
      ],
    })
    const backend = buildResearchOrchestrator({ store, substrate })
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, backend })

    const started = await tools.research_start({
      query: 'fenced response parses fine',
    })
    expect(started.status).toBe('completed')
    const fetched = await tools.research_fetch({ task_id: started.task_id })
    expect(fetched.brief?.topic).toBe(CANNED_BRIEF.topic)
  })

  test('research_start with sources + depth threads them through into the prompt', async () => {
    const store = new ResearchStore({ project_slug: OWNER, db: projectDb })
    const substrate = buildCannedResearchSubstrate({
      responses: [JSON.stringify(CANNED_BRIEF)],
    })
    const backend = buildResearchOrchestrator({ store, substrate })
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, backend })

    await tools.research_start({
      query: 'what is the best pricing model for Tier 2?',
      depth: 'deep',
      sources: ['Stripe docs', 'OpenView 2025 SaaS report'],
    })
    expect(substrate.prompts).toHaveLength(1)
    const prompt = substrate.prompts[0]!
    expect(prompt).toContain('Depth hint: deep')
    expect(prompt).toContain('Stripe docs')
    expect(prompt).toContain('OpenView 2025 SaaS report')
  })

  test('research_status throws ResearchTaskNotFoundError on unknown task_id', async () => {
    const { tools } = makeTools()
    await expect(
      tools.research_status({ task_id: 'does-not-exist' }),
    ).rejects.toThrow(ResearchTaskNotFoundError)
  })

  test('research_fetch throws ResearchTaskNotFoundError on unknown task_id', async () => {
    const { tools } = makeTools()
    await expect(
      tools.research_fetch({ task_id: 'does-not-exist' }),
    ).rejects.toThrow(ResearchTaskNotFoundError)
  })

  test('research_fetch on a failed task returns error metadata, not the brief', async () => {
    const store = new ResearchStore({ project_slug: OWNER, db: projectDb })
    const substrate = buildCannedResearchSubstrate({
      responses: [
        { kind: 'throw', error: new Error('substrate exploded — quota exhausted') },
      ],
    })
    const backend = buildResearchOrchestrator({ store, substrate })
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      backend,
    })

    const started = await tools.research_start({ query: 'will fail' })
    expect(started.status).toBe('failed')

    const status = await tools.research_status({ task_id: started.task_id })
    expect(status.status).toBe('failed')
    expect(status.error).toMatch(/substrate exploded/)

    const fetched = await tools.research_fetch({ task_id: started.task_id })
    expect(fetched.status).toBe('failed')
    expect(fetched.brief).toBeUndefined()
    expect(fetched.error).toMatch(/substrate exploded/)
  })

  test('parse failure on first attempt retries once with parser error in the prompt and recovers', async () => {
    const store = new ResearchStore({ project_slug: OWNER, db: projectDb })
    const substrate = buildCannedResearchSubstrate({
      responses: [
        // First attempt: not valid JSON.
        'sorry, I forgot the schema — here is just prose about pricing',
        // Retry: well-formed brief.
        JSON.stringify(CANNED_BRIEF),
      ],
    })
    const backend = buildResearchOrchestrator({ store, substrate })
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      backend,
    })

    const started = await tools.research_start({ query: 'recover after parse fail' })
    expect(started.status).toBe('completed')

    // The substrate was called twice — once for the bad attempt, once for the retry.
    expect(substrate.call_count).toBe(2)
    // The retry prompt should mention the parser error so the LLM has
    // a concrete diagnostic to act on. Check both prompts: the first
    // is the original; the second carries the retry instruction.
    expect(substrate.prompts[0]).not.toContain('previous attempt')
    expect(substrate.prompts[1]).toContain('previous attempt')

    const fetched = await tools.research_fetch({ task_id: started.task_id })
    expect(fetched.status).toBe('completed')
    expect(fetched.brief?.topic).toBe(CANNED_BRIEF.topic)
  })

  test('parse failure on retry surfaces as `failed` (no third attempt)', async () => {
    const store = new ResearchStore({ project_slug: OWNER, db: projectDb })
    const substrate = buildCannedResearchSubstrate({
      responses: [
        // First attempt: not valid JSON.
        'sorry, all prose',
        // Retry: still not valid JSON.
        'still all prose, I have lost the plot',
      ],
    })
    const backend = buildResearchOrchestrator({ store, substrate })
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      backend,
    })

    const started = await tools.research_start({ query: 'persistently bad output' })
    expect(started.status).toBe('failed')

    // The substrate is called exactly twice — no third attempt.
    expect(substrate.call_count).toBe(2)

    const fetched = await tools.research_fetch({ task_id: started.task_id })
    expect(fetched.status).toBe('failed')
    expect(fetched.error).toMatch(/parse error on retry|schema error on retry/)
    expect(fetched.brief).toBeUndefined()
  })

  test('schema failure on first attempt retries once with the schema error and recovers', async () => {
    // Substrate returns parseable JSON that doesn't match the brief shape on
    // the first call; second call returns a valid brief. This proves the
    // retry path covers SCHEMA failures (not just JSON-parse failures).
    const store = new ResearchStore({ project_slug: OWNER, db: projectDb })
    const substrate = buildCannedResearchSubstrate({
      responses: [
        // First attempt: valid JSON, wrong shape (confidence_level missing).
        JSON.stringify({
          topic: 'pricing',
          key_findings: ['finding A'],
          sources: [{ title: 'src' }],
          recommendations: ['rec'],
        }),
        // Retry: well-formed brief.
        JSON.stringify(CANNED_BRIEF),
      ],
    })
    const backend = buildResearchOrchestrator({ store, substrate })
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      backend,
    })

    const started = await tools.research_start({ query: 'recover after schema fail' })
    expect(started.status).toBe('completed')
    expect(substrate.call_count).toBe(2)
    expect(substrate.prompts[1]).toContain('previous attempt')
  })

  test('empty query is rejected before any substrate call', async () => {
    const { tools, substrate } = makeTools()
    await expect(
      tools.research_start({ query: '   ' }),
    ).rejects.toThrow(/non-empty/)
    expect(substrate.call_count).toBe(0)
  })

  test('runtime input validation: non-string query is rejected before persistence (Codex P2 fix)', async () => {
    // McpServer.dispatch passes raw JSON through to tool handlers
    // without enforcing the manifest's input_schema, so a tool-call
    // client (LLM, MCP inspector) can hand the orchestrator a payload
    // with the wrong shape. The orchestrator must reject this BEFORE
    // it reaches insertPending or the prompt builder.
    const { tools, substrate, store } = makeTools()
    // Pass through as `unknown` to bypass the TS contract — exactly what
    // McpServer does at runtime.
    await expect(
      tools.research_start({ query: 42 } as unknown as { query: string }),
    ).rejects.toThrow(ResearchInputError)
    expect(substrate.call_count).toBe(0)
    // Defence-in-depth: nothing was persisted either.
    const row = await store.get('any-id')
    expect(row).toBeNull()
  })

  test('runtime input validation: invalid depth enum value is rejected before insertPending', async () => {
    const { tools, substrate } = makeTools()
    await expect(
      tools.research_start({
        query: 'ok',
        depth: 'exhaustive' as unknown as 'quick',
      }),
    ).rejects.toThrow(ResearchInputError)
    // The orchestrator MUST reject BEFORE the CHECK(depth IN ...) SQL
    // constraint trips — that fail mode would surface as a raw
    // SQLite error instead of the typed ResearchInputError.
    await expect(
      tools.research_start({
        query: 'ok',
        depth: 'exhaustive' as unknown as 'quick',
      }),
    ).rejects.toThrow(/depth/)
    expect(substrate.call_count).toBe(0)
  })

  test('runtime input validation: non-array sources is rejected before the prompt builder', async () => {
    const { tools, substrate } = makeTools()
    await expect(
      tools.research_start({
        query: 'ok',
        sources: 'not-an-array' as unknown as string[],
      }),
    ).rejects.toThrow(ResearchInputError)
    expect(substrate.call_count).toBe(0)
  })

  test('runtime input validation: non-string source entry is rejected', async () => {
    const { tools, substrate } = makeTools()
    await expect(
      tools.research_start({
        query: 'ok',
        sources: ['valid', 42 as unknown as string],
      }),
    ).rejects.toThrow(ResearchInputError)
    expect(substrate.call_count).toBe(0)
  })

  test('runtime input validation: null/undefined optional fields fall through to defaults', async () => {
    // Optional fields explicitly set to null should be tolerated and
    // resolved to defaults (depth → 'standard', sources → []). Same
    // shape as the manifest's input_schema treats them.
    const { tools, substrate } = makeTools()
    const started = await tools.research_start({
      query: 'tolerated-null',
      depth: null,
      sources: null,
    } as unknown as ResearchStartInput)
    expect(started.status).toBe('completed')
    expect(substrate.call_count).toBe(1)
  })

  test('runtime input validation: research_status rejects missing task_id (Codex P3 fix)', async () => {
    // Symmetric to the research_start fix: McpServer passes raw JSON
    // through to handlers; a malformed payload (no task_id) MUST surface
    // as a typed ResearchInputError, not as ResearchTaskNotFoundError —
    // the caller would otherwise treat "you sent the wrong shape" as
    // "task is gone" and never self-correct.
    const { tools } = makeTools()
    await expect(
      tools.research_status({} as unknown as { task_id: string }),
    ).rejects.toThrow(ResearchInputError)
  })

  test('runtime input validation: research_status rejects non-string task_id', async () => {
    const { tools } = makeTools()
    await expect(
      tools.research_status({ task_id: 42 as unknown as string }),
    ).rejects.toThrow(ResearchInputError)
  })

  test('runtime input validation: research_status rejects empty / whitespace task_id', async () => {
    const { tools } = makeTools()
    await expect(
      tools.research_status({ task_id: '' }),
    ).rejects.toThrow(ResearchInputError)
    await expect(
      tools.research_status({ task_id: '   ' }),
    ).rejects.toThrow(/non-empty/)
  })

  test('runtime input validation: research_fetch rejects null / undefined task_id', async () => {
    const { tools } = makeTools()
    await expect(
      tools.research_fetch({ task_id: null as unknown as string }),
    ).rejects.toThrow(ResearchInputError)
    await expect(
      tools.research_fetch({ task_id: undefined as unknown as string }),
    ).rejects.toThrow(ResearchInputError)
  })

  test('runtime input validation: error message distinguishes bad input from not-found', async () => {
    // Bad shape → ResearchInputError tagged with the tool name (the LLM
    // can read "research_fetch: task_id: must be a string" and self-
    // correct). A real missing task → ResearchTaskNotFoundError. The two
    // MUST be distinguishable.
    const { tools } = makeTools()
    await expect(
      tools.research_fetch({ task_id: 42 as unknown as string }),
    ).rejects.toThrow(/research_fetch: task_id/)
    await expect(
      tools.research_fetch({ task_id: 'genuinely-missing-uuid' }),
    ).rejects.toThrow(ResearchTaskNotFoundError)
  })

  test('project isolation: research_status / research_fetch on another project\'s id surface as not-found', async () => {
    const a = makeTools('owner_a')
    const b = makeTools('owner_b')

    const started = await a.tools.research_start({ query: 'a-only' })
    // Instance B cannot see instance A's task — surfaces as not-found.
    await expect(
      b.tools.research_status({ task_id: started.task_id }),
    ).rejects.toThrow(ResearchTaskNotFoundError)
    await expect(
      b.tools.research_fetch({ task_id: started.task_id }),
    ).rejects.toThrow(ResearchTaskNotFoundError)

    // Instance A still resolves its own task fine.
    const status = await a.tools.research_status({ task_id: started.task_id })
    expect(status.status).toBe('completed')
  })

  test('capability gate: stripping write:research_core.db blocks research_start, leaves status/fetch working', async () => {
    const m0 = loadManifest()
    const downgraded: NeutronManifest = {
      ...m0,
      capabilities: m0.capabilities.filter((c) => c !== 'write:research_core.db'),
    }
    const store = new ResearchStore({ project_slug: OWNER, db: projectDb })
    const substrate = buildCannedResearchSubstrate({
      responses: [JSON.stringify(CANNED_BRIEF)],
    })
    const backend = buildResearchOrchestrator({ store, substrate })
    const tools = buildTools({
      manifest: downgraded,
      project_slug: OWNER,
      audit,
      backend,
    })

    await expect(
      tools.research_start({ query: 'blocked' }),
    ).rejects.toThrow(CapabilityDeniedError)

    // The substrate was never called — the guard rejected before
    // the tool body ran.
    expect(substrate.call_count).toBe(0)

    // Read-side tools still work (the gate is read:research_core.db
    // which is still declared); status on an unknown id throws the
    // expected `not found` error, proving the handler ran.
    await expect(
      tools.research_status({ task_id: 'unknown' }),
    ).rejects.toThrow(ResearchTaskNotFoundError)

    // The audit log has a capability_denied row for research_start.
    const denied = await audit.listDenied({
      project_slug: OWNER,
      core_slug: 'research_core',
    })
    const labels = new Set(denied.map((r) => r.label))
    expect(labels.has('research_start')).toBe(true)
    expect(labels.has('research_status')).toBe(false)
    expect(labels.has('research_fetch')).toBe(false)
  })

  test('capability gate: tool name not in manifest.tools[] is rejected by `tool_not_declared`', async () => {
    const m = loadManifest()
    const guard = new CapabilityGuard({
      manifest: m,
      core_slug: 'research_core',
      project_slug: OWNER,
      audit,
    })
    const result = guard.check({
      tool_name: 'research_undefined_tool',
      capability_required: 'write:research_core.db',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('tool_not_declared')
    }
  })
})

describe('validateResearchBrief — defence-in-depth', () => {
  test('happy path returns the brief unchanged', () => {
    const r = validateResearchBrief(CANNED_BRIEF)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.brief).toEqual(CANNED_BRIEF)
  })

  test('rejects when confidence_level is invalid', () => {
    const r = validateResearchBrief({ ...CANNED_BRIEF, confidence_level: 'maybe' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/confidence_level/)
  })

  test('rejects when sources lack a title', () => {
    const r = validateResearchBrief({
      ...CANNED_BRIEF,
      sources: [{ url: 'https://example.com' }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/title/)
  })

  test('rejects when key_findings contains a non-string', () => {
    const r = validateResearchBrief({
      ...CANNED_BRIEF,
      key_findings: ['ok', 42 as unknown as string],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/key_findings/)
  })

  test('rejects null payload', () => {
    const r = validateResearchBrief(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/JSON object/)
  })
})
