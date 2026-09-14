import { describe, expect, it } from 'bun:test'
import { countActiveBuildRuns, type FleetSnapshot } from '@neutronai/trident/active-runs.ts'

const stripComments = (source: string): string =>
  source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')

const snapshot = (lanes: number): FleetSnapshot => ({
  status: 'known',
  reason: null,
  lanes: Array.from({ length: lanes }, (_, index) => ({
    id: `lane-${index}`,
    run_id: null,
    owner: 'live',
    processes: [{ pid: index + 10, started_at: 1_000, cwd: '/tmp/build' }],
  })),
})

describe('/status active-build census wiring', () => {
  it('uses the shared process census, not non-terminal row count', async () => {
    const source = stripComments(await Bun.file(new URL('../composer.ts', import.meta.url)).text())
    const bindStart = source.indexOf('statusSnapshotHolder.bind(')
    const bindEnd = source.indexOf('setMemoryIndexWorkHandles(', bindStart)
    const binding = source.slice(bindStart, bindEnd)

    expect(bindStart).toBeGreaterThan(-1)
    expect(bindEnd).toBeGreaterThan(bindStart)
    expect(binding).toContain('const activeTridentRuns = countActiveBuildRuns()')
    expect(binding).not.toContain('boardRunStore.listNonTerminal()')
    expect(source).toContain("from '@neutronai/trident/active-runs.ts'")
  })

  it('preserves exact zero and live counts while stale rows cannot contribute', () => {
    const staleRows = Array.from({ length: 7 }, () => ({ phase: 'forge-init' }))
    expect(staleRows).toHaveLength(7)
    expect(countActiveBuildRuns(() => snapshot(0))).toBe(0)
    expect(countActiveBuildRuns(() => snapshot(3))).toBe(3)
  })

  it('keeps census failure distinct from the exact count zero', () => {
    expect(() =>
      countActiveBuildRuns(() => ({ status: 'unknown', reason: 'census offline', lanes: [] })),
    ).toThrow('census offline')
  })
})
