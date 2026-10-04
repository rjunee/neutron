/** Test support only. The Python verifier reads kernel evidence; there is no
 * environment switch that can authorize a process-signalling fixture. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const processTestLauncher = fileURLToPath(new URL('./process-test-isolation.py', import.meta.url))

export function assertProcessTestIsolation(): void {
  const result = spawnSync('python3', ['-B', processTestLauncher, '--check'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error('Process test isolation refused: private PID and proc namespaces required', { cause: result.error })
  }
}
