import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectDb } from '@neutronai/persistence/index.ts';
import { ProjectAdmissionStore } from './project-admission-store.ts';
import type { MaintenanceFence } from './project-admission-store.ts';

const scope = { ownerHandle: 'owner-a', projectId: 'project-a' };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'admission-store-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'project.sqlite');
  const open = () => {
    const db = ProjectDb.open(path); cleanup.push(() => db.close());
    return { db, store: new ProjectAdmissionStore(db) };
  };
  const a = open();
  await a.db.exec(readFileSync(new URL('../migrations/0158_project_admission_fences.sql', import.meta.url), 'utf8'));
  await a.db.exec(readFileSync(new URL('../migrations/0161_native_host_terminations.sql', import.meta.url), 'utf8'));
  await a.db.exec(readFileSync(new URL('../migrations/0168_planner_authority_retirements.sql', import.meta.url), 'utf8'));
  await a.db.exec(readFileSync(new URL('../migrations/0169_native_conversation_quarantines.sql', import.meta.url), 'utf8'));
  await a.db.exec(readFileSync(new URL('../migrations/0171_claude_native_cancellations.sql', import.meta.url), 'utf8'));
  await a.store.register(scope);
  return { a, b: open(), open };
}
async function attesting(store: ProjectAdmissionStore, start: MaintenanceFence) {
  let fence = start;
  for (let i = 0; i < 3; i++) { fence = (await store.advance(fence))!; expect(fence).not.toBeNull(); }
  return fence;
}

test('unknown scope refuses admission; explicit registration does not reset a fence', async () => {
  const { a } = await fixture(); const other = { ...scope, projectId: null };
  expect(await a.store.admit(other, 'conversation', 'chat', 'turn')).toEqual({ status: 'unknown' });
  await a.store.register(other);
  expect((await a.store.admit(other, 'conversation', 'chat', 'turn')).status).toBe('admitted');
  await a.store.beginMaintenance(scope); await a.store.register(scope);
  expect((await a.store.admit(scope, 'conversation', 'chat', 'turn')).status).toBe('fenced');
});

test('admitted work survives fencing and blocks advancement until exact release', async () => {
  const { a, b } = await fixture();
  const admitted = await a.store.admit(scope, 'liveChild', 'native', 'child-a');
  if (admitted.status !== 'admitted') throw Error('expected admission');
  const fence = (await b.store.beginMaintenance(scope))!;
  expect(await b.store.advance(fence)).toBeNull();
  expect(await a.store.release({ ...admitted.lease, generation: admitted.lease.generation + 1 })).toBe(false);
  expect(await b.store.advance(fence)).toBeNull();
  expect(await a.store.release(admitted.lease)).toBe(true);
  expect(await a.store.release(admitted.lease)).toBe(false);
  expect(await b.store.advance(fence)).toMatchObject({ phase: 'quiesced' });
});

test('cross-connection contention waits for committed fence before admitting', async () => {
  const { a, b } = await fixture();
  let unlock!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const locked = new Promise<void>(resolve => { entered = resolve; });
  const writer = a.db.transaction(async tx => {
    await tx.run("UPDATE project_admission_fences SET generation = 1, phase = 'draining', maintenance_token = 'held' WHERE scope_key = ?", [JSON.stringify([scope.ownerHandle, scope.projectId])]);
    entered(); await gate;
  });
  await locked;
  const admission = b.store.admit(scope, 'build', 'board', 'card');
  setTimeout(unlock, 20);
  await writer;
  expect(await admission).toEqual({ status: 'fenced' });
  expect(b.store.inspect(scope)?.leases).toBe(0);
});

test('simultaneous cross-connection admission and fence have no uncounted admission', async () => {
  const { a, b } = await fixture();
  const [admission, fence] = await Promise.all([
    a.store.admit(scope, 'queuedDispatch', 'queue', 'job'), b.store.beginMaintenance(scope),
  ]);
  expect(fence).not.toBeNull();
  if (admission.status === 'admitted') {
    expect(b.store.inspect(scope)?.leases).toBe(1);
    expect(await b.store.advance(fence!)).toBeNull();
    await a.store.release(admission.lease);
  } else expect(admission.status).toBe('fenced');
  expect(await b.store.advance(fence!)).toMatchObject({ phase: 'quiesced' });
});

test('restart retains every maintenance phase and unexpired durable activity', async () => {
  const f = await fixture();
  const admitted = await f.a.store.admit(scope, 'approval', 'approval', 'request');
  const initial = (await f.a.store.beginMaintenance(scope))!;
  const reopened = f.open().store;
  expect(reopened.inspect(scope)).toEqual({ generation: 1, phase: 'draining', leases: 1 });
  expect(await reopened.advance(initial)).toBeNull();
  if (admitted.status !== 'admitted') throw Error('expected admission');
  await reopened.release(admitted.lease);
  let fence = initial;
  for (let i = 0; i < 4; i++) {
    const restarted = f.open().store;
    expect(restarted.inspect(scope)?.phase).toBe(fence.phase);
    expect((await restarted.admit(scope, 'conversation', 'chat', 'turn')).status).toBe('fenced');
    if (i < 3) fence = (await restarted.advance(fence))!;
  }
  expect(await reopened.reopen(fence)).toBe(true);
  expect((await reopened.admit(scope, 'conversation', 'chat', 'turn')).status).toBe('admitted');
});

