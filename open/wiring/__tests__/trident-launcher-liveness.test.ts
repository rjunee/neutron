import { describe, expect, test } from 'bun:test'
import type { TridentRun } from '@neutronai/trident/store.ts'
import { buildTridentLauncherLivenessProbe } from '../trident-launcher-liveness.ts'
import type { LauncherLiveness } from '@neutronai/trident/tick.ts'

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

  // ─── #518: the merge, as TWO questions with the full cross-product ─────────────
  //
  // The matrix used to hold the two mixed rows that happened to be written, and the
  // value added in round 8 was in the vocabulary, the writers and the readers but not
  // here — the COMBINER, a fourth place. A merge function is not a reader of one entry,
  // it is a reader of two verdicts, which is why it fell outside the call-site audit.
  //
  // Enumerated rather than remembered: every unordered pair over the five verdicts, plus
  // the singletons. Both orderings of each pair are asserted, because the merge must not
  // depend on which home answered first.
  const VERDICTS: LauncherLiveness[] = ['alive', 'unknown', 'dead', 'killed-by-gateway-shutdown', 'dead-cause-undetermined']

  /** The full expected table. Keys are sorted pairs so the matrix is order-free. */
  const EXPECTED: Record<string, LauncherLiveness> = {
    // Singletons (both homes agree).
    'alive|alive': 'alive',
    'unknown|unknown': 'unknown',
    'dead|dead': 'dead',
    'killed-by-gateway-shutdown|killed-by-gateway-shutdown': 'killed-by-gateway-shutdown',
    'dead-cause-undetermined|dead-cause-undetermined': 'dead-cause-undetermined',
    // `unknown` is not an answer: the OTHER home decides alone.
    'alive|unknown': 'alive',
    'dead|unknown': 'dead',
    'killed-by-gateway-shutdown|unknown': 'killed-by-gateway-shutdown',
    'dead-cause-undetermined|unknown': 'dead-cause-undetermined',
    // QUESTION 1 — a live process anywhere forbids reaping. Ambiguity, never permission.
    'alive|dead': 'unknown',
    'alive|killed-by-gateway-shutdown': 'unknown',
    'alive|dead-cause-undetermined': 'unknown',
    // QUESTION 2 — death unanimous; the attribution merged on its own rule.
    //   a non-observation never overrides an observation:
    'dead-cause-undetermined|killed-by-gateway-shutdown': 'killed-by-gateway-shutdown',
    //   the claim both homes support (plain `dead` would make the tick assert a crash
    //   one home has evidence against):
    'dead|dead-cause-undetermined': 'dead-cause-undetermined',
    //   two POSITIVE, contradicting attributions → disputed, reported as undetermined:
    'dead|killed-by-gateway-shutdown': 'dead-cause-undetermined',
  }

  const keyFor = (a: LauncherLiveness, b: LauncherLiveness): string => [a, b].sort().join('|')

  test('the full cross-product of two homes is covered, and is order-free', async () => {
    // RED-mutation: collapse the liveness rule back to the two-value set
    // (`answer === 'dead' || answer === 'killed-by-gateway-shutdown'`) — the
    // `dead|dead-cause-undetermined` row reds on its own.
    const seen = new Set<string>()
    for (const a of VERDICTS) {
      for (const b of VERDICTS) {
        const expected = EXPECTED[keyFor(a, b)]
        expect(expected, `no expectation declared for ${keyFor(a, b)}`).toBeDefined()
        seen.add(keyFor(a, b))
        const probe = buildTridentLauncherLivenessProbe({
          derive_registry_path: (home) => home,
          probe: (_key, path) => (path === '/worktree' ? a : b),
          log: () => {},
        })
        expect(await probe(run()), `${a} + ${b}`).toBe(expected as LauncherLiveness)
      }
    }
    // Every declared row was exercised, and no row was declared that the loop cannot
    // reach — the matrix is the cross-product, not a subset of it.
    expect(seen.size).toBe(Object.keys(EXPECTED).length)
    expect(Object.keys(EXPECTED).length).toBe((VERDICTS.length * (VERDICTS.length + 1)) / 2)
  })

  test('a dead + dead-cause-undetermined pair is DEATH, not ambiguity', async () => {
    // The stranding repro, as its own case so the mutation run shows it reddening alone:
    // both verdicts positively establish death, so folding them into `unknown` left the
    // tick ignoring a run it had confirmed dead in both homes.
    const probe = buildTridentLauncherLivenessProbe({
      derive_registry_path: (home) => home,
      probe: (_key, path) => (path === '/worktree' ? 'dead' : 'dead-cause-undetermined'),
      log: () => {},
    })
    expect(await probe(run())).toBe('dead-cause-undetermined')
  })

  test('a non-observation never overrides an observation', async () => {
    // RED-mutation: return `'dead-cause-undetermined'` whenever the set is mixed — the
    // observed kill would then be discarded in favour of a failure to sample.
    const probe = buildTridentLauncherLivenessProbe({
      derive_registry_path: (home) => home,
      probe: (_key, path) => (path === '/worktree' ? 'dead-cause-undetermined' : 'killed-by-gateway-shutdown'),
      log: () => {},
    })
    expect(await probe(run())).toBe('killed-by-gateway-shutdown')
  })

  test('two POSITIVE conflicting attributions are reported as disputed, not coin-flipped', async () => {
    // RED-mutation: `if (verdicts.has('killed-by-gateway-shutdown')) return it` BEFORE
    // the dispute check — the conflict is then silently resolved in favour of the deploy,
    // which is what an earlier revision did.
    const lines: string[] = []
    const probe = buildTridentLauncherLivenessProbe({
      derive_registry_path: (home) => home,
      probe: (_key, path) => (path === '/worktree' ? 'dead' : 'killed-by-gateway-shutdown'),
      log: (m) => lines.push(m),
    })
    // The death is reported — a disagreement about WHY must not strand the run...
    expect(await probe(run())).toBe('dead-cause-undetermined')
    // ...and the operator sees the disagreement rather than its outcome only.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('DISAGREE')
    expect(lines[0]).toContain('UNDETERMINED')
  })

  test('agreement is never logged as a disagreement', async () => {
    const lines: string[] = []
    const probe = buildTridentLauncherLivenessProbe({
      derive_registry_path: (home) => home,
      probe: () => 'killed-by-gateway-shutdown',
      log: (m) => lines.push(m),
    })
    expect(await probe(run())).toBe('killed-by-gateway-shutdown')
    expect(lines).toEqual([])
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
