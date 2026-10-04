import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmissionStore, type ProjectAdmissionScope } from '@neutronai/gateway/project-admission-store.ts'
import { parseRegistryContents, type ReplRegistryRecord } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import { installOperatorMaintenanceGuard } from '@neutronai/migrations/operator-maintenance.ts'
import { assertRootProtectedPath } from './native-host-recovery-authority.ts'
import { maintenanceProcessGone, maintenanceSocketOwned, observeMaintenanceProcess, sameMaintenanceProcess,
  verifyMaintenanceDeployment, type MaintenanceDeployment, type MaintenanceProcess } from './operator-maintenance-evidence.ts'

export interface MaintenanceRequest {
  version: 1
  operationId: string
  dbPath: string
  deployedMigrations: string
  registryPath: string
  pendingRespawnsPath: string
  scope: ProjectAdmissionScope
  sessionKey: string
  sessionId: string
  childGeneration: string
  childPid: number
  gatewayPid: number
  deployment: MaintenanceDeployment
}
interface OwnerObservation { generation: string; process: MaintenanceProcess }
interface Audit {
  request: MaintenanceRequest
  gateway: MaintenanceProcess
  owners: OwnerObservation[]
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
    || ['dbPath', 'deployedMigrations', 'registryPath', 'pendingRespawnsPath'].some(k => {
      const p = (v as unknown as Record<string, unknown>)[k]
      return typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p
    }) || ['sessionKey', 'sessionId', 'childGeneration'].some(k => typeof (v as unknown as Record<string, unknown>)[k] !== 'string' || !(v as unknown as Record<string, string>)[k])
    || !Number.isSafeInteger(v.childPid) || v.childPid <= 0
    || !Number.isSafeInteger(v.gatewayPid) || v.gatewayPid <= 0 || !v.deployment
    || v.deployment.ownerHandle !== v.scope.ownerHandle) throw new Error('Invalid maintenance request')
  return v
}

/** Unlike the replay loader, one invalid entry is UNKNOWN, not silently dropped.
 * The bytes are never emitted or mutated by the operator tool. */
export function assertNoMaintenanceReplay(path: string, sessionKey: string, sessionId: string): void {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('Pending replay is unreadable')
  }
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
  const parsed = parseRegistryContents(readFileSync(request.registryPath, 'utf8'), () => { invalid = true })
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
  const text = readFileSync(path, 'utf8')
  if (!text.endsWith('\n')) throw new Error('Maintenance audit is incomplete')
  const entries = text.trimEnd().split('\n').map(line => JSON.parse(line))
  const initial = entries.shift() as Audit
  validateMaintenanceRequest(initial?.request)
  if (!initial.gateway || initial.owners?.length !== 1) throw new Error('Maintenance audit is invalid')
  for (const entry of entries) {
    if (entry.kind !== 'owner' || !entry.owner?.generation || !entry.owner.process?.identity) throw new Error('Maintenance audit is invalid')
    initial.owners.push(entry.owner)
  }
  return initial
}

export function assertMaintenanceAsleep(request: MaintenanceRequest, owners: OwnerObservation[], gone = maintenanceProcessGone): void {
  const row = readMaintenanceRow(request)
  const last = owners.at(-1)
  if (!last || row.child_generation !== last.generation || !Number.isFinite(row.asleep_at) || row.asleep_at! <= 0
    || ['pid', 'pane_handle', 'devchannel_port', 'adoption_claim_by', 'adoption_claim_pid', 'adoption_claim_at',
      'respawn_in_flight_at', 'spawn_reservation_at', 'spawn_reservation_by', 'spawn_reservation_pid', 'capped_at']
      .some(key => (row as unknown as Record<string, unknown>)[key] !== undefined)
    || !owners.every(o => gone(o.process))) {
    throw new Error('Canonical asleep and all recorded native exits are required')
  }
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
    const request = validateMaintenanceRequest(JSON.parse(readFileSync(rest[0]!, 'utf8')))
    const gateway = observeMaintenanceProcess(request.gatewayPid)
    const argv = readFileSync(`/proc/${gateway.pid}/cmdline`, 'utf8').split('\0')
    if (!argv.includes(request.deployment.entrypoint) || !maintenanceSocketOwned(gateway.pid, request.deployment.port)) throw new Error('Gateway identity unavailable')
    const health = await fetch(`http://127.0.0.1:${request.deployment.port}/healthz`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
    const identity = await health.json() as { status?: string; project_slug?: string }
    if (!health.ok || identity.status !== 'ok' || identity.project_slug !== request.scope.ownerHandle) throw new Error('Gateway scope differs')
    const owner = observeOwner(request, request.childGeneration, request.childPid)
    // Journal identity BEFORE fencing. A crash remains recoverable by the exact
    // operation id; it cannot turn unknown original ownership into an empty set.
    appendAudit(auditPath, { request, gateway, owners: [owner] } satisfies Audit, true)
    const db = ProjectDb.open(request.dbPath, { create: false })
    try {
      const store = new ProjectAdmissionStore(db)
      if (!store.inspect(request.scope) || store.hasPreparedHostTermination(request.scope)) throw new Error('Scope is unavailable')
      await installOperatorMaintenanceGuard(db, request.deployedMigrations)
      observeOwner(request, request.childGeneration, request.childPid)
      if (!sameMaintenanceProcess(gateway, observeMaintenanceProcess(request.gatewayPid))) throw new Error('Gateway changed')
      if (!await store.holdOperatorMaintenance(request.scope, request.operationId)) throw new Error('Scope is already fenced')
    } finally { db.close() }
  } else {
    const audit = readAudit(auditPath), request = audit.request
    const db = ProjectDb.open(request.dbPath, { create: false })
    try {
      const store = new ProjectAdmissionStore(db)
      const hold = store.operatorMaintenanceFor(request.scope, request.operationId)
      if (!hold) throw new Error('Exact maintenance hold is unavailable')
      if (command === 'record-owner') {
        if (rest.length !== 2 || store.inspect(request.scope)?.leases !== 0) throw new Error('Owner observation requires settled admission and exact generation/PID')
        if (!sameMaintenanceProcess(audit.gateway, observeMaintenanceProcess(request.gatewayPid))) throw new Error('Gateway changed')
        const owner = observeOwner(request, rest[0]!, Number(rest[1]))
        if (!audit.owners.every(o => maintenanceProcessGone(o.process))) throw new Error('Previous native owner has not exited')
        appendAudit(auditPath, { kind: 'owner', owner })
      } else {
        if (rest.length !== 1) throw new Error('Release requires the current gateway PID')
        assertMaintenanceAsleep(request, audit.owners)
        const current = await verifyMaintenanceDeployment(request.deployment, Number(rest[0]), audit.gateway)
        const released = await store.releaseOperatorMaintenance(hold, () => {
          assertMaintenanceAsleep(request, audit.owners)
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
