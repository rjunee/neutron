import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createObservationPublisher, recoverProviderObservation } from './provider-observation-recovery.ts'

const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })
const observation = { source: 'claude-cli-json' as const, started_at_ms: 1, finished_at_ms: 2, observed_at_ms: 2,
  thread_id: 'thread', model_reported: 'reported', usage: { input_tokens: 17, output_tokens: 0,
    cache_read_input_tokens: null, cache_creation_input_tokens: null, cost_usd: null } }
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'observation-recover-')); directories.push(dir)
  const reservation = join(dir, 'reservation'), receipt = join(dir, 'receipt')
  await writeFile(reservation, 'bound\n#dispatch-armed\n')
  await writeFile(receipt, JSON.stringify(observation))
  return { reservation, receipt, observe: () => recoverProviderObservation(reservation, 'bound', receipt, 'claude-cli-json') }
}

test('read-only receipt recovery preserves known zero/nonzero and leaves reservation unchanged', async () => {
  const f = await fixture()
  expect(await f.observe()).toEqual(observation)
  expect(await fs.readFile(f.reservation, 'utf8')).toBe('bound\n#dispatch-armed\n')
})
test('additional credential evidence must agree but cannot veto when it matches', async () => {
  const f = await fixture()
  expect(await recoverProviderObservation(f.reservation, 'bound', f.receipt, 'claude-cli-json', async () => false)).toBeUndefined()
  expect(await recoverProviderObservation(f.reservation, 'bound', f.receipt, 'claude-cli-json', async () => true)).toEqual(observation)
})
test('publisher keeps cumulative measurements through duplicates, reorder and foreign threads', async () => {
  const f = await fixture()
  const publisher = createObservationPublisher(f.receipt, 'bound')
  await publisher.settle(observation)
  expect(publisher.publish({ ...observation, usage: { ...observation.usage, input_tokens: 1 } }).usage.input_tokens).toBe(17)
  publisher.publish(observation)
  const latest = await publisher.settle({ ...observation, thread_id: 'foreign', usage: { ...observation.usage, input_tokens: 999 } })
  expect(latest.usage.input_tokens).toBe(17)
  expect(await f.observe()).toEqual(observation)
})
test('failed newer publication cannot replace latest memory usage with older durable spend', async () => {
  const f = await fixture()
  const publisher = createObservationPublisher(f.receipt, 'bound')
  const older = { ...observation, usage: { ...observation.usage, input_tokens: 1 } }
  await publisher.settle(older)
  const original = fs.writeFile
  const mock = spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.tmp')) throw new Error('fixture publication failed')
    return original(...args)
  })
  try {
    expect((await publisher.settle(observation)).usage.input_tokens).toBe(17)
    expect((await f.observe())?.usage.input_tokens).toBe(1)
  } finally { mock.mockRestore() }
  expect((await publisher.settle(observation)).usage.input_tokens).toBe(17)
  expect(await f.observe()).toEqual(observation)
})
for (const fault of ['missing', 'corrupt', 'unarmed', 'mismatch', 'receipt mismatch', 'source', 'symlink', 'oversized'] as const) {
  test(`recovery refuses ${fault} evidence beside its valid control`, async () => {
    const f = await fixture()
    expect(await f.observe()).toEqual(observation)
    if (fault === 'missing') await fs.unlink(f.receipt)
    if (fault === 'corrupt') await writeFile(f.receipt, '{')
    if (fault === 'unarmed') await writeFile(f.reservation, 'bound')
    if (fault === 'mismatch') await writeFile(f.reservation, 'foreign\n#dispatch-armed\n')
    if (fault === 'receipt mismatch') await writeFile(f.receipt, JSON.stringify({ identity: 'foreign', observation }))
    if (fault === 'source') await writeFile(f.receipt, JSON.stringify({ ...observation, source: 'codex-cli-jsonl' }))
    if (fault === 'symlink') { await fs.rename(f.receipt, f.receipt + '.target'); await symlink(f.receipt + '.target', f.receipt) }
    if (fault === 'oversized') await writeFile(f.receipt, JSON.stringify({ ...observation, padding: 'x'.repeat(256 * 1024) }))
    expect(await f.observe()).toBeUndefined()
  })
}
test('stalled recovery read has a bounded return and late completion cannot yield evidence', async () => {
  const f = await fixture()
  const original = fs.open
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  const mock = spyOn(fs, 'open').mockImplementation(async (...args) => { await delayed; return original(...args) })
  try { expect(await f.observe()).toBeUndefined() }
  finally { release(); mock.mockRestore() }
  expect(await f.observe()).toEqual(observation)
})
