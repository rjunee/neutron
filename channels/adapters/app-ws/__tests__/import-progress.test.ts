/**
 * @neutronai/channels/app-ws — import_progress wire shape tests.
 *
 * M1 live-test fix (2026-06-29): a long history import (minutes, for hundreds
 * of conversations) showed no live progress on the app-ws chat surface — the
 * `app:<user>` import-progress route was a documented no-op in `open/composer.ts`
 * so every progress frame was dropped. The fix fans an `import_progress` frame
 * over app-ws (mirroring `agent_typing` / `work_board_changed`). The envelope
 * type must:
 *   - be a member of the `AppWsOutbound` union (so `registry.send` accepts it);
 *   - carry the locked field shape the React client reads
 *     (`{ v, type, job_id, status, pass, pct, chunks_total_known, body?, ts }`).
 */

import { describe, expect, it } from 'bun:test'

import { InMemoryAppWsSessionRegistry } from '../session-registry.ts'
import type { AppWsOutbound, AppWsOutboundImportProgress } from '../envelope.ts'

describe('AppWsOutboundImportProgress', () => {
  it('is a member of the AppWsOutbound union', () => {
    const progress: AppWsOutboundImportProgress = {
      v: 1,
      type: 'import_progress',
      job_id: 'job-1',
      status: 'pass1-running',
      pass: 1,
      pct: 0.42,
      chunks_total_known: true,
      body: 'reading conversation 73 of 173…',
      ts: 1,
    }
    const env: AppWsOutbound = progress
    expect(env.type).toBe('import_progress')
  })

  it('is optional on body (count-only / streaming case)', () => {
    const progress: AppWsOutboundImportProgress = {
      v: 1,
      type: 'import_progress',
      job_id: 'job-2',
      status: 'pass2-running',
      pass: 2,
      pct: 0,
      chunks_total_known: false,
      ts: 2,
    }
    expect(progress.body).toBeUndefined()
  })

  it('fans to the owner topic through registry.send', () => {
    const registry = new InMemoryAppWsSessionRegistry()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const env: AppWsOutboundImportProgress = {
      v: 1,
      type: 'import_progress',
      job_id: 'job-3',
      status: 'pass1-running',
      pass: 1,
      pct: 0.5,
      chunks_total_known: true,
      body: 'reading conversation 87 of 173…',
      ts: 3,
    }
    const ok = registry.send('app:sam', env)
    expect(ok).toBe(true)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      type: 'import_progress',
      job_id: 'job-3',
      status: 'pass1-running',
      pass: 1,
      pct: 0.5,
      chunks_total_known: true,
      body: 'reading conversation 87 of 173…',
    })
  })
})
