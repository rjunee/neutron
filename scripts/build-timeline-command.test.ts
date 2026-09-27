import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordCommandPhase, type CommandPhaseOptions } from './build-timeline-command.ts'
import { readPhaseObservations, type DirectPhaseObservation } from './build-timeline-sources.ts'
import { combineTimelineSources } from '@neutronai/trident/build-timeline-catalogue.ts'
import { renderTimeline } from '@neutronai/trident/build-timeline-html.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function fixture(): Promise<CommandPhaseOptions> {
  const directory = await mkdtemp(join(tmpdir(), 'timeline-command-'))
  directories.push(directory)
  return { output: join(directory, 'observations.jsonl'), links: [{ repository: 'example/project', prNumber: 7 }],
    phase: 'test', label: 'Focused tests', model: null, timeoutMs: 3000,
    argv: [process.execPath, '-e', 'process.exit(0)'] }
}
async function events(file: string): Promise<DirectPhaseObservation[]> {
  return (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}
function cli(options: CommandPhaseOptions, extra: string[] = []) {
  return Bun.spawn([process.execPath, join(import.meta.dir, 'build-timeline-command.ts'),
    '--output', options.output, '--pr', 'example/project#7', '--phase', options.phase,
    '--label', options.label, '--timeout-ms', String(options.timeoutMs), ...extra, '--', ...options.argv],
  { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
}
function project(observations: DirectPhaseObservation[]) {
  return combineTimelineSources({ observedAt: Date.now(), repositories: [] }, observations, [], Date.now() + 10)
}

test('real child sees durable start before executing; completed phase is consumed with unknown metrics', async () => {
  const options = await fixture()
  options.links.push({ repository: 'example/operations', prNumber: 9 })
  options.argv = [process.execPath, '-e', `
    const rows = (await Bun.file(process.argv[1]).text()).trim().split('\\n').map(JSON.parse);
    if (rows.length !== 1 || rows[0].endedAt !== null) process.exit(23);
    await Bun.sleep(25);
  `, options.output]
  const before = Date.now()
  const result = await recordCommandPhase(options)
  const after = Date.now()
  expect(result).toMatchObject({ command: { outcome: 'exited', exitCode: 0 }, recording: { status: 'complete' } })
  const rows = await events(options.output)
  expect(rows).toHaveLength(2)
  expect(rows[0]!.phaseId).toBe(rows[1]!.phaseId)
  expect(rows[0]!.eventId).not.toBe(rows[1]!.eventId)
  expect(rows[0]!.startedAt).toBeGreaterThanOrEqual(before)
  expect(rows[1]!.endedAt!).toBeLessThanOrEqual(after)
  expect(rows[1]!.endedAt! - rows[0]!.startedAt).toBeGreaterThanOrEqual(25)
  expect(rows[1]!.observedAt).toBeGreaterThan(rows[0]!.observedAt)
  expect(rows[1]!.source.evidenceRef).toMatch(/^command:[0-9a-f-]{36}$/)
  expect(rows[1]!.source.attribution).toBe('explicit')
  for (const field of ['model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd'] as const) {
    expect(rows[1]![field]).toBeNull()
  }
  const snapshot = project(await readPhaseObservations(options.output))
  expect(snapshot.cards).toHaveLength(2)
  expect(snapshot.cards[0]!.segments[0]).toMatchObject({ timing: 'recorded', model: null,
    usage: { tokens: null, costUsd: null, coverage: 'unknown' } })
  expect(snapshot.cards[0]!.segments[0]!.detail).toContain('shared span')
  expect(renderTimeline(snapshot)).toContain('Focused tests')
})

test('CLI preserves a failed command exit and records its measured duration and invoking model', async () => {
  const options = await fixture()
  options.argv = [process.execPath, '-e', 'await Bun.sleep(20); process.exit(19)']
  const child = cli(options, ['--model', 'invoking-model'])
  expect(await child.exited).toBe(19)
  expect(JSON.parse((await new Response(child.stderr).text()).trim())).toMatchObject({
    type: 'command-phase-result', command: { exitCode: 19 }, recording: { status: 'complete' },
  })
  const [row] = await readPhaseObservations(options.output)
  expect(row!.model).toBe('invoking-model')
  expect(row!.endedAt! - row!.startedAt).toBeGreaterThanOrEqual(20)
  expect(project([row!]).cards[0]!.segments[0]!.detail).toContain('exit code 19')
})

test('missing, invalid and duplicated explicit PR links refuse before command execution', async () => {
  for (const links of [[], [{ repository: '../private', prNumber: 7 }],
    [{ repository: 'example/project', prNumber: 0 }],
    [{ repository: 'example/project', prNumber: 7 }, { repository: 'example/project', prNumber: 7 }]]) {
    const options = await fixture()
    options.links = links
    const marker = options.output + '.executed'
    options.argv = [process.execPath, '-e', 'await Bun.write(process.argv[1], "executed")', marker]
    await expect(recordCommandPhase(options)).rejects.toThrow('start recording refused')
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await Bun.file(options.output).exists()).toBe(false)
  }
  const valid = await fixture()
  expect((await recordCommandPhase(valid)).recording.status).toBe('complete')
})

test('unsafe public provenance text and unbounded commands refuse, while explicit unknown model works', async () => {
  for (const change of [{ label: '/private/command' }, { model: 'secret=value' }, { model: undefined },
    { phase: 'guess' }, { timeoutMs: 0 }, { timeoutMs: Infinity }]) {
    const options = { ...await fixture(), ...change } as CommandPhaseOptions
    await expect(recordCommandPhase(options)).rejects.toThrow()
    expect(await Bun.file(options.output).exists()).toBe(false)
  }
  const options = await fixture()
  const child = cli(options, ['--model', 'unknown'])
  expect(await child.exited).toBe(0)
  expect((await readPhaseObservations(options.output))[0]!.model).toBeNull()
})

test('argv stays literal and private command text, output paths and output never enter served evidence', async () => {
  const options = await fixture()
  const marker = options.output + '.shell-executed'
  const literal = `$(touch ${marker}); private-command-token`
  options.argv = [process.execPath, '-e', 'if (!process.argv[1].startsWith("$(touch ")) process.exit(4); console.log("private-output-token")', literal]
  const child = cli(options)
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stdout).text()).toContain('private-output-token')
  expect(await Bun.file(marker).exists()).toBe(false)
  const journal = await readFile(options.output, 'utf8')
  const html = renderTimeline(project(await readPhaseObservations(options.output)))
  for (const evidence of [journal, html]) {
    expect(evidence).toContain('Focused tests')
    expect(evidence).not.toContain('private-command-token')
    expect(evidence).not.toContain('private-output-token')
    expect(evidence).not.toContain(options.output)
    expect(evidence).not.toContain('process.argv')
  }
})

