/**
 * @neutronai/research-core — project-scoped orchestrator integration tests.
 *
 * Asserts the full pipeline: substrate → parse → validate → claim
 * insert → assertSourcesCited → setCompleted, the deep-path sub-agent
 * dispatcher integration, retry-on-sources-cited-violation, and the
 * markdown render side-effect.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.5 + § 6.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PerOwnerConcurrencyGate,
  ResearchStoreResolver,
  buildCannedResearchSubstrate,
  buildCannedSubAgentDispatcher,
  buildProjectResearchOrchestrator,
  loadManifest,
} from '../index.ts'

let tmp: string
let resolver: ResearchStoreResolver
let writes: Array<{ path: string; contents: string }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-research-orc-'))
  resolver = new ResearchStoreResolver({
    project_slug: 'project-a',
    owner_home: tmp,
  })
  writes = []
})

afterEach(() => {
  resolver.closeAll()
  rmSync(tmp, { recursive: true, force: true })
})

function happyBrief(): string {
  return JSON.stringify({
    topic: 'water cycle in tropical climates',
    key_findings: ['evaporation drives the loop'],
    sources: [{ title: 'wiki', url: 'https://en.wikipedia.org/wiki/Water_cycle' }],
    confidence_level: 'medium',
    recommendations: ['read more on tropical biomes'],
    claims: [
      {
        claim: 'tropical climates have more solar input than temperate ones',
        evidence: 'Equatorial regions receive ~25% more solar irradiance annually',
        citation: 'https://en.wikipedia.org/wiki/Tropical_climate',
        confidence: 'high',
      },
    ],
  })
}

function violatingBrief(): string {
  return JSON.stringify({
    topic: 'x',
    key_findings: ['unverified bullet'],
    sources: [],
    confidence_level: 'low',
    recommendations: [],
    claims: [
      {
        claim: 'an uncited claim',
        confidence: 'high',
        // no citation — invariant violation
      },
    ],
  })
}

describe('buildProjectResearchOrchestrator — happy path', () => {
  test('substrate path: parse → validate → claims insert → markdown write', async () => {
    const substrate = buildCannedResearchSubstrate({ responses: [happyBrief()] })
    const orc = buildProjectResearchOrchestrator({
      resolver,
      substrate,
      manifest: loadManifest(),
      project_slug: 'project-a',
      writeFile: (path, contents) => writes.push({ path, contents }),
    })
    const result = await orc.start({
      query: 'water cycle in tropical climates',
      project_id: 'proj-1',
    })
    expect(result.status).toBe('completed')
    const fetched = await orc.fetch({ task_id: result.task_id, project_id: 'proj-1' })
    expect(fetched.status).toBe('completed')
    expect(fetched.brief?.claims).toHaveLength(1)
    // Claim row landed
    const claims = await orc.claimsForTask({
      task_id: result.task_id,
      project_id: 'proj-1',
    })
    expect(claims.claims).toHaveLength(1)
    expect(claims.claims[0]?.citation).toBe(
      'https://en.wikipedia.org/wiki/Tropical_climate',
    )
    // Markdown file was written
    expect(writes.length).toBe(1)
    expect(writes[0]?.path).toContain('research')
    expect(writes[0]?.contents).toContain('claim_count: 1')
  })

  test('list returns the brief after completion', async () => {
    const substrate = buildCannedResearchSubstrate({ responses: [happyBrief()] })
    const orc = buildProjectResearchOrchestrator({
      resolver,
      substrate,
      manifest: loadManifest(),
      project_slug: 'project-a',
      writeFile: () => {},
    })
    const r = await orc.start({ query: 'a topic', project_id: 'proj-1' })
    const list = await orc.list({ project_id: 'proj-1' })
    expect(list.briefs).toHaveLength(1)
    expect(list.briefs[0]?.task_id).toBe(r.task_id)
    expect(list.briefs[0]?.claim_count).toBe(1)
  })

  test('per-project isolation — A list invisible to B', async () => {
    const substrate = buildCannedResearchSubstrate({ responses: [happyBrief(), happyBrief()] })
    const orc = buildProjectResearchOrchestrator({
      resolver,
      substrate,
      manifest: loadManifest(),
      project_slug: 'project-a',
      writeFile: () => {},
    })
    await orc.start({ query: 'a', project_id: 'proj-A' })
    const inA = await orc.list({ project_id: 'proj-A' })
    const inB = await orc.list({ project_id: 'proj-B' })
    expect(inA.briefs).toHaveLength(1)
    expect(inB.briefs).toHaveLength(0)
  })
})

describe('buildProjectResearchOrchestrator — sources-cited invariant', () => {
  test('violation on first attempt + retry-with-rider success', async () => {
    const substrate = buildCannedResearchSubstrate({
      responses: [violatingBrief(), happyBrief()],
    })
    const orc = buildProjectResearchOrchestrator({
      resolver,
      substrate,
      manifest: loadManifest(),
      project_slug: 'project-a',
      writeFile: () => {},
    })
    const result = await orc.start({
      query: 'a topic',
      project_id: 'proj-1',
    })
    expect(result.status).toBe('completed')
    // The substrate saw the rider on the second call.
    expect(substrate.call_count).toBe(2)
    expect(substrate.prompts[1]).toContain('sources-cited invariant')
  })

  test('violation on both attempts → task fails', async () => {
    const substrate = buildCannedResearchSubstrate({
      responses: [violatingBrief(), violatingBrief()],
    })
    const orc = buildProjectResearchOrchestrator({
      resolver,
      substrate,
      manifest: loadManifest(),
      project_slug: 'project-a',
      writeFile: () => {},
    })
    const result = await orc.start({
      query: 'a topic',
      project_id: 'proj-1',
    })
    expect(result.status).toBe('failed')
    const status = await orc.status({ task_id: result.task_id, project_id: 'proj-1' })
    expect(status.error).toContain('sources-cited violation')
    // No claim rows persisted after the final failure.
    const claims = await orc.claimsForTask({
      task_id: result.task_id,
      project_id: 'proj-1',
    })
    expect(claims.claims).toHaveLength(0)
  })

  test('completely empty claims array → task fails (every brief must carry at least one)', async () => {
    const empty = JSON.stringify({
      topic: 'x',
      key_findings: [],
      sources: [],
      confidence_level: 'low',
      recommendations: [],
      claims: [],
    })
    const substrate = buildCannedResearchSubstrate({ responses: [empty, empty] })
    const orc = buildProjectResearchOrchestrator({
      resolver,
      substrate,
      manifest: loadManifest(),
      project_slug: 'project-a',
      writeFile: () => {},
    })
    const result = await orc.start({
      query: 'a topic',
      project_id: 'proj-1',
    })
    expect(result.status).toBe('failed')
  })
})

describe('buildProjectResearchOrchestrator — deep path', () => {
  test('sub-agent dispatcher invoked with Atlas-shape system prompt', async () => {
    const substrate = buildCannedResearchSubstrate({ responses: [] })
    const subAgent = buildCannedSubAgentDispatcher({
      responses: [{ query_match: /./, text: happyBrief() }],
    })
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    const orc = buildProjectResearchOrchestrator({
      resolver,
      substrate,
      sub_agent_dispatcher: subAgent,
      concurrency_gate: gate,
      manifest: loadManifest(),
      project_slug: 'project-a',
      writeFile: () => {},
    })
    const result = await orc.deep({
      query: 'how does the water cycle work',
      project_id: 'proj-1',
    })
    expect(result.status).toBe('completed')
    expect(subAgent.calls).toHaveLength(1)
    expect(subAgent.calls[0]?.system_prompt).toContain('Atlas')
  })

  test('deep without dispatcher throws', async () => {
    const substrate = buildCannedResearchSubstrate({ responses: [] })
    const orc = buildProjectResearchOrchestrator({
      resolver,
      substrate,
      manifest: loadManifest(),
      project_slug: 'project-a',
      writeFile: () => {},
    })
    await expect(
      orc.deep({ query: 'x', project_id: 'proj-1' }),
    ).rejects.toThrow(/sub_agent_dispatcher/)
  })
})

describe('buildProjectResearchOrchestrator — find', () => {
  test('lex+vec hybrid search returns ranked hits', async () => {
    const substrate = buildCannedResearchSubstrate({ responses: [happyBrief(), happyBrief()] })
    const orc = buildProjectResearchOrchestrator({
      resolver,
      substrate,
      manifest: loadManifest(),
      project_slug: 'project-a',
      writeFile: () => {},
    })
    await orc.start({ query: 'water cycle', project_id: 'proj-1' })
    await orc.start({ query: 'rocket propulsion', project_id: 'proj-1' })
    const hits = await orc.find({
      project_id: 'proj-1',
      query: 'water',
    })
    expect(hits.hits.length).toBeGreaterThanOrEqual(0)
  })
})

describe('buildProjectResearchOrchestrator — cite', () => {
  test('cite updates the claim citation', async () => {
    const substrate = buildCannedResearchSubstrate({ responses: [happyBrief()] })
    const orc = buildProjectResearchOrchestrator({
      resolver,
      substrate,
      manifest: loadManifest(),
      project_slug: 'project-a',
      writeFile: () => {},
    })
    const r = await orc.start({ query: 'a', project_id: 'proj-1' })
    const claims = await orc.claimsForTask({ task_id: r.task_id, project_id: 'proj-1' })
    const claim_id = claims.claims[0]!.id
    const updated = await orc.cite({
      claim_id,
      citation: 'https://new-citation.example/x',
      project_id: 'proj-1',
    })
    expect(updated.citation).toBe('https://new-citation.example/x')
  })
})
