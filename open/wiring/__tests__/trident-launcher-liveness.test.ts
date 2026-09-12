import { describe, expect, test } from 'bun:test'
import type { TridentRun } from '@neutronai/trident/store.ts'
import { buildTridentLauncherLivenessProbe } from '../trident-launcher-liveness.ts'

const run = (over: Partial<TridentRun> = {}): TridentRun =>
  ({ workflow_run_id: 'gen-1', worktree: '/worktree', repo_path: '/repo', ...over }) as TridentRun

describe('buildTridentLauncherLivenessProbe', () => {
  test('probes every candidate before returning a known answer', async () => {
    const seen: string[] = []
    const probe = buildTridentLauncherLivenessProbe({
      derive_registry_path: (home) => `${home}/registry`,
      probe: (_key, path) => {
        seen.push(path)
        return 'alive'
      },
    })
    expect(await probe(run())).toBe('alive')
    expect(seen).toEqual(['/worktree/registry', '/repo/registry'])
  })

  test('derives the production registry path for every run home', async () => {
    const seen: string[] = []
    const probe = buildTridentLauncherLivenessProbe({
      probe: (_key, path) => {
        seen.push(path)
        return 'alive'
      },
    })

    expect(await probe(run())).toBe('alive')
    expect(seen).toEqual([
      '/worktree/.neutron/repl-registry.json',
      '/repo/.neutron/repl-registry.json',
    ])
  })

  test('falls back from an unknown worktree registry to a dead repo registry', async () => {
    const seen: string[] = []
    const probe = buildTridentLauncherLivenessProbe({
      derive_registry_path: (home) => home,
      probe: (_key, path) => {
        seen.push(path)
        return path === '/repo' ? 'dead' : 'unknown'
      },
    })
    expect(await probe(run())).toBe('dead')
    expect(seen).toEqual(['/worktree', '/repo'])
  })

  test('returns unknown when every candidate is unknown', async () => {
    const probe = buildTridentLauncherLivenessProbe({ probe: () => 'unknown' })
    expect(await probe(run())).toBe('unknown')
  })

  test('returns unknown when candidate registries disagree', async () => {
    const probe = buildTridentLauncherLivenessProbe({
      derive_registry_path: (home) => home,
      probe: (_key, path) => (path === '/worktree' ? 'dead' : 'alive'),
    })
    expect(await probe(run())).toBe('unknown')
  })

  // ─── #518: the attributed death ──────────────────────────────────────────────

  test('carries killed-by-gateway-shutdown through unanimously', async () => {
    const probe = buildTridentLauncherLivenessProbe({
      derive_registry_path: (home) => home,
      probe: () => 'killed-by-gateway-shutdown',
    })
    expect(await probe(run())).toBe('killed-by-gateway-shutdown')
  })

  test('dead in one home + killed-by-gateway-shutdown in the other is NOT a disagreement', async () => {
    // Both answers positively say the process is gone; only ONE registry carries the
    // marker, which is evidence the other simply lacks. Folding that into 'unknown'
    // would strand a build the probe had confirmed dead in both homes until the
    // 90-minute reaper — a REGRESSION against main, where both answered 'dead'.
    //
    // RED-mutation: drop the dead-flavour arm and return 'unknown' on any
    // disagreement. This reddens; the genuine disagreement case above stays green.
    const probe = buildTridentLauncherLivenessProbe({
      derive_registry_path: (home) => home,
      probe: (_key, path) => (path === '/worktree' ? 'dead' : 'killed-by-gateway-shutdown'),
    })
    expect(await probe(run())).toBe('killed-by-gateway-shutdown')
  })

  test('alive in one home still beats an attributed death in the other', async () => {
    // The attribution arm must not smuggle a reap past the ambiguity rule. A live
    // process anywhere is still ambiguity, never permission to kill.
    const probe = buildTridentLauncherLivenessProbe({
      derive_registry_path: (home) => home,
      probe: (_key, path) => (path === '/worktree' ? 'alive' : 'killed-by-gateway-shutdown'),
    })
    expect(await probe(run())).toBe('unknown')
  })

  test('does not probe a missing generation key', async () => {
    let calls = 0
    const probe = buildTridentLauncherLivenessProbe({ probe: () => (++calls, 'dead') })
    expect(await probe(run({ workflow_run_id: null }))).toBe('unknown')
    expect(await probe(run({ workflow_run_id: '' }))).toBe('unknown')
    expect(calls).toBe(0)
  })

  test('deduplicates identical worktree and repo paths', async () => {
    let calls = 0
    const probe = buildTridentLauncherLivenessProbe({ probe: () => (++calls, 'unknown') })
    expect(await probe(run({ worktree: '/same', repo_path: '/same' }))).toBe('unknown')
    expect(calls).toBe(1)
  })

  test('converts a thrown probe error to unknown', async () => {
    const probe = buildTridentLauncherLivenessProbe({
      probe: () => {
        throw new Error('registry unavailable')
      },
    })
    await expect(probe(run())).resolves.toBe('unknown')
  })
})
