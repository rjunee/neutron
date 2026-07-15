/**
 * Item 4 — project-page indexer unit tests. Pins the writeEntity
 * contract (kind='project', slug normalization to the entity slug
 * regex, own-origin attribution) + syncHook threading so the GBrain
 * put_page fan-out fires exactly like the import entity-populator path.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildProjectPageIndexer,
  type ProjectPageWriteEntityFn,
} from '../build-project-page-indexer.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'

type WriteCall = {
  input: Parameters<ProjectPageWriteEntityFn>[0]
  deps: Parameters<ProjectPageWriteEntityFn>[1]
}

function recorder(): { writeEntity: ProjectPageWriteEntityFn; calls: WriteCall[] } {
  const calls: WriteCall[] = []
  const writeEntity: ProjectPageWriteEntityFn = async (input, deps) => {
    calls.push({ input, deps })
    return { path: `/tmp/entities/projects/${input.slug}.md`, newLinks: [], changed: true }
  }
  return { writeEntity, calls }
}

describe('build-project-page-indexer', () => {
  test('writes a project-kind page with own-origin attribution + the sync hook', async () => {
    const { writeEntity, calls } = recorder()
    const syncHook: SyncHook = { onEntityWrite: async () => {} }
    const index = buildProjectPageIndexer({
      ownerDataDir: '/tmp/project',
      project_slug: 't-33333333',
      writeEntity,
      syncHook,
      now: () => 1_700_000_000_000,
    })

    await index({
      project_slug: 'topline',
      name: 'Topline',
      body: '# Topline\n\nBilling SaaS.\n',
      source_path: 'Projects/topline',
    })

    expect(calls.length).toBe(1)
    const { input, deps } = calls[0]!
    expect(input.kind).toBe('project')
    expect(input.slug).toBe('topline')
    expect(input.ownerDataDir).toBe('/tmp/project')
    expect(input.originInstance).toBe('t-33333333')
    expect(input.receivingInstanceSlug).toBe('t-33333333')
    expect(input.body.frontmatter['slug']).toBe('topline')
    expect(input.body.frontmatter['type']).toBe('project')
    expect(input.body.frontmatter['project_dir']).toBe('Projects/topline')
    expect(input.body.compiledTruth).toContain('Billing SaaS')
    expect(input.body.timelineAppend.ts).toBe('2023-11-14T22:13:20.000Z')
    expect(deps?.syncHook).toBe(syncHook)
  })

  test('normalizes project ids that violate the entity slug regex', async () => {
    const { writeEntity, calls } = recorder()
    const index = buildProjectPageIndexer({
      ownerDataDir: '/tmp/project',
      project_slug: 't1',
      writeEntity,
    })
    // slugifyProjectId allows [._] — entity slugs do not.
    await index({
      project_slug: 'v2.0_beta',
      name: 'V2.0 Beta',
      body: '# V2.0 Beta\n',
      source_path: 'Projects/v2.0_beta',
    })
    expect(calls[0]?.input.slug).toBe('v2-0-beta')
    // The on-disk pointer still references the REAL folder.
    expect(calls[0]?.input.body.frontmatter['project_dir']).toBe('Projects/v2.0_beta')
  })
})
