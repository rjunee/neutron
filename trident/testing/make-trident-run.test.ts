import { describe, expect, test } from 'bun:test'
import { makeTridentRun } from './make-trident-run.ts'

describe('makeTridentRun', () => {
  test('defaults are complete and stable', () => {
    expect(makeTridentRun()).toMatchObject({
      id: 'id-1',
      slug: 'slug-1',
      phase: 'forge-init',
      merge_mode: 'local',
      channel_kind: 'telegram',
      brief_alert: null,
      harvested_at: null,
      crash_recoveries: 0,
      reviewed_head: null,
      bound_pr: null,
      fenced_paths: null,
    })
  })

  test('overrides win and defaults survive', () => {
    const r = makeTridentRun({ phase: 'argus', pr: 7, branch: 'trident/x' })
    expect(r.phase).toBe('argus')
    expect(r.pr).toBe(7)
    expect(r.branch).toBe('trident/x')
    expect(r.slug).toBe('slug-1')
    expect(r.crash_recoveries).toBe(0)
  })

  test('each call returns a fresh object', () => {
    const a = makeTridentRun()
    a.phase = 'done'
    expect(makeTridentRun().phase).toBe('forge-init')
    expect(makeTridentRun()).not.toBe(a)
  })
})