test('unwritable or invalid start journal refuses rather than executing', async () => {
  const options = await fixture()
  await writeFile(options.output, 'not json\n')
  const child = cli(options)
  expect(await child.exited).toBe(125)
  const report = await new Response(child.stderr).text()
  expect(JSON.parse(report)).toMatchObject({ type: 'command-phase-refused' })
  expect(report).not.toContain(options.output)
  expect(await readFile(options.output, 'utf8')).toBe('not json\n')
})

test('completion recording failure is distinct from command status and leaves the recorded start open', async () => {
  for (const exitCode of [0, 21]) {
    const options = await fixture()
    options.argv = [process.execPath, '-e',
      'await Bun.write(process.argv[1] + ".lock", "fixture lock"); process.exit(Number(process.argv[2]))',
      options.output, String(exitCode)]
    const child = cli(options)
    expect(await child.exited).toBe(exitCode)
    expect(JSON.parse((await new Response(child.stderr).text()).trim())).toMatchObject({
      type: 'command-phase-result', command: { exitCode }, recording: { status: 'failed', boundary: 'end' },
    })
    const rows = await events(options.output)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.endedAt).toBeNull()
    const card = project(rows).cards[0]!
    expect(card.segments[0]!.timing).toBe('open')
    expect(card.workSignal?.state ?? 'unknown').toBe('unknown')
    expect(renderTimeline(project(rows))).toContain('No live signal')
  }
})

test('spawn failure and bounded child timeout record actual observed termination', async () => {
  const missing = await fixture()
  missing.argv = [join(missing.output, 'no-executable')]
  expect(await recordCommandPhase(missing)).toMatchObject({ command: { outcome: 'spawn-failed', exitCode: 127 } })
  expect((await readPhaseObservations(missing.output))[0]!.source.basis).toContain('spawn-failed')
  const bounded = await fixture()
  bounded.timeoutMs = 50
  bounded.argv = [process.execPath, '-e', 'await Bun.sleep(2000)']
  expect(await recordCommandPhase(bounded)).toMatchObject({ command: { outcome: 'signalled', exitCode: 137, signal: 'SIGKILL' } })
  expect((await readPhaseObservations(bounded.output))[0]!.endedAt).not.toBeNull()
})

test('killed observer leaves unknown end even though its bounded fixture child exits', async () => {
  const options = await fixture()
  options.argv = [process.execPath, '-e', 'process.kill(process.ppid, "SIGKILL"); process.exit(0)']
  const child = cli(options)
  expect(await child.exited).not.toBe(0)
  const rows = await events(options.output)
  expect(rows).toHaveLength(1)
  expect(rows[0]!.endedAt).toBeNull()
  const card = project(rows).cards[0]!
  expect(card.segments[0]!.timing).toBe('open')
  expect(card.workSignal?.state ?? 'unknown').toBe('unknown')
})
