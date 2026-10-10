import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectDb } from '@neutronai/persistence/index.ts';
import { ProjectAdmissionStore, type AdmissionLeaseRow } from './project-admission-store.ts';

const scope = { ownerHandle: 'owner-a', projectId: 'project-a' };
const operation = '40bfc1e8-46b8-4791-b2bf-5316257d0e64';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'parent-termination-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = ProjectDb.open(join(directory, 'project.sqlite'));
  cleanups.push(() => db.close());
  for (const file of ['0158_project_admission_fences.sql', '0161_native_host_terminations.sql',
    '0166_claude_native_continuations.sql', '0167_operator_maintenance_holds.sql',
    '0168_planner_authority_retirements.sql', '0169_native_conversation_quarantines.sql']) {
    await db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const store = new ProjectAdmissionStore(db);
  await store.register(scope);
  const other = { ...scope, projectId: 'other-project' };
  await store.register(other);
  const admit = async (project: typeof scope, step: string) => {
    const workRef = JSON.stringify(['run-a', step]);
    const result = await store.admit(project, 'liveChild', 'native-child:original:key', workRef);
    if (result.status !== 'admitted') throw Error('Fixture admission failed');
    return { ...result.lease, reason: 'liveChild' as const, producer: 'native-child:original:key', workRef };
  };
  const leases = [await admit(scope, 'review-a'), await admit(scope, 'review-b')];
  const sibling = await admit(other, 'review-c');
  expect(leases.every(row => store.nativeContinuationCurrent(row))).toBe(true);
  const prepare = (rows = leases, eligible = () => true) =>
    store.prepareNativeParentTermination(operation, rows, 'signed-preparation', 'old-session', eligible);
  const consume = (rows = leases, eligible = () => true, completion = 'signed-completion') =>
    store.consumeNativeParentTermination(operation, rows, 'signed-preparation', 'old-session', completion, eligible);
  return { db, store, leases, sibling, prepare, consume };
}

test('prepared exact parent ownership blocks replay; complete consumption admits fresh work and preserves another project', async () => {
  const f = await fixture();
  expect(await f.prepare()).toBe(true);
  expect(f.store.isConversationQuarantined('old-session')).toBe(true);
  expect(f.store.completedConversationQuarantine(scope, 'old-session')).toBeUndefined();
  for (const lease of f.leases) {
    expect(f.store.nativeContinuationCurrent(lease)).toBe(false);
    expect(await f.store.release(lease)).toBe(false);
  }
  expect((await f.store.admit(scope, 'conversation', 'chat:new', 'new-topic')).status).toBe('fenced');
  expect(await f.consume()).toBe('released');
  expect(f.store.listLeases()).toEqual([f.sibling]);
  expect(f.store.completedConversationQuarantine(scope, 'old-session')).toMatchObject({
    operationId: operation, authorization: 'signed-preparation', completion: 'signed-completion',
  });
  expect((await f.store.admit(scope, 'conversation', 'chat:new', 'new-topic')).status).toBe('admitted');
  expect((await f.store.admit(scope, 'liveChild', 'native-child:new:key', f.leases[0]!.workRef)).status).toBe('fenced');
  expect(await f.consume()).toBe('already-retired');
  expect(await f.consume(f.leases, () => true, 'different-completion')).toBe('refused');
});

test('unlisted or duplicate ownership cannot prepare a parent termination', async () => {
  const f = await fixture();
  for (const rows of [f.leases.slice(0, 1), [...f.leases, f.leases[0]!], [...f.leases, f.sibling]]) {
    expect(await f.prepare(rows)).toBe(false);
  }
  expect(await f.prepare(f.leases, () => false)).toBe(false);
  expect(f.store.isConversationQuarantined('old-session')).toBe(false);
  const chat = await f.store.admit(scope, 'conversation', 'chat:original', 'ordinary-turn');
  expect(chat.status).toBe('admitted');
  expect(await f.prepare()).toBe(false);
  if (chat.status !== 'admitted') throw Error('Fixture chat missing');
  await f.store.release(chat.lease);
  expect(await f.prepare()).toBe(true);
});

for (const field of ['scope', 'generation', 'token', 'reason', 'producer', 'workRef'] as const) {
  test(`changed ${field} cannot prepare or consume original parent ownership`, async () => {
    const f = await fixture();
    const wrong: AdmissionLeaseRow = { ...f.leases[0]!, [field]: field === 'scope' ? { ...scope, projectId: 'wrong' }
      : field === 'generation' ? f.leases[0]!.generation + 1 : field === 'reason' ? 'conversation' : 'wrong' };
    const changed = [wrong, f.leases[1]!];
    expect(await f.prepare(changed)).toBe(false);
    expect(await f.prepare()).toBe(true);
    expect(await f.consume(changed)).toBe('refused');
    expect(await f.consume(f.leases, () => false)).toBe('refused');
    expect(f.store.listLeases()).toHaveLength(3);
    expect(await f.consume()).toBe('released');
  });
}

test('a failed second retirement write rolls back the entire preparation', async () => {
  const f = await fixture();
  await f.db.exec(`CREATE TRIGGER fail_second_retirement BEFORE INSERT ON planner_authority_retirements
    WHEN (SELECT count(*) FROM planner_authority_retirements) = 1
    BEGIN SELECT RAISE(ABORT, 'injected second write failure'); END;`);
  await expect(f.prepare()).rejects.toThrow('injected second write failure');
  expect(f.store.listPlannerRetirements()).toEqual([]);
  expect(f.store.isConversationQuarantined('old-session')).toBe(false);
  expect(f.store.inspect(scope)?.phase).toBe('open');
  expect(f.store.listLeases()).toHaveLength(3);
  await f.db.exec('DROP TRIGGER fail_second_retirement');
  expect(await f.prepare()).toBe(true);
});

test('a failed completion commit cannot release any sibling lease or the maintenance hold', async () => {
  const f = await fixture();
  expect(await f.prepare()).toBe(true);
  await f.db.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE OF completion ON planner_authority_retirements
    BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END;`);
  await expect(f.consume()).rejects.toThrow('injected completion failure');
  expect(f.store.listLeases()).toHaveLength(3);
  expect(f.store.listPlannerRetirements().every(row => row.completion === null)).toBe(true);
  expect(f.store.operatorMaintenanceFor(scope, operation)).not.toBeNull();
  await f.db.exec('DROP TRIGGER fail_completion');
  expect(await f.consume()).toBe('released');
});

test('whole-host reservations retain exclusive authority over their lease', async () => {
  const f = await fixture();
  expect(await f.store.prepareHostTermination('host-operation', f.leases[0]!, 'host-preparation', () => true)).toBe(true);
  expect(await f.prepare()).toBe(false);
  expect(f.store.isConversationQuarantined('old-session')).toBe(false);
  expect(f.store.listLeases()).toHaveLength(3);
});
