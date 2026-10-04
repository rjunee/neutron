import { expect, test } from 'bun:test'
import { inspectIdleRelicShell } from '../relic-shell-census.ts'
import { RelicProcFixture } from './workspace-relic-fixture.ts'

test.each(['valid', 'start', 'boot', 'uid', 'session', 'tty', 'malformed', 'partial-list'] as const)('held shell kernel identity: %s', fault => {
  const proc = new RelicProcFixture(), pid = 40001
  proc.add(pid)
  const originalRead = proc.read.bind(proc)
  let subjectReads = 0, bootReads = 0
  proc.read = path => {
    if (path === `/proc/${pid}/stat` && ++subjectReads > 1 && fault === 'start') proc.rows.get(pid)!.ticks = '200'
    if (path.endsWith('/boot_id') && ++bootReads > 1 && fault === 'boot') return '99999999-2222-3333-4444-555555555555'
    if (path === `/proc/${pid}/stat` && fault === 'malformed') return 'malformed'
    return originalRead(path)
  }
  if (fault === 'uid') proc.uid = () => process.getuid!() + 1
  if (fault === 'session') proc.rows.get(pid)!.session = 99
  if (fault === 'tty') proc.rows.get(pid)!.tty = 0
  if (fault === 'partial-list') proc.list = () => [String(process.pid)]
  const result = inspectIdleRelicShell(pid, proc)
  if (fault === 'valid') expect(result).toMatchObject({ pid, startTicks: '100', session: pid, tty: pid })
  else expect(result).toBeUndefined()
})

test('a privileged observer must explicitly select the shell UID', () => {
  const proc = new RelicProcFixture(), pid = 40001
  proc.add(pid); proc.uid = () => process.getuid!() + 1
  expect(inspectIdleRelicShell(pid, proc)).toBeUndefined()
  expect(inspectIdleRelicShell(pid, proc, process.getuid!() + 1)?.pid).toBe(pid)
})
