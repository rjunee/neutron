/** Run every Linux Bun invocation in one authenticated PID namespace.
 * Replaying the original invocation preserves case names, shared hooks, filters,
 * timeouts and counts. No test module has loaded at this preload boundary. */
import { spawnSync } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'
import { assertProcessTestIsolation, processTestLauncher } from '@neutronai/trident/process-test-isolation.ts'

if (process.platform === 'linux') {
  // Bun's process.argv omits test CLI flags. The kernel retains the actual argv,
  // including -t and --timeout; copying process.argv silently changes coverage.
  const argv = readFileSync('/proc/self/cmdline', 'utf8').replace(/\0$/, '').split('\0')
  // Any fixture can transitively invoke a real process census. Its world must
  // not depend on test filenames or on whether the invoking host is provisioned.
  // The launcher also masks protected host authority in its private mount.
  let isolated = false
  try { assertProcessTestIsolation(); isolated = true } catch { /* establish it below */ }
  if (!isolated) {
    const result = spawnSync('python3', ['-B', processTestLauncher, '--parent-pid', String(process.pid), '--', process.execPath, ...argv.slice(1)], {
      stdio: 'inherit', env: { ...process.env },
    })
    if (result.error) console.error('Process test isolation launcher failed:', result.error.message)
    // A namespace refusal cannot turn into a skip, fallback, or passing suite.
    process.exit(result.status ?? 3)
  }
  console.error(`Process test isolation verified: ${readlinkSync('/proc/self/ns/pid')} ${readlinkSync('/proc/self/ns/mnt')}`)
}
