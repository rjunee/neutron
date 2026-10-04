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

test.each(['unfiltered', 'hidepid-zero', 'hidepid-two', 'hidepid-four', 'hidepid-unknown', 'missing', 'bind-root', 'pid-overmount', 'changed'] as const)('kernel census verifies full proc visibility: %s', fault => {
  const proc = new RelicProcFixture(), pid = 40001
  proc.add(pid)
  const read = proc.read.bind(proc)
  let mountReads = 0
  proc.read = path => {
    if (path !== '/proc/self/mountinfo') return read(path)
    mountReads += 1
    const base = '123 1 0:1 / /proc rw - proc proc rw'
    if (fault === 'missing') return ''
    if (fault === 'hidepid-zero') return `${base},hidepid=0`
    if (fault === 'hidepid-two') return `${base},hidepid=2`
    if (fault === 'hidepid-four') return `${base},hidepid=4`
    if (fault === 'hidepid-unknown') return `${base},hidepid=unknown`
    if (fault === 'bind-root') return base.replace(' / /proc ', ' /subset /proc ')
    if (fault === 'pid-overmount') return `${base}\n124 123 0:2 / /proc/55555 rw - tmpfs tmpfs rw`
    if (fault === 'changed' && mountReads > 1) return `${base},hidepid=2`
    return base
  }
  const result = inspectIdleRelicShell(pid, proc)
  if (fault === 'unfiltered' || fault === 'hidepid-zero') expect(result?.pid).toBe(pid)
  else expect(result).toBeUndefined()
})
