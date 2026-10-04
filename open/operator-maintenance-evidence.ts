import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readProcessIdentity, type ProcessIdentity } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import { assertRootProtectedPath } from './native-host-recovery-authority.ts'

export interface MaintenanceProcess { pid: number; identity: ProcessIdentity }
export interface MaintenanceDeployment {
  codeRoot: string
  entrypoint: string
  revision: string
  port: number
  ownerHandle: string
}

export function sameMaintenanceProcess(a: MaintenanceProcess, b: MaintenanceProcess): boolean {
  return a.pid === b.pid && a.identity.boot_id === b.identity.boot_id && a.identity.start_ticks === b.identity.start_ticks
}

export function observeMaintenanceProcess(pid: number): MaintenanceProcess {
  const identity = readProcessIdentity(pid)
  if (!identity) throw new Error('Process identity unavailable')
  return { pid, identity }
}

/** Positive absence for a transcript, never an inferred historical PID exit.
 * Any SID-bearing argv (including an unfamiliar launcher) refuses. A denied or
 * malformed process read is unknown; only a concurrently disappeared PID skips.
 * Seeing this scanner's own argv is the positive control for an empty result. */
export function assertNoMaintenanceTranscriptOwner(sessionId: string): void {
  if (!sessionId) throw new Error('Transcript census is unknown')
  let sawSelf = false
  for (const name of readdirSync('/proc')) {
    if (!/^[1-9][0-9]*$/.test(name)) continue
    let argv: string
    try { argv = readFileSync(`/proc/${name}/cmdline`, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error('Transcript census is unknown')
    }
    if (Number(name) === process.pid && argv.length > 0) sawSelf = true
    if (argv.includes(sessionId)) throw new Error('Transcript still has a possible process owner')
  }
  if (!sawSelf) throw new Error('Transcript census is unknown')
}

/** Unreadable is not dead. A recycled PID is not the recorded process. */
export function maintenanceProcessGone(process: MaintenanceProcess): boolean {
  try {
    lstatSync(`/proc/${process.pid}`)
    return !sameMaintenanceProcess(process, observeMaintenanceProcess(process.pid))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trimEnd()
}

/** A sampled process must have started AFTER every tracked served-tree file.
 * Whole-tree identity alone cannot prove that a live process loaded those bytes. */
function verifyMaintenanceGatewayFiles(target: MaintenanceDeployment, current: MaintenanceProcess): void {
  if (!/^[a-f0-9]{40}$/.test(target.revision) || !isAbsolute(target.codeRoot)
    || realpathSync(target.codeRoot) !== target.codeRoot || target.entrypoint !== join(target.codeRoot, 'open/server.ts')
    || !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error('Invalid deployment identity')
  assertRootProtectedPath(target.entrypoint, 'file')
  const argv = readFileSync(`/proc/${current.pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
  const cwd = readlinkSync(`/proc/${current.pid}/cwd`)
  if (!argv.slice(1).some(arg => resolve(cwd, arg) === target.entrypoint)) throw new Error('Gateway entrypoint mismatch')
  if (git(target.codeRoot, ['rev-parse', 'HEAD']) !== target.revision
    || git(target.codeRoot, ['status', '--porcelain', '--untracked-files=no']) !== '') throw new Error('Deployment tree differs from target')
  const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
  const boot = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))
  if (!boot || !Number.isSafeInteger(ticks) || ticks <= 0) throw new Error('Process start time unavailable')
  const started = Number(boot[1]) * 1000 + current.identity.start_ticks * 1000 / ticks
  const paths = git(target.codeRoot, ['ls-files', '-z']).split('\0').filter(Boolean)
  if (paths.length === 0) throw new Error('Deployment tree unavailable')
  for (const name of paths) {
    const path = join(target.codeRoot, name)
    const info = lstatSync(path)
    // Mutable source is not a served-code identity. Symlinks must resolve to a
    // protected file too; Git already verified their exact recorded target.
    assertRootProtectedPath(info.isSymbolicLink() ? realpathSync(path) : path, 'file')
    if (info.mtimeMs >= started || info.ctimeMs >= started) throw new Error('Gateway predates deployed source')
  }
}

/** Independently derive the canonical migration owner from the actual protected
 * old gateway image. The bootstrap artifact can be elsewhere, but cannot claim
 * to be this database's normal migration owner. */
export function maintenanceOwnerDirectory(target: MaintenanceDeployment, current: MaintenanceProcess): string {
  verifyMaintenanceGatewayFiles({ ...target, revision: git(target.codeRoot, ['rev-parse', 'HEAD']) }, current)
  const owner = join(target.codeRoot, 'migrations')
  if (realpathSync(owner) !== owner) throw new Error('Migration owner mismatch')
  assertRootProtectedPath(join(owner, 'runner.ts'), 'file')
  return owner
}

export function verifyMaintenanceDeploymentFiles(target: MaintenanceDeployment, current: MaintenanceProcess): void {
  verifyMaintenanceGatewayFiles(target, current)
  const route = readFileSync(join(target.codeRoot, 'runtime/workers/claude-capacity-client.ts'), 'utf8')
  const launcher = readFileSync(join(target.codeRoot, 'runtime/adapters/claude-code/persistent/native-request-relay.ts'), 'utf8')
  if (!route.includes('native-relay-v3:') || !route.includes('http://127.0.0.1:0')
    || !launcher.includes('routed.ANTHROPIC_BASE_URL = NATIVE_RELAY_BASE_URL')) throw new Error('Target native protocol unavailable')
}

/** Correlate the listener inode with this exact process's descriptors. A healthy
 * response on somebody else's port never authorizes release. */
export function maintenanceSocketOwned(pid: number, port: number): boolean {
  const sockets = new Set(readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
    try { const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); return match ? [match[1]!] : [] }
    catch { return [] }
  }))
  const wanted = port.toString(16).toUpperCase().padStart(4, '0')
  const matches = ['/proc/net/tcp', '/proc/net/tcp6'].flatMap(path => readFileSync(path, 'utf8').trim().split('\n').slice(1))
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields[1]?.split(':')[1] === wanted && fields[3] === '0A')
  return matches.length > 0 && matches.every(fields => sockets.has(fields[9]!))
}

export async function verifyMaintenanceDeployment(target: MaintenanceDeployment, pid: number,
  prior: MaintenanceProcess): Promise<MaintenanceProcess> {
  const current = observeMaintenanceProcess(pid)
  if (sameMaintenanceProcess(prior, current) || current.identity.boot_id !== prior.identity.boot_id) throw new Error('Gateway was not replaced in this boot')
  verifyMaintenanceDeploymentFiles(target, current)
  if (!maintenanceSocketOwned(pid, target.port)) throw new Error('Gateway listener ownership unavailable')
  const response = await fetch(`http://127.0.0.1:${target.port}/healthz`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
  const body = await response.json() as { status?: unknown; project_slug?: unknown }
  if (!response.ok || body.status !== 'ok' || body.project_slug !== target.ownerHandle) throw new Error('Gateway health identity mismatch')
  if (!sameMaintenanceProcess(current, observeMaintenanceProcess(pid)) || !maintenanceSocketOwned(pid, target.port)) throw new Error('Gateway changed during verification')
  verifyMaintenanceDeploymentFiles(target, current)
  return current
}
