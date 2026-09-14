import { describe, expect, test } from 'bun:test'
import { observeWorkerScreen, describeWorkerObservation } from '../worker-observation.ts'
import { observeWorkers, observeSession } from '../observe-workers.ts'
import { ReplSession } from '../repl-session.ts'
import type { PtyChild } from '../pty-host.ts'

const menu = 'Choose an organization\n❯ Alpha\n  Beta\nEnter to select · Esc to cancel'
function session(cwd: string, readScreen?: () => Promise<string>): ReplSession {
  const s = new ReplSession('worker-test', 'generation-test', 'session-test', 'channel-test', cwd)
  s.attachChild({ hasExited: () => false, readScreen } as PtyChild)
  s.ring.replace('last retained screen')
  return s
}

describe('worker observations', () => {
  test('a selected option plus input instruction is positive evidence', () => {
    const o = observeWorkerScreen(menu, true, 1000)
    expect(o.state).toBe('blocked')
    expect(describeWorkerObservation(o)).toContain(menu)
    expect(o.observed_at).toBe(new Date(1000).toISOString())
  })
  test('working chrome vetoes a historical menu', () => {
    expect(observeWorkerScreen(`${menu}\nBuilding… esc to interrupt`, true).state).toBe('working')
  })
  test.each([
    'Thinking quietly', '', '❯',
    'Choose an organization\n❯ Alpha\n  Beta',
    'Choose an organization\nAlpha\nEnter to select',
    `\`\`\`\n${menu}\n\`\`\``,
    menu.split('\n').map((s) => `> ${s}`).join('\n'),
    `${menu}\n❯`,
    `\`\`\`\n${'example\n'.repeat(60)}${menu}\n\`\`\``,
  ])('unclassified output stays unknown: %s', (screen) => {
    expect(observeWorkerScreen(screen, true).state).toBe('unknown')
  })
  test('byte history cannot establish a current prompt', () => {
    const o = observeWorkerScreen(menu, false)
    expect(o.state).toBe('unknown')
    expect(o.screen).toBe(menu)
  })
  test('exact worktree ownership excludes a blocked sibling', async () => {
    const own = session('/repo/work', async () => 'Building… esc to interrupt')
    const other = session('/repo/other', async () => menu)
    expect((await observeWorkers(['/repo/work'], [own, other])).state).toBe('working')
    expect((await observeWorkers(['/repo/other'], [own, other])).state).toBe('blocked')
    expect((await observeWorkers(['/repo/missing'], [own, other])).state).toBe('unknown')
  })
  test('a blind sibling prevents an all-working claim; a blocked sibling wins', async () => {
    const own = session('/repo/work', async () => 'Building… esc to interrupt')
    const blind = session('/repo/work')
    const blocked = session('/repo/work', async () => menu)
    expect((await observeWorkers(['/repo/work'], [own, blind])).state).toBe('unknown')
    expect((await observeWorkers(['/repo/work'], [own, blocked])).state).toBe('blocked')
  })
  test('capture failure retains evidence and cannot claim blocked', async () => {
    const s = session('/repo/work', async () => { throw new Error('unavailable') })
    s.ring.replace(menu)
    const o = await observeSession(s)
    expect(o.state).toBe('unknown')
    expect(o.screen).toBe(menu)
    expect(o.detail).toContain('current screen unavailable')
  })
  test('a stuck capture is bounded independently of the worker', async () => {
    const s = session('/repo/work', () => new Promise(() => {}))
    expect((await observeSession(s)).state).toBe('unknown')
  })
})


test('a dead child cannot supply current prompt evidence', async () => {
  let reads = 0
  const s = session('/repo/work')
  s.ring.replace(menu)
  s.attachChild({ hasExited: () => true, readScreen: async () => { reads += 1; return menu } } as PtyChild)
  const o = await observeSession(s)
  expect(o.state).toBe('unknown')
  expect(o.screen).toBe(menu)
  expect(reads).toBe(0)
})
