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
