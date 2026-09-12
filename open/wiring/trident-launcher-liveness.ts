import { deriveReplSupervisionPaths } from '@neutronai/runtime/adapters/claude-code/index.ts'
import {
  probeLauncherGenerationAlive,
  type LauncherGenerationLiveness,
} from '@neutronai/runtime/adapters/claude-code/persistent/supervision.ts'
import type { LauncherLiveness, TridentLivenessProbe } from '@neutronai/trident/tick.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'

/**
 * The runtime layer may not import trident, so `LauncherGenerationLiveness`
 * (`persistent/supervision.ts`) and `LauncherLiveness` (`trident/tick.ts`) are two
 * declarations of one union. THIS seam is where they meet, so this is where the
 * identity is checked: both assignments must hold, which fails to compile the
 * moment either side gains or loses a member. Without it, adding a verdict on one
 * side would silently widen or narrow what trident's tick can be handed — and the
 * member added by #518 is precisely the one whose absence turns a deploy back into
 * a reported crash.
 */
const _runtimeVerdictIsTridentVerdict: LauncherLiveness = null as unknown as LauncherGenerationLiveness
const _tridentVerdictIsRuntimeVerdict: LauncherGenerationLiveness = null as unknown as LauncherLiveness
void _runtimeVerdictIsTridentVerdict
void _tridentVerdictIsRuntimeVerdict

export function buildTridentLauncherLivenessProbe(opts?: {
  probe?: (generationKey: string, replRegistryPath: string) => LauncherLiveness
  derive_registry_path?: (home: string) => string
}): TridentLivenessProbe {
  const probe = opts?.probe ?? probeLauncherGenerationAlive
  const deriveRegistryPath =
    opts?.derive_registry_path ?? ((home: string) => deriveReplSupervisionPaths(home).replRegistryPath)

  return async (run: TridentRun): Promise<LauncherLiveness> => {
    try {
      const key = run.workflow_run_id
      if (typeof key !== 'string' || key.length === 0) return 'unknown'

      // A fresh fire launches from repo_path; a continuation may launch from its
      // worktree. Generation UUIDs are per spawn, so either registry can answer
      // authoritatively without creating cross-registry false positives.
      const homes = [...new Set([run.worktree, run.repo_path])].filter(
        (home): home is string => typeof home === 'string' && home.length > 0,
      )
      const answers = homes.map((home) => probe(key, deriveRegistryPath(home)))
      const known = answers.filter((answer) => answer !== 'unknown')
      if (known.length === 0) return 'unknown'
      // A continuation can leave records in both homes. Probe both: disagreement
      // is ambiguity, never permission to reap a possibly-live build.
      const distinct = new Set(known)
      if (distinct.size === 1) return known[0]!
      // #518 — EXCEPT that `'dead'` and `'killed-by-gateway-shutdown'` are not a
      // disagreement about liveness. Both positively say the process is gone; they
      // differ only on WHOSE doing it was, and the gateway-shutdown marker living in
      // one registry is evidence the other simply does not carry. Folding that into
      // `'unknown'` would strand a build the probe had in fact confirmed dead in BOTH
      // homes, waiting out the 90-minute reaper. Death is unanimous, so report it —
      // with the attribution, which is the more specific of the two answers.
      if ([...distinct].every((answer) => answer === 'dead' || answer === 'killed-by-gateway-shutdown')) {
        return 'killed-by-gateway-shutdown'
      }
      return 'unknown'
    } catch {
      // A probe outage or unreadable registry is ambiguity, never death evidence.
      return 'unknown'
    }
  }
}
