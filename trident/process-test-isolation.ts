/** Test support only. The Python verifier reads kernel evidence; there is no
 * environment switch that can authorize a process-signalling fixture. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const processTestLauncher = fileURLToPath(new URL('./process-test-isolation.py', import.meta.url))

const physicalSuites = [
  'trident/lane-processes.test.ts', 'trident/host-suite.test.ts',
  'trident/codex-build.test.ts', 'open/__tests__/project-build-e2e.test.ts',
]
const valueOptions = new Set(['-t', '--test-name-pattern', '--timeout', '--rerun-each', '--retry',
  '--seed', '--coverage-reporter', '--coverage-dir', '--bail', '--reporter', '--reporter-outfile',
  '--max-concurrency', '--path-ignore-patterns', '--changed', '--parallel', '--parallel-delay', '--shard',
  '--preload', '--require', '--import', '-r', '--config'])
const switches = new Set(['-u', '--update-snapshots', '--todo', '--only', '--pass-with-no-tests',
  '--concurrent', '--randomize', '--coverage', '--dots', '--only-failures', '--isolate', '--test-worker'])

/** Unknown CLI shapes take the boundary too. Entry-point assertions independently
 * refuse any physical suite reached by an alternate loader or renamed fixture. */
export function needsProcessTestIsolation(argv: string[], cwd: string): boolean {
  const test = argv.indexOf('test', 1)
  if (test < 0) return true
  const patterns: string[] = []
  for (let i = test + 1; i < argv.length; i++) {
    const arg = argv[i]!
    const option = arg.split('=', 1)[0]!
    if (valueOptions.has(option)) {
      if (!arg.includes('=')) i++
    } else if (switches.has(arg)) continue
    else if (arg.startsWith('-')) return true
    else patterns.push(arg.replace(/^\.\//, '').replace(/\/$/, ''))
  }
  if (patterns.length === 0) return true
  return patterns.some(pattern => physicalSuites.some(suite => {
    const basename = suite.slice(suite.lastIndexOf('/') + 1)
    return pattern === '.' || suite.includes(pattern) || pattern.endsWith('/' + basename)
      || `${cwd}/${suite}`.startsWith(pattern + '/')
  }))
}

export function assertProcessTestIsolation(): void {
  const result = spawnSync('python3', ['-B', processTestLauncher, '--check'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error('Process test isolation refused: private PID and proc namespaces required', { cause: result.error })
  }
}
