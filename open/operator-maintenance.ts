import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmissionStore, type ProjectAdmissionScope } from '@neutronai/gateway/project-admission-store.ts'
import { parseRegistryContents, type ReplRegistryRecord } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import { assertOperatorMaintenanceSchema, installOperatorMaintenanceGuard, operatorMaintenanceArtifact, type OperatorMaintenanceArtifact } from '@neutronai/migrations/operator-maintenance.ts'
import { assertRootProtectedPath } from './native-host-recovery-authority.ts'
import { assertNoMaintenanceTranscriptOwner, maintenanceOwnerDirectory, maintenanceProcessGone, maintenanceSocketOwned, observeMaintenanceProcess, sameMaintenanceProcess,
  verifyMaintenanceDeployment, type MaintenanceDeployment, type MaintenanceProcess } from './operator-maintenance-evidence.ts'

export interface MaintenanceRequest {
  version: 1
  operationId: string
  dbPath: string
  registryPath: string
  pendingRespawnsPath: string
  scope: ProjectAdmissionScope
  sessionKey: string
  sessionId: string
  childGeneration: string
  childPid: number
  gatewayPid: number
  artifact: OperatorMaintenanceArtifact
  deployment: MaintenanceDeployment
}
interface OwnerObservation { generation: string; process: MaintenanceProcess }
interface CompletedSleepObservation { generation: string; asleepAt: number; channelName: string }
interface Audit {
  stage: 'prepared'
  request: MaintenanceRequest
  gateway: MaintenanceProcess
  owners: OwnerObservation[]
  bootstrap: OperatorMaintenanceArtifact
  ownerDirectory: string
  completedSleep?: CompletedSleepObservation
}

/** No symlink/FIFO read can turn uncertainty into absence or block root. The
 * descriptor and directory entry must still be the same regular bounded file. */
function readRegularMaintenanceFile(path: string, absent = false): string | undefined {
  let entry
  try { entry = lstatSync(path) } catch (error) {
    if (absent && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Maintenance file is unreadable')
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 16 * 1024 * 1024) throw new Error('Maintenance file is not a bounded regular file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.size) throw new Error('Maintenance file changed')
    const contents = readFileSync(fd, 'utf8'), after = fstatSync(fd), current = lstatSync(path)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.dev !== before.dev || current.ino !== before.ino) throw new Error('Maintenance file changed')
    return contents
  } finally { closeSync(fd) }
}

export function requireMaintenanceRoot(uid = process.geteuid?.()): void {
  if (uid !== 0) throw new Error('Operator maintenance requires root')
}

/** Only controlled vocabulary crosses the CLI error boundary. In particular,
 * SQLite, filesystem, HTTP and JSON exceptions can contain private data. */
export function maintenanceRefusalCode(error: unknown): string {
  const codes: Record<string, string> = {
    'Operator maintenance requires root': 'authority.root_required',
    'Invalid maintenance request': 'request.invalid',
    'Maintenance audit is incomplete': 'audit.incomplete',
    'Maintenance audit is invalid': 'audit.invalid',
    'Migration owner mismatch': 'migration.owner_mismatch',
    'Maintenance artifact is not a clean committed tree': 'migration.artifact_mismatch',
    'Maintenance artifact changed after audit': 'migration.artifact_pin_mismatch',
    'Maintenance artifact is unprotected': 'migration.artifact_unprotected',
    'Maintenance schema differs from artifact': 'migration.schema_mismatch',
    'Pending replay is unreadable': 'replay.unreadable',
    'Pending replay is malformed': 'replay.malformed',
    'Pending replay is unknown': 'replay.unknown',
    'Pending replay owns this transcript': 'replay.pending',
    'Maintenance transcript identity mismatch': 'native.transcript_mismatch',
    'Native owner is not the exact available uncapped parent': 'native.owner_unavailable',
    'Previous native owner has not exited': 'native.previous_owner_alive',
    'Scope is unavailable': 'admission.scope_unavailable',
    'Scope is already fenced': 'admission.already_fenced',
    'Exact maintenance hold is unavailable': 'admission.hold_mismatch',
    'Canonical asleep and all recorded native exits are required': 'release.native_not_asleep',
    'Completed sleep observation changed': 'release.sleep_changed',
    'Transcript census is unknown': 'release.census_unknown',
    'Transcript still has a possible process owner': 'release.transcript_owned',
    'Gateway was not replaced in this boot': 'release.gateway_not_replaced',
    'Deployment tree differs from target': 'release.tree_mismatch',
    'Gateway predates deployed source': 'release.stale_process',
    'Gateway listener ownership unavailable': 'release.listener_mismatch',
    'Gateway health identity mismatch': 'release.health_mismatch',
    'Gateway changed during verification': 'release.process_changed',
    'Maintenance release refused': 'release.refused',
  }
  return error instanceof Error ? codes[error.message] ?? 'maintenance.unknown_failure' : 'maintenance.unknown_failure'
}

