/**
 * Email-Managed Core — per-project Gmail label resolver.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.5.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  previewProjectLabelName,
  resolveProjectLabel,
} from '../src/per-project-resolver.ts'
import { EmailProjectCacheResolver } from '../src/cache.ts'
import { buildSeededInMemoryGmailClient } from '../src/backend.ts'

function tmp(): { home: string; close: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'email-resolver-'))
  return { home, close: (): void => rmSync(home, { recursive: true, force: true }) }
}

describe('per-project-resolver', () => {
  test('previewProjectLabelName preserves Neutron/<project_id>', () => {
    expect(previewProjectLabelName('alpha')).toBe('Neutron/alpha')
  })

  test('cache miss → calls ensureProjectLabel + persists', async () => {
    const { home, close } = tmp()
    try {
      const r = new EmailProjectCacheResolver({ owner_home: home })
      const cache = await r.resolve('alpha')
      const client = buildSeededInMemoryGmailClient()
      const resolved = await resolveProjectLabel({
        cache,
        client,
        project_id: 'alpha',
      })
      expect(resolved.source).toBe('gmail_created')
      expect(resolved.label_name).toBe('Neutron/alpha')
      expect(resolved.gmail_label_id.length).toBeGreaterThan(0)
      // Second call hits the cache.
      const replay = await resolveProjectLabel({
        cache,
        client,
        project_id: 'alpha',
      })
      expect(replay.source).toBe('cache')
      expect(replay.gmail_label_id).toBe(resolved.gmail_label_id)
      r.closeAll()
    } finally {
      close()
    }
  })

  test('cache hit short-circuits the Gmail call', async () => {
    const { home, close } = tmp()
    try {
      const r = new EmailProjectCacheResolver({ owner_home: home })
      const cache = await r.resolve('alpha')
      cache.setProjectLabelId({
        project_id: 'alpha',
        gmail_label_id: 'Label_PreCached',
        label_name: 'Neutron/alpha',
      })
      let calls = 0
      const client = buildSeededInMemoryGmailClient()
      const wrapped = {
        ...client,
        ensureProjectLabel: async (input: { project_id: string }) => {
          calls++
          return client.ensureProjectLabel(input)
        },
      }
      const resolved = await resolveProjectLabel({
        cache,
        client: wrapped,
        project_id: 'alpha',
      })
      expect(resolved.source).toBe('cache')
      expect(resolved.gmail_label_id).toBe('Label_PreCached')
      expect(calls).toBe(0)
      r.closeAll()
    } finally {
      close()
    }
  })
})
