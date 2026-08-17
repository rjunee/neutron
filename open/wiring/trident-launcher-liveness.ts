import { deriveReplSupervisionPaths } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { probeLauncherGenerationAlive } from '@neutronai/runtime/adapters/claude-code/persistent/supervision.ts'
import type { LauncherLiveness, TridentLivenessProbe } from '@neutronai/trident/tick.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'

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
      return known.every((answer) => answer === known[0]) ? known[0]! : 'unknown'
    } catch {
      // A probe outage or unreadable registry is ambiguity, never death evidence.
      return 'unknown'
    }
  }
}
