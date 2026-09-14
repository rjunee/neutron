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
  // THE SHAPES BELOW ARE TRANSCRIBED FROM LIVE `pane.read` CAPTURES (2026-09-14,
  // four panes: a tool-permission prompt, the trust dialog, a working pane and an
  // idle one). Two properties of a REAL capture are what the first version of this
  // detector missed, and both are pinned here rather than described:
  //   1. the viewport is padded with BLANK ROWS below the dialog, so a window
  //      anchored on the raw last line reads padding;
  //   2. the tool-permission prompt's instruction is `Esc to cancel · Tab to
  //      amend` — it never says "Enter to select".
  // Measured before the fix: this exact capture classified `unknown`.
  const toolPrompt = [
    ' Bash command',
    '',
    '   │ git status --short',
    '   Show the working tree status',
    '',
    ' Contains simple_expansion',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and switch to auto mode · auto mode handles these prompts for you',
    '   3. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n')
  const padded = (screen: string): string => `${screen}${'\n'.repeat(12)}`

  test('the tool-permission prompt is blocked through the viewport padding', () => {
    expect(observeWorkerScreen(padded(toolPrompt), true).state).toBe('blocked')
    expect(observeWorkerScreen(toolPrompt, true).state).toBe('blocked')
  })
  test('padding does not hide the working control either', () => {
    expect(observeWorkerScreen(padded('Editing files… esc to interrupt'), true).state).toBe('working')
  })
  // THE CONTROL THAT MUST SURVIVE. A composer draws `❯ <typed text>` on a pane
  // that is perfectly healthy, and the status rows under it look like options.
  // Only the dialog instruction separates the two, so a widened instruction set
  // must still leave this one alone: calling a working worker blocked is the
  // expensive direction.
  test.each([
    ['a working composer', '❯ pick up where we left off\n────────\n\n  ⏵⏵ auto mode on · 2 shells, 4 monitors · ← 1 agent\n  ● main\n  ◯ general-purpose  Confirming clean state  49m 15s'],
    ['an idle composer', '  new task? /clear to save 207.6k tokens\n────────\n❯\n────────\n\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent'],
  ])('a live cursor without dialog chrome is not blocked: %s', (_name, screen) => {
    expect(observeWorkerScreen(padded(screen), true).state).not.toBe('blocked')
  })
  test('dialog chrome without an option list is not a menu', () => {
    // The composer can carry a cursor AND a cancel hint; the SIBLING OPTION is
    // what makes a menu a menu, so this must stay unknown.
    expect(observeWorkerScreen(padded('❯ resume the rebase\n\n Esc to cancel · Tab to amend'), true).state).toBe('unknown')
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
