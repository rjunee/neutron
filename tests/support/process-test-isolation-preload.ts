/** Run a physical process suite's entire Bun invocation in one PID namespace.
 * Replaying the original invocation preserves case names, shared hooks, filters,
 * timeouts and counts. No test module has loaded at this preload boundary. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { assertProcessTestIsolation, needsProcessTestIsolation, processTestLauncher } from '@neutronai/trident/process-test-isolation.ts'

if (process.platform === 'linux') {
  // Bun's process.argv omits test CLI flags. The kernel retains the actual argv,
  // including -t and --timeout; copying process.argv silently changes coverage.
  const argv = readFileSync('/proc/self/cmdline', 'utf8').replace(/\0$/, '').split('\0')
  // A provisioned host's protected relay registration must not authenticate
  // synthetic children or turn credentialless fixtures into registered installs.
  // The launcher masks it in a private mount; explicit relay fixtures stay real.
  if (needsProcessTestIsolation(argv, process.cwd()) || existsSync('/etc/neutron/claude-capacity')) {
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
}
