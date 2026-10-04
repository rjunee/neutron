import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertMaintenanceAsleep, assertNoMaintenanceReplay, readMaintenanceRow,
  requireMaintenanceRoot, runOperatorMaintenance, validateMaintenanceRequest, maintenanceRefusalCode, type MaintenanceRequest } from './operator-maintenance.ts'
import { observeMaintenanceProcess, maintenanceProcessGone, sameMaintenanceProcess,
  verifyMaintenanceDeploymentFiles } from './operator-maintenance-evidence.ts'

test('local maintenance root boundary refuses before reading any operator input', async () => {
  for (const uid of [1, 1000]) expect(() => requireMaintenanceRoot(uid)).toThrow()
  expect(() => requireMaintenanceRoot(0)).not.toThrow()
  expect(maintenanceRefusalCode(new Error('Pending replay owns this transcript'))).toBe('replay.pending')
  expect(maintenanceRefusalCode(new Error('private prompt token /private-path'))).toBe('maintenance.unknown_failure')
  expect(maintenanceRefusalCode({ prompt: 'private' })).toBe('maintenance.unknown_failure')
  if (process.geteuid?.() !== 0) await expect(runOperatorMaintenance(['hold', '/unreadable-audit', '/unreadable-request'])).rejects.toThrow('requires root')
})

test('strict pending replay observation preserves target and unknown work; absence and unrelated valid queue pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operator-replay-')), path = join(dir, 'queue')
  try {
    expect(() => assertNoMaintenanceReplay(path, 'key', 'sid')).not.toThrow()
    for (const data of ['{', '{}', '[{}]', JSON.stringify([{ sessionKey: 'other', sessionId: 'other', cwd: '/', droppedInbound: 4 }])]) {
      writeFileSync(path, data)
      expect(() => assertNoMaintenanceReplay(path, 'key', 'sid')).toThrow()
    }
    for (const entry of [{ sessionKey: 'key', sessionId: 'foreign', cwd: '/' }, { sessionKey: 'foreign', sessionId: 'sid', cwd: '/' }]) {
      writeFileSync(path, JSON.stringify([entry]))
      expect(() => assertNoMaintenanceReplay(path, 'key', 'sid')).toThrow('owns this transcript')
    }
    writeFileSync(path, JSON.stringify([{ sessionKey: 'foreign', sessionId: 'foreign', cwd: '/', droppedInbound: 'pending elsewhere' }]))
    expect(() => assertNoMaintenanceReplay(path, 'key', 'sid')).not.toThrow()
    expect(() => assertNoMaintenanceReplay(dir, 'key', 'sid')).toThrow('unreadable')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('release proof requires exact canonical sleep and original PLUS replacement process exits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operator-asleep-'))
  const request: MaintenanceRequest = { version: 1, operationId: crypto.randomUUID(), dbPath: join(dir, 'db'),
    deployedMigrations: dir, registryPath: join(dir, 'registry'), pendingRespawnsPath: join(dir, 'pending'),
    scope: { ownerHandle: 'owner', projectId: null }, sessionKey: 'key', sessionId: 'sid', childGeneration: 'old',
    childPid: 123, gatewayPid: 456, deployment: { codeRoot: dir, entrypoint: join(dir, 'open/server.ts'), revision: 'a'.repeat(40), port: 1234, ownerHandle: 'owner' } }
  const row = { sessionKey: 'key', sessionId: 'sid', cwd: dir, channelName: `neutron-${'a'.repeat(32)}`,
    has_session: true, conversationProjectId: null, child_generation: 'new', asleep_at: Date.now() }
  const owners = [{ generation: 'old', process: { pid: 123, identity: { start_ticks: 1, boot_id: 'boot' } } },
    { generation: 'new', process: { pid: 234, identity: { start_ticks: 2, boot_id: 'boot' } } }]
  const save = (value: unknown) => writeFileSync(request.registryPath, JSON.stringify({ key: value }))
  try {
    expect(validateMaintenanceRequest(request)).toBe(request)
    expect(() => validateMaintenanceRequest({ ...request, scope: { ownerHandle: '', projectId: null } })).toThrow()
    save(row)
    expect(() => assertMaintenanceAsleep(request, owners, () => true)).not.toThrow()
    expect(() => assertMaintenanceAsleep(request, owners, p => p.pid !== 123)).toThrow()
    expect(() => assertMaintenanceAsleep(request, owners, p => p.pid !== 234)).toThrow()
    expect(() => assertMaintenanceAsleep(request, owners.slice(0, 1), () => true)).toThrow()
    for (const bad of [null, 'asleep', 0, -1]) {
      save({ ...row, asleep_at: bad }); expect(() => assertMaintenanceAsleep(request, owners, () => true)).toThrow()
    }
    for (const key of ['pid', 'pane_handle', 'devchannel_port', 'adoption_claim_by', 'adoption_claim_pid', 'adoption_claim_at',
      'respawn_in_flight_at', 'spawn_reservation_at', 'spawn_reservation_by', 'spawn_reservation_pid', 'capped_at']) {
      save({ ...row, [key]: 1 }); expect(() => assertMaintenanceAsleep(request, owners, () => true)).toThrow()
    }
    for (const change of [{ sessionId: 'foreign' }, { conversationProjectId: 'other' }, { has_session: false }]) {
      save({ ...row, ...change }); expect(() => readMaintenanceRow(request)).toThrow()
    }
    save(row)
    writeFileSync(request.pendingRespawnsPath, JSON.stringify([{ sessionKey: 'key', sessionId: 'sid', cwd: dir }]))
    expect(() => assertMaintenanceAsleep(request, owners, () => true)).toThrow('owns this transcript')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('deployment proof cannot combine an unrelated entrypoint with a v3 checkout, or call a live process dead', () => {
  const current = observeMaintenanceProcess(process.pid)
  expect(maintenanceProcessGone(current)).toBe(false)
  expect(sameMaintenanceProcess(current, { ...current, identity: { ...current.identity, start_ticks: current.identity.start_ticks + 1 } })).toBe(false)
  expect(() => verifyMaintenanceDeploymentFiles({ codeRoot: process.cwd(), entrypoint: '/unrelated/server.ts',
    revision: 'a'.repeat(40), port: 1234, ownerHandle: 'owner' }, current)).toThrow('Invalid deployment identity')
})