function protectedAudit(path: string): void {
  assertRootProtectedPath(path, 'file')
  if ((lstatSync(path).mode & 0o777) !== 0o600) throw new Error('Maintenance audit must be mode 0600')
}

function protectedParent(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Maintenance audit path must be canonical')
  let cursor = dirname(path)
  while (true) {
    const info = lstatSync(cursor)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error('Maintenance audit ancestry is unprotected')
    if (cursor === '/') break
    cursor = dirname(cursor)
  }
}

function appendAudit(path: string, value: unknown, create = false): void {
  if (create) protectedParent(path); else protectedAudit(path)
  const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_APPEND
    | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600)
  try { writeSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
}

export function validateMaintenanceRequest(value: unknown): MaintenanceRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid maintenance request')
  const v = value as MaintenanceRequest
  if (v.version !== 1 || !/^[a-f0-9-]{36}$/.test(v.operationId) || !v.scope
    || typeof v.scope.ownerHandle !== 'string' || !v.scope.ownerHandle.trim()
    || !(v.scope.projectId === null || typeof v.scope.projectId === 'string' && v.scope.projectId.trim())
    || ['dbPath', 'registryPath', 'pendingRespawnsPath'].some(k => {
      const p = (v as unknown as Record<string, unknown>)[k]
      return typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p
    }) || ['sessionKey', 'sessionId', 'childGeneration'].some(k => typeof (v as unknown as Record<string, unknown>)[k] !== 'string' || !(v as unknown as Record<string, string>)[k])
    || !Number.isSafeInteger(v.childPid) || v.childPid <= 0
    || !Number.isSafeInteger(v.gatewayPid) || v.gatewayPid <= 0 || !v.deployment
    || v.deployment.ownerHandle !== v.scope.ownerHandle || !/^[a-f0-9]{40}$/.test(v.artifact?.commit)
    || !/^[a-f0-9]{64}$/.test(v.artifact?.contentSha256)) throw new Error('Invalid maintenance request')
  return v
}

/** Unlike the replay loader, one invalid entry is UNKNOWN, not silently dropped.
 * The bytes are never emitted or mutated by the operator tool. */
export function assertNoMaintenanceReplay(path: string, sessionKey: string, sessionId: string): void {
  let raw: string
  try { const observed = readRegularMaintenanceFile(path, true); if (observed === undefined) return; raw = observed }
  catch { throw new Error('Pending replay is unreadable') }
  let rows: unknown
  try { rows = JSON.parse(raw) } catch { throw new Error('Pending replay is malformed') }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object'
    || ['sessionKey', 'sessionId', 'cwd'].some(k => typeof row[k] !== 'string' || !row[k])
    || ['substrate_instance_id', 'droppedInbound', 'topic_id', 'instance_slug', 'turn_id'].some(k => row[k] !== undefined && typeof row[k] !== 'string')
    || row.devchannel_port !== undefined && (!Number.isSafeInteger(row.devchannel_port) || row.devchannel_port < 1 || row.devchannel_port > 65535))) throw new Error('Pending replay is unknown')
  if (rows.some(row => row.sessionKey === sessionKey || row.sessionId === sessionId)) throw new Error('Pending replay owns this transcript')
}