test('stale, foreign and forged maintenance tokens cannot advance or reopen', async () => {
  const { a } = await fixture(); const initial = (await a.store.beginMaintenance(scope))!;
  expect(await a.store.advance({ ...initial, token: 'wrong' })).toBeNull();
  expect(await a.store.advance({ ...initial, scope: { ...scope, ownerHandle: 'owner-b' } })).toBeNull();
  expect(await a.store.reopen({ ...initial, phase: 'attesting' })).toBe(false);
  const first = await attesting(a.store, initial);
  expect(await a.store.reopen(first)).toBe(true);
  const second = await attesting(a.store, (await a.store.beginMaintenance(scope))!);
  expect(second.generation).toBe(2);
  expect(await a.store.reopen(first)).toBe(false);
  expect(await a.store.reopen({ ...second, generation: 1 })).toBe(false);
  expect(await a.store.reopen(second)).toBe(true);
});

test('General, literal General project and different owner never share fences', async () => {
  const { a } = await fixture();
  const general = { ...scope, projectId: null };
  const named = { ...scope, projectId: 'General' };
  const other = { ...general, ownerHandle: 'owner-b' };
  for (const value of [general, named, other]) await a.store.register(value);
  await a.store.beginMaintenance(general);
  expect((await a.store.admit(general, 'conversation', 'chat', 'turn')).status).toBe('fenced');
  for (const value of [named, other]) expect((await a.store.admit(value, 'conversation', 'chat', 'turn')).status).toBe('admitted');
});

test('native cancellation spends once across connections and restart, drains its exact child, and permanently refuses replay', async () => {
  const { a, b, open } = await fixture();
  const admitted = await a.store.admit(scope, 'liveChild', 'native', 'cancelled-step');
  const sibling = await a.store.admit(scope, 'liveChild', 'native', 'sibling-step');
  if (admitted.status !== 'admitted' || sibling.status !== 'admitted') throw Error('expected admission');
  const lease = { ...admitted.lease, reason: 'liveChild' as const, producer: 'native', workRef: 'cancelled-step' };
  const fence = (await b.store.beginMaintenance(scope))!;
  expect(b.store.nativeCancellationCurrent(lease)).toBe(true);
  const claims = await Promise.all([a.store.claimNativeCancellation(lease, 'first'), b.store.claimNativeCancellation(lease, 'second')]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const restarted = open().store;
  const saved = restarted.readNativeCancellation(lease)!;
  expect(['first', 'second']).toContain(saved);
  expect(await restarted.claimNativeCancellation(lease, saved)).toBe(false);
  expect(restarted.nativeContinuationCurrent(lease)).toBe(false);
  expect(await restarted.completeNativeCancellation({ ...lease, token: sibling.lease.token }, saved, 'ack')).toBe(false);
  expect(await restarted.completeNativeCancellation(lease, 'different', 'ack')).toBe(false);
  expect(restarted.inspect(scope)?.leases).toBe(2);
  expect(await restarted.completeNativeCancellation(lease, saved, 'ack')).toBe(true);
  expect(await restarted.completeNativeCancellation(lease, saved, 'ack')).toBe(false);
  expect(restarted.inspect(scope)?.leases).toBe(1);
  expect(restarted.readNativeCancellation(lease)).toBe(saved);
  expect(await restarted.abandon(fence)).toBe(true);
  expect(await restarted.admit(scope, 'liveChild', 'native', lease.workRef)).toEqual({ status: 'fenced' });
  expect(await restarted.admitChild(scope, { reason: 'liveChild', workRef: 'sibling-step' }, 'liveChild', 'native', lease.workRef))
    .toEqual({ status: 'fenced' });
  expect((await restarted.admitChild(scope, { reason: 'liveChild', workRef: 'sibling-step' }, 'liveChild', 'native', 'new-step')).status).toBe('admitted');
  expect(await restarted.release(sibling.lease)).toBe(true);
});

test('foreign native cancellation cannot spend or consume a current original lease', async () => {
  const { a } = await fixture();
  const admitted = await a.store.admit(scope, 'liveChild', 'native', 'step');
  if (admitted.status !== 'admitted') throw Error('expected admission');
  const lease = { ...admitted.lease, reason: 'liveChild' as const, producer: 'native', workRef: 'step' };
  for (const altered of [{ ...lease, generation: 9 }, { ...lease, producer: 'foreign' }, { ...lease, workRef: 'sibling' },
    { ...lease, scope: { ...scope, projectId: 'other' } }]) {
    expect(a.store.nativeCancellationCurrent(altered)).toBe(false);
    expect(await a.store.claimNativeCancellation(altered, 'intent')).toBe(false);
  }
  expect(await a.store.claimNativeCancellation(lease, 'intent')).toBe(true);
  expect(await a.store.completeNativeCancellation(lease, 'intent', 'ack')).toBe(true);
});
