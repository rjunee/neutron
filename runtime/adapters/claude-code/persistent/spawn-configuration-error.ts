import type { SubstrateClassed } from './classify-spawn-error.ts'

/** A local launch precondition failed before a child could be started safely. */
export class SpawnConfigurationError extends Error implements SubstrateClassed {
  readonly substrateErrorClass = 'spawn_configuration' as const
}

export function requireReplCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd.trim().length === 0) {
    throw new SpawnConfigurationError('persistent-repl: explicit cwd is required; refusing to launch in the service directory')
  }
  return cwd
}