export function readMaintenanceRow(request: MaintenanceRequest): ReplRegistryRecord {
  let invalid = false
  const parsed = parseRegistryContents(readRegularMaintenanceFile(request.registryPath)!, () => { invalid = true })
  if (parsed.kind !== 'loaded' || invalid) throw new Error('Registry is unknown')
  const row = parsed.registry[request.sessionKey]
  if (!row || row.sessionKey !== request.sessionKey || row.sessionId !== request.sessionId
    || row.conversationProjectId !== request.scope.projectId || !row.has_session) throw new Error('Maintenance transcript identity mismatch')
  assertNoMaintenanceReplay(request.pendingRespawnsPath, request.sessionKey, request.sessionId)
  return row
}

function observeOwner(request: MaintenanceRequest, expectedGeneration: string, expectedPid: number): OwnerObservation {
  const row = readMaintenanceRow(request)
  if (row.child_generation !== expectedGeneration || row.pid !== expectedPid || row.asleep_at !== undefined
    || row.capped_at !== undefined || row.respawn_in_flight_at !== undefined || row.spawn_reservation_at !== undefined
    || !row.pane_handle || row.adoption_claim_pid !== request.gatewayPid) throw new Error('Native owner is not the exact available uncapped parent')
  const process = observeMaintenanceProcess(expectedPid)
  const argv = readFileSync(`/proc/${expectedPid}/cmdline`, 'utf8').split('\0')
  if (!argv.some((arg, i) => (arg === '--resume' || arg === '--session-id') && argv[i + 1] === request.sessionId)
    || !argv.some(arg => arg.includes(row.channelName))) throw new Error('Native process does not own this transcript')
  const after = readMaintenanceRow(request)
  if (after.child_generation !== expectedGeneration || after.pid !== expectedPid
    || !sameMaintenanceProcess(process, observeMaintenanceProcess(expectedPid))) throw new Error('Native ownership changed')
  return { generation: expectedGeneration, process }
}

function readAudit(path: string): Audit {
  protectedAudit(path)
  const text = readRegularMaintenanceFile(path)!
  if (!text.endsWith('\n')) throw new Error('Maintenance audit is incomplete')
  const entries = text.trimEnd().split('\n').map(line => JSON.parse(line))
  const initial = entries.shift() as Audit
  validateMaintenanceRequest(initial?.request)
  if (initial.stage !== 'prepared' || !initial.gateway || initial.owners?.length !== 1 || !/^[a-f0-9]{40}$/.test(initial.bootstrap?.commit)
    || !/^[a-f0-9]{64}$/.test(initial.bootstrap?.contentSha256) || initial.ownerDirectory !== resolve(initial.request.deployment.codeRoot, 'migrations')
    || initial.request.artifact.commit !== initial.bootstrap.commit || initial.request.artifact.contentSha256 !== initial.bootstrap.contentSha256) throw new Error('Maintenance audit is invalid')
  for (const entry of entries) {
    if (entry.kind === 'bootstrap-applied' && entry.operationId === initial.request.operationId) continue
    if (entry.kind === 'sleep' && typeof entry.observation?.generation === 'string'
      && Number.isFinite(entry.observation.asleepAt) && typeof entry.observation.channelName === 'string') {
      initial.completedSleep = entry.observation
    } else if (entry.kind === 'owner' && entry.owner?.generation && entry.owner.process?.identity && !initial.completedSleep) initial.owners.push(entry.owner)
    else throw new Error('Maintenance audit is invalid')
  }
  return initial
}

