import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolRegistry, type ToolCallContext } from '../tools/registry.ts'
import { DocSearchIndex } from './store.ts'
import { DocSearchRuntime } from './runtime.ts'
import { DOC_READ_TOOL, DOC_SEARCH_TOOL, registerDocSearchToolSurface } from './tool.ts'

const ctx: ToolCallContext = {
  project_slug: 'p',
  project_id: null,
  topic_id: null,
  call_id: 'c1',
  speaker_user_id: null,
}

let ownerHome: string
let index: DocSearchIndex
let runtime: DocSearchRuntime
let registry: ToolRegistry

async function seed(): Promise<void> {
  const mk = async (rel: string, body: string): Promise<void> => {
    const abs = join(ownerHome, 'Projects', rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, body, 'utf8')
  }
  await mk('topline/docs/pricing.md', '# Pricing\n\nThree pricing tiers with volume discounts.')
  await mk('topline/STATUS.md', '# Status\n\nShipping the dashboard.')
}

beforeEach(async () => {
  ownerHome = mkdtempSync(join(tmpdir(), 'neutron-doc-tool-'))
  await seed()
  index = DocSearchIndex.open(':memory:')
  runtime = new DocSearchRuntime({ ownerHome, index })
  registry = new ToolRegistry()
})
afterEach(() => {
  index.close()
  rmSync(ownerHome, { recursive: true, force: true })
})

describe('registerDocSearchToolSurface', () => {
  test('registers doc_search + doc_read with read:docs capability', () => {
    const names = registerDocSearchToolSurface(registry, runtime)
    expect(names).toEqual([DOC_SEARCH_TOOL, DOC_READ_TOOL])
    const search = registry.get(DOC_SEARCH_TOOL)!
    expect(search.capability_required).toBe('read:docs')
    expect(search.approval_policy).toBe('auto')
    expect(registry.get(DOC_READ_TOOL)!.capability_required).toBe('read:docs')
  })

  test('doc_search handler indexes lazily then returns ranked results', async () => {
    registerDocSearchToolSurface(registry, runtime)
    const handler = registry.get(DOC_SEARCH_TOOL)!.handler
    const out = (await handler({ query: 'pricing tiers discounts' }, ctx)) as {
      results: Array<{ project: string; path: string; score: number; snippet: string }>
    }
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results[0]!.project).toBe('topline')
    expect(out.results[0]!.path).toBe('docs/pricing.md')
    expect(out.results[0]!.score).toBeGreaterThan(0)
  })

  test('doc_search respects an explicit project scope and limit', async () => {
    registerDocSearchToolSurface(registry, runtime)
    const handler = registry.get(DOC_SEARCH_TOOL)!.handler
    const out = (await handler({ query: 'shipping dashboard', project: 'topline', limit: 1 }, ctx)) as {
      results: unknown[]
    }
    expect(out.results).toHaveLength(1)
  })

  test('doc_search tolerates a missing / non-string query', async () => {
    registerDocSearchToolSurface(registry, runtime)
    const handler = registry.get(DOC_SEARCH_TOOL)!.handler
    const out = (await handler({}, ctx)) as { results: unknown[] }
    expect(out.results).toEqual([])
  })

  test('doc_read returns content for a real doc and found:false otherwise', async () => {
    registerDocSearchToolSurface(registry, runtime)
    const handler = registry.get(DOC_READ_TOOL)!.handler
    const ok = (await handler({ project: 'topline', path: 'STATUS.md' }, ctx)) as {
      found: boolean
      content?: string
    }
    expect(ok.found).toBe(true)
    expect(ok.content).toContain('Shipping the dashboard')

    const bad = (await handler({ project: 'topline', path: '../STATUS.md' }, ctx)) as { found: boolean }
    expect(bad.found).toBe(false)
  })
})

describe('DocSearchRuntime.ensureFresh throttling', () => {
  test('debounces refreshes by the configured interval', async () => {
    let walks = 0
    let clock = 1_000_000
    const r = new DocSearchRuntime({
      ownerHome,
      index: DocSearchIndex.open(':memory:'),
      refreshIntervalMs: 5000,
      now: () => clock,
      walk: async () => {
        walks += 1
        return []
      },
      enumerateProjects: async () => ['topline'],
    })
    await r.ensureFresh() // first call always refreshes
    await r.ensureFresh() // within interval → skipped
    expect(walks).toBe(1)
    clock += 6000
    await r.ensureFresh() // interval elapsed → refreshes again
    expect(walks).toBe(2)
    await r.ensureFresh(true) // force bypasses throttle
    expect(walks).toBe(3)
  })
})
