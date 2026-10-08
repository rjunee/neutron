import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectDb } from '@neutronai/persistence/index.ts';
import { ProjectAdmissionStore, type AdmissionLeaseRow } from './project-admission-store.ts';

const scope = { ownerHandle: 'owner-a', projectId: 'project-a' };
const workRef = JSON.stringify(['run-a', 'plan']);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'planner-retirement-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'project.sqlite');
  const open = () => {
    const db = ProjectDb.open(path); cleanups.push(() => db.close());
    return { db, store: new ProjectAdmissionStore(db) };
  };
  const { db, store } = open();
  for (const file of ['0158_project_admission_fences.sql', '0161_native_host_terminations.sql', '0166_claude_native_continuations.sql', '0168_planner_authority_retirements.sql', '0169_native_conversation_quarantines.sql']) {
    await db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  await store.register(scope);
  const admitted = await store.admit(scope, 'liveChild', 'native-child:actor:key', workRef);
  if (admitted.status !== 'admitted') throw Error('Expected admission');
  const lease: AdmissionLeaseRow = { ...admitted.lease, reason: 'liveChild', producer: 'native-child:actor:key', workRef };
  return { db, store, lease, open };
}

test('retirement consumes only exact authority and persists permanent scope tombstone', async () => {
  const { store, lease, open } = await fixture();
  const sibling = await store.admit(scope, 'liveChild', 'native-child:other:key', JSON.stringify(['run-a', 'sibling']));
  expect(sibling.status).toBe('admitted');
  expect(await store.preparePlannerRetirement('op', lease, 'signed-auth', () => true)).toBe(true);
  expect(store.isPlannerRetired(scope, workRef)).toBe(true);
  expect(await store.release(lease)).toBe(false);
  expect(await store.releaseWork(scope, 'liveChild', workRef)).toBe(0);
  expect(await store.consumePlannerRetirement('op', lease, 'signed-auth', 'signed-completion', () => true)).toBe('released');
  expect(store.listLeases()).toHaveLength(1);
  const reopened = open().store;
  expect(reopened.isPlannerRetired(scope, workRef)).toBe(true);
  expect(reopened.listPlannerRetirements()[0]).toEqual({ operationId: 'op', lease, authorization: 'signed-auth', completion: 'signed-completion' });
  expect(await reopened.admit(scope, 'liveChild', 'new-actor', workRef)).toEqual({ status: 'fenced' });
  const fence = (await reopened.beginMaintenance(scope))!;
  expect(await reopened.abandon(fence)).toBe(true);
  expect(await reopened.admit(scope, 'liveChild', 'new-generation', workRef)).toEqual({ status: 'fenced' });
  expect((await reopened.admit(scope, 'build', 'build', 'run-a')).status).toBe('admitted');
  expect(await reopened.admitChild(scope, { reason: 'build', workRef: 'run-a' }, 'liveChild', 'new-actor', workRef)).toEqual({ status: 'fenced' });
  const other = { ...scope, projectId: 'project-b' }; await reopened.register(other);
  expect((await reopened.admit(other, 'liveChild', 'native', workRef)).status).toBe('admitted');
});

test('exact retries are idempotent while conflicting operation or evidence refuses', async () => {
  const { store, lease } = await fixture();
  expect(await store.preparePlannerRetirement('op', lease, 'auth', () => true)).toBe(true);
  expect(await store.preparePlannerRetirement('op', lease, 'auth', () => true)).toBe(true);
  expect(await store.preparePlannerRetirement('op', lease, 'changed', () => true)).toBe(false);
  expect(await store.preparePlannerRetirement('other-op', lease, 'auth', () => true)).toBe(false);
  expect(await store.consumePlannerRetirement('op', lease, 'changed', 'completion', () => true)).toBe('refused');
  expect(await store.consumePlannerRetirement('op', lease, 'auth', 'completion', () => true)).toBe('released');
  expect(await store.consumePlannerRetirement('op', lease, 'auth', 'completion', () => false)).toBe('already-retired');
  expect(await store.preparePlannerRetirement('op', lease, 'auth', () => false)).toBe(true);
  expect(await store.consumePlannerRetirement('op', lease, 'auth', 'changed', () => true)).toBe('refused');
});

for (const field of ['scope', 'generation', 'token', 'reason', 'producer', 'workRef'] as const) {
  test(`retirement refuses changed ${field} at preparation and consumption`, async () => {
    const { store, lease } = await fixture();
    const changed: AdmissionLeaseRow = { ...lease, [field]: field === 'scope' ? { ...scope, ownerHandle: 'other-owner' }
      : field === 'generation' ? lease.generation + 1 : field === 'reason' ? 'build' : 'wrong' };
    expect(await store.preparePlannerRetirement('op', changed, 'auth', () => true)).toBe(false);
    expect(await store.preparePlannerRetirement('op', lease, 'auth', () => true)).toBe(true);
    expect(await store.consumePlannerRetirement('op', changed, 'auth', 'completion', () => true)).toBe('refused');
    expect(store.listLeases()).toEqual([lease]);
  });
}