function assertCanonicalMaintenanceAsleep(row: ReplRegistryRecord, generation: string): void {
  if (!generation || row.child_generation !== generation || !Number.isFinite(row.asleep_at) || row.asleep_at! <= 0
    || ['pid', 'pane_handle', 'devchannel_port', 'adoption_claim_by', 'adoption_claim_pid', 'adoption_claim_at',
      'respawn_in_flight_at', 'spawn_reservation_at', 'spawn_reservation_by', 'spawn_reservation_pid', 'capped_at']
      .some(key => (row as unknown as Record<string, unknown>)[key] !== undefined)) {
    throw new Error('Canonical asleep and all recorded native exits are required')
  }
}

export function assertMaintenanceAsleep(request: MaintenanceRequest, owners: OwnerObservation[], gone = maintenanceProcessGone,
  completedSleep?: CompletedSleepObservation): void {
  const row = readMaintenanceRow(request)
  assertCanonicalMaintenanceAsleep(row, completedSleep?.generation ?? owners.at(-1)?.generation ?? '')
  if (!owners.length || !owners.every(o => gone(o.process))) throw new Error('Canonical asleep and all recorded native exits are required')
  if (completedSleep) {
    if (row.asleep_at !== completedSleep.asleepAt || row.channelName !== completedSleep.channelName) throw new Error('Completed sleep observation changed')
    assertNoMaintenanceTranscriptOwner(request.sessionId)
    const after = readMaintenanceRow(request)
    assertCanonicalMaintenanceAsleep(after, completedSleep.generation)
    if (after.asleep_at !== row.asleep_at || after.channelName !== row.channelName) throw new Error('Completed sleep observation changed')
  }
}

export function observeCompletedMaintenanceSleep(request: MaintenanceRequest, owners: OwnerObservation[], generation: string): CompletedSleepObservation {
  const row = readMaintenanceRow(request)
  assertCanonicalMaintenanceAsleep(row, generation)
  const observation = { generation, asleepAt: row.asleep_at!, channelName: row.channelName }
  assertMaintenanceAsleep(request, owners, maintenanceProcessGone, observation)
  return observation
}

/** Local operator control only: no HTTP surface, no token output, no force/kill,
 * no lease/cap/completion writes. Existing canonical lifecycle owns retirement. */
