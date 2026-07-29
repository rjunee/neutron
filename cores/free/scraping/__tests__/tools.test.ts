import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { CapabilityDeniedError, SecretAuditLog } from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import { buildTools } from '../src/tools.ts'
import { loadManifest } from '../src/manifest.ts'
import type { ScrapeInput, ScrapeResult, ScrapingBackend } from '../src/backend.ts'

const OWNER = 't1'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'scraping-tools-'))
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

/** Stub backend that records the inputs it was dispatched with. */
function stubBackend(): { backend: ScrapingBackend; igCalls: ScrapeInput[]; xCalls: ScrapeInput[] } {
  const igCalls: ScrapeInput[] = []
  const xCalls: ScrapeInput[] = []
  const ok = (platform: 'instagram' | 'x'): ScrapeResult => ({
    ok: true,
    platform,
    mode: 'json',
    url: 'u',
    text: 't',
    data: {},
  })
  return {
    igCalls,
    xCalls,
    backend: {
      async scrapeInstagram(input) {
        igCalls.push(input)
        return ok('instagram')
      },
      async scrapeX(input) {
        xCalls.push(input)
        return ok('x')
      },
      async scrapeUrl() {
        return ok('instagram')
      },
      async isCredentialed() {
        return true
      },
    },
  }
}

describe('buildTools — capability-guarded MCP dispatch', () => {
  test('exposes scrape_instagram + scrape_x and routes to the backend', async () => {
    const { backend, igCalls, xCalls } = stubBackend()
    const tools = buildTools({
      manifest: loadManifest(),
      project_slug: OWNER,
      audit,
      backend,
    })
    const ig = await tools.scrape_instagram({ url: 'https://instagram.com/p/x/' })
    expect(ig.ok).toBe(true)
    expect(igCalls.length).toBe(1)

    const x = await tools.scrape_x({ url: 'https://x.com/a/status/1', mode: 'text' })
    expect(x.ok).toBe(true)
    expect(xCalls[0]?.mode).toBe('text')
  })

  test('records an ok tool_call audit row on dispatch', async () => {
    const { backend } = stubBackend()
    const tools = buildTools({
      manifest: loadManifest(),
      project_slug: OWNER,
      audit,
      backend,
    })
    await tools.scrape_instagram({ url: 'https://instagram.com/p/x/' })
    const rows = await audit.list({ owner_slug: OWNER })
    expect(rows.some((r) => r.op === 'tool_call' && r.outcome === 'ok')).toBe(true)
  })

  test('a manifest/tool capability mismatch is rejected by the guard', async () => {
    // Build a manifest whose scrape_x declares a DIFFERENT capability than
    // the BROWSE_CAPABILITY buildTools wires — the guard must deny dispatch.
    const base = loadManifest()
    const mutated: NeutronManifest = {
      ...base,
      capabilities: [...base.capabilities, 'network:other'],
      tools: base.tools.map((t) =>
        t.name === 'scrape_x' ? { ...t, capability_required: 'network:other' } : t,
      ),
    }
    const { backend } = stubBackend()
    const tools = buildTools({
      manifest: mutated,
      project_slug: OWNER,
      audit,
      backend,
    })
    await expect(
      tools.scrape_x({ url: 'https://x.com/a/status/1' }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError)
  })
})
