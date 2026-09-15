import { join } from 'node:path'
import type { GateResult } from './build-run.ts'
import { ownLeakGateScript, runLeakGatePreflight } from './leak-preflight.ts'
import { withProjectPolicyDirectory } from './project-policy-resources.ts'

type Input = Pick<Parameters<typeof runLeakGatePreflight>[0], 'run_host' | 'repo_path' | 'branch' | 'head' | 'base_sha'>

/** root belongs to the host, outside worker writable roots. The trusted scanner
 * is resolved from the installation, never supplied by the scanned project. */
export async function runProjectLeakSource(input: Input, root: string): Promise<GateResult> {
  try {
    if (![input.head, input.base_sha].every(value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) || !input.repo_path.trim() || !input.branch.trim()) {
      return { kind: 'unknown', detail: 'Leak source: repository, branch or full revision pins are missing' }
    }
    return await withProjectPolicyDirectory(root, async directory => {
      const gate = ownLeakGateScript()
      if (!gate) return { kind: 'unknown', detail: 'Leak source: trusted installation scanner is missing' }
      const result = await runLeakGatePreflight({ ...input, scratch_dir: join(directory, 'tree'), gate_script: gate, max_fix_attempts: 0,
        run_host: async (argv, cwd, env, timeout) => {
          const observed = await input.run_host(argv, cwd, env, timeout)
          if (observed.timed_out || (!observed.ok && observed.exit_code === 0)) return { ...observed, ok: false, stdout: '', exit_code: 2 }
          return observed
        },
      })
      if (result.status === 'clean') return { kind: 'allow' }
      if (result.status === 'findings-unresolved') return { kind: 'blocked', on: 'Leak source: recorded findings require correction' }
      return { kind: 'unknown', detail: `Leak source: ${result.status}: ${result.note}` }
    })
  } catch (error) { return { kind: 'unknown', detail: `Leak source: ${String(error)}` } }
}