export async function runOperatorMaintenance(args: string[]): Promise<void> {
  requireMaintenanceRoot()
  assertRootProtectedPath(fileURLToPath(import.meta.url), 'file')
  const [command, auditPath, ...rest] = args
  if (!auditPath || !['hold', 'record-owner', 'release'].includes(command ?? '')) throw new Error('Expected hold, record-owner, or release and protected audit path')
  if (command === 'hold') {
    if (rest.length !== 1) throw new Error('Hold requires a protected request file')
    assertRootProtectedPath(rest[0]!, 'file')
    const request = validateMaintenanceRequest(JSON.parse(readRegularMaintenanceFile(rest[0]!)!))
    const gateway = observeMaintenanceProcess(request.gatewayPid)
    const ownerDirectory = maintenanceOwnerDirectory(request.deployment, gateway)
    const argv = readFileSync(`/proc/${gateway.pid}/cmdline`, 'utf8').split('\0')
    if (!argv.includes(request.deployment.entrypoint) || !maintenanceSocketOwned(gateway.pid, request.deployment.port)) throw new Error('Gateway identity unavailable')
    const health = await fetch(`http://127.0.0.1:${request.deployment.port}/healthz`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
    const identity = await health.json() as { status?: string; project_slug?: string }
    if (!health.ok || identity.status !== 'ok' || identity.project_slug !== request.scope.ownerHandle) throw new Error('Gateway scope differs')
    const owner = observeOwner(request, request.childGeneration, request.childPid)
    // Journal identity BEFORE fencing. A crash remains recoverable by the exact
    // operation id; it cannot turn unknown original ownership into an empty set.
    const bootstrap = operatorMaintenanceArtifact()
    if (bootstrap.commit !== request.artifact.commit || bootstrap.contentSha256 !== request.artifact.contentSha256) throw new Error('Maintenance artifact changed after audit')
    appendAudit(auditPath, { stage: 'prepared', request, gateway, owners: [owner], bootstrap, ownerDirectory } satisfies Audit, true)
    const db = ProjectDb.open(request.dbPath, { create: false })
    try {
      const store = new ProjectAdmissionStore(db)
      if (!store.inspect(request.scope) || store.hasPreparedHostTermination(request.scope)) throw new Error('Scope is unavailable')
      await installOperatorMaintenanceGuard(db, ownerDirectory, bootstrap, async tx => {
        observeOwner(request, request.childGeneration, request.childPid)
        if (!sameMaintenanceProcess(gateway, observeMaintenanceProcess(request.gatewayPid))
          || maintenanceOwnerDirectory(request.deployment, gateway) !== ownerDirectory) throw new Error('Gateway changed')
        return !!await store.holdOperatorMaintenanceInTransaction(tx, request.scope, request.operationId)
      })
      appendAudit(auditPath, { kind: 'bootstrap-applied', operationId: request.operationId })
    } finally { db.close() }
  } else {
    const audit = readAudit(auditPath), request = audit.request
    const db = ProjectDb.open(request.dbPath, { create: false })
    try {
      const store = new ProjectAdmissionStore(db)
      assertOperatorMaintenanceSchema(db, audit.bootstrap)
      const hold = store.operatorMaintenanceFor(request.scope, request.operationId)
      if (!hold) throw new Error('Exact maintenance hold is unavailable')
      if (command === 'record-owner') {
        if ((rest.length !== 1 && rest.length !== 2) || store.inspect(request.scope)?.leases !== 0) throw new Error('Owner observation requires settled admission and exact generation/PID')
        if (!sameMaintenanceProcess(audit.gateway, observeMaintenanceProcess(request.gatewayPid))) throw new Error('Gateway changed')
        if (rest.length === 1) {
          const observation = observeCompletedMaintenanceSleep(request, audit.owners, rest[0]!)
          if (!store.operatorMaintenanceCurrent(hold) || store.inspect(request.scope)?.leases !== 0
            || !sameMaintenanceProcess(audit.gateway, observeMaintenanceProcess(request.gatewayPid))) throw new Error('Completed sleep observation changed')
          appendAudit(auditPath, { kind: 'sleep', observation })
        } else {
          if (audit.completedSleep) throw new Error('Completed sleep observation changed')
          const owner = observeOwner(request, rest[0]!, Number(rest[1]))
          if (!audit.owners.every(o => maintenanceProcessGone(o.process))) throw new Error('Previous native owner has not exited')
          appendAudit(auditPath, { kind: 'owner', owner })
        }
      } else {
        if (rest.length !== 1) throw new Error('Release requires the current gateway PID')
        assertMaintenanceAsleep(request, audit.owners, maintenanceProcessGone, audit.completedSleep)
        const current = await verifyMaintenanceDeployment(request.deployment, Number(rest[0]), audit.gateway)
        const released = await store.releaseOperatorMaintenance(hold, () => {
          assertMaintenanceAsleep(request, audit.owners, maintenanceProcessGone, audit.completedSleep)
          return sameMaintenanceProcess(current, observeMaintenanceProcess(current.pid))
            && maintenanceSocketOwned(current.pid, request.deployment.port)
        })
        if (!released) throw new Error('Maintenance release refused')
      }
    } finally { db.close() }
  }
}

if (import.meta.main) {
  try { await runOperatorMaintenance(process.argv.slice(2)); process.stdout.write('Operator maintenance committed\n') }
  catch (error) { process.stderr.write(`Operator maintenance refused: ${maintenanceRefusalCode(error)}\n`); process.exitCode = 1 }
}