test('duplicate scoped authority and canonical ineligibility refuse', async () => {
  const { store, lease } = await fixture();
  expect(await store.preparePlannerRetirement('op', lease, 'auth', () => false)).toBe(false);
  const duplicate = await store.admit(scope, 'liveChild', 'other-actor', workRef);
  if (duplicate.status !== 'admitted') throw Error('Expected duplicate');
  expect(await store.preparePlannerRetirement('op', lease, 'auth', () => true)).toBe(false);
  await store.release(duplicate.lease);
  expect(await store.preparePlannerRetirement('op', lease, 'auth', () => true)).toBe(true);
  expect(await store.consumePlannerRetirement('op', lease, 'auth', 'completion', () => false)).toBe('refused');
  expect(store.listLeases()).toEqual([lease]);
});

test('host termination reservations cannot be bypassed in either ordering', async () => {
  const { store, lease, db } = await fixture();
  expect(await store.prepareHostTermination('host-op', lease, 'host-auth', () => true)).toBe(true);
  expect(await store.preparePlannerRetirement('op', lease, 'auth', () => true)).toBe(false);
  await db.run('DELETE FROM native_host_terminations WHERE operation_id = ?', ['host-op']);
  expect(await store.preparePlannerRetirement('op', lease, 'auth', () => true)).toBe(true);
  expect(await store.prepareHostTermination('host-op', lease, 'host-auth', () => true)).toBe(false);
  await db.run('INSERT INTO native_host_terminations (operation_id, scope_key, lease_token, preparation) VALUES (?, ?, ?, ?)',
    ['host-op', JSON.stringify([scope.ownerHandle, scope.projectId]), lease.token, 'host-auth']);
  expect(await store.consumePlannerRetirement('op', lease, 'auth', 'completion', () => true)).toBe('refused');
  expect(store.listLeases()).toEqual([lease]);
});

test('pending retirement fences continuation and failed transaction retains lease and pending record', async () => {
  const { store, lease, db } = await fixture();
  expect(store.nativeContinuationCurrent(lease)).toBe(true);
  expect(await store.claimNativeContinuation(lease, 'a'.repeat(64), 'preparation')).toBe(true);
  expect(await store.preparePlannerRetirement('op', lease, 'auth', () => true)).toBe(true);
  expect(store.nativeContinuationCurrent(lease)).toBe(false);
  expect(await store.claimNativeContinuation(lease, 'b'.repeat(64), 'next')).toBe(false);
  await db.exec(`CREATE TRIGGER fail_retirement BEFORE UPDATE OF completion ON planner_authority_retirements
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  await expect(store.consumePlannerRetirement('op', lease, 'auth', 'completion', () => true)).rejects.toThrow('injected failure');
  expect(store.listLeases()).toEqual([lease]);
  expect(store.listPlannerRetirements()[0]?.completion).toBeNull();
  await db.exec('DROP TRIGGER fail_retirement');
  expect(await store.consumePlannerRetirement('op', lease, 'auth', 'completion', () => true)).toBe('released');
});

test('consumption rechecks uniqueness after preparation under the writer lock', async () => {
  const { db, store, lease } = await fixture();
  expect(await store.preparePlannerRetirement('op', lease, 'auth', () => true)).toBe(true);
  await db.run(`INSERT INTO project_admission_leases (token, scope_key, generation, reason, producer, work_ref)
    VALUES (?, ?, ?, 'liveChild', ?, ?)`, ['duplicate', JSON.stringify([scope.ownerHandle, scope.projectId]), lease.generation, 'other-actor', workRef]);
  let checked = false;
  expect(await store.consumePlannerRetirement('op', lease, 'auth', 'completion', () => { checked = true; return true; })).toBe('refused');
  expect(checked).toBe(false);
  expect(store.listLeases()).toHaveLength(2);
  expect(store.listPlannerRetirements()[0]?.completion).toBeNull();
});

test('canonical eligibility sees concurrent changes only after acquiring the SQLite writer lock', async () => {
  const { db, store, lease, open } = await fixture();
  await db.exec('CREATE TABLE canonical_eligibility (eligible INTEGER NOT NULL); INSERT INTO canonical_eligibility VALUES (1)');
  const other = open();
  let unlock!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const locked = new Promise<void>(resolve => { entered = resolve; });
  const writer = db.transaction(async tx => {
    await tx.run('UPDATE canonical_eligibility SET eligible = 0', []);
    entered(); await gate;
  });
  await locked;
  let checked = false;
  const preparation = other.store.preparePlannerRetirement('op', lease, 'auth', () => {
    other.db.assertInTransaction(); checked = true;
    return other.db.get<{ eligible: number }>('SELECT eligible FROM canonical_eligibility')?.eligible === 1;
  });
  setTimeout(unlock, 20);
  await writer;
  expect(await preparation).toBe(false);
  expect(checked).toBe(true);
  expect(store.listLeases()).toEqual([lease]);
  expect(store.listPlannerRetirements()).toEqual([]);
});
