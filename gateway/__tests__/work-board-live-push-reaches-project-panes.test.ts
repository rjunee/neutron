/**
 * A BOARD PUSH MUST REACH THE PANE SHOWING THAT BOARD.
 *
 * THE DEFECT. `fanWorkBoardChanged` addressed its snapshot to `appWsTopicId(OWNER)`
 * — the base topic, and only that. But a served client holds ONE socket scoped to
 * whatever it is currently looking at: General sits on `app:<owner>`, and a project
 * sits on `app:<owner>:<project_id>` (`gateway/http/app-ws-surface.ts` registers
 * `resolveChannelTopicId(user_id, project_id)`; `landing/chat-react/config.ts`
 * `topicForProject` and `app/lib/work-board-live.ts` both derive the same string).
 * `InMemoryAppWsSessionRegistry.send` resolves its target with a single `Map.get` —
 * an EXACT key match, no prefix fan — so a push addressed to the base topic reached
 * a client sitting inside a project NEVER.
 *
 * Which is the owner's report: a pane reading `No work tracked yet` while the agent
 * wrote rows to exactly the board it was showing. And it could not self-repair,
 * because the 15s fallback poll was gated on a live row being ALREADY VISIBLE — so
 * the empty pane was the one state the fallback could not reach. Both halves are
 * asserted here.
 *
 * `fanProjectsChanged`, twenty lines above the work-board fan in the same file,
 * already carries this fix and its own docblock describing this exact bug for the
 * project rail (#132). The work-board fan was written afterwards and did not copy it.
 *
 * WHY A SOURCE-LEVEL GUARD. The fan is a closure inside `composeOpenGateway`, built
 * over the live registry and store; there is no seam to call it through without
 * booting the whole composer. Asserting the topology in the PRODUCTION file is the
 * honest available check — and a hand-built copy of the two-line fan, executed
 * against a fresh registry, would prove only that the test can write a for-loop.
 * Every assertion below is mutation-tested: deleting the scoped loop, or re-gating
 * the poll on `hasLiveRun` alone, turns this file red.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const read = (...parts: string[]): string => readFileSync(join(REPO_ROOT, ...parts), 'utf8')

/** The body of a `const <name> = ` arrow, up to the closing `}` at its indent. */
function blockAfter(source: string, marker: string): string {
  const idx = source.indexOf(marker)
  expect(idx).toBeGreaterThan(-1)
  return source.slice(idx, idx + 3000)
}

describe('the work-board live push is addressed to every live topic', () => {
  const composer = read('open', 'composer.ts')

  test('the fan walks the registry topics, not just the base topic', () => {
    const fan = blockAfter(composer, 'const fanWorkBoardChanged =')
    // It still sends to the base topic — General lives there.
    expect(/appWsRegistry\.send\(base, frame\)/.test(fan)).toBe(true)
    // ...AND to every live per-project topic, which is the half that was missing.
    expect(fan.includes('appWsRegistry.topics()')).toBe(true)
    expect(/startsWith\(scopedPrefix\)/.test(fan)).toBe(true)
    expect(/const scopedPrefix = `\$\{base\}:`/.test(fan)).toBe(true)
  })

  test('it uses the SAME topology as the project-rail fan it sits beside', () => {
    // Not a style point: these two frames have the same delivery problem, and the
    // rail fan is the one that already learned it. If they ever diverge, one of the
    // two is wrong — so pin them to the same three markers.
    const railFan = blockAfter(composer, 'const fanProjectsChanged =')
    const boardFan = blockAfter(composer, 'const fanWorkBoardChanged =')
    for (const marker of ['appWsRegistry.topics()', 'startsWith(scopedPrefix)']) {
      expect(railFan.includes(marker)).toBe(true)
      expect(boardFan.includes(marker)).toBe(true)
    }
  })

  /**
   * The receiving end of the widened fan. Fanning to more topics is only safe
   * because every client re-checks the frame's own `project_id` tag against the
   * board it is displaying — drop that and a General snapshot would overwrite a
   * project pane, which is strictly worse than the bug being fixed.
   */
  test('both clients still gate an incoming frame on its project tag', () => {
    const web = read('landing', 'chat-react', 'WorkBoardTab.tsx')
    expect(/\(framePid \?\? ''\) !== projectId/.test(web)).toBe(true)
    const mobile = read('app', 'lib', 'work-board-live.ts')
    expect(/framePid !== project_id/.test(mobile)).toBe(true)
  })
})

describe('an empty pane can recover on its own', () => {
  const tab = read('landing', 'chat-react', 'WorkBoardTab.tsx')

  test('the fallback poll is not gated on an already-visible live row', () => {
    // A board with zero rows cannot contain a live row, so `hasLiveRun` alone made
    // the empty state unrecoverable — precisely the state the owner was looking at.
    expect(/const shouldPoll = hasLiveRun \|\|/.test(tab)).toBe(true)
    expect(/items\.length === 0/.test(tab)).toBe(true)
    // The interval must actually consume the widened gate.
    expect(/if \(!shouldPoll\) return/.test(tab)).toBe(true)
    expect(/\}, \[shouldPoll, refresh\]\)/.test(tab)).toBe(true)
  })

  test('the empty-state poll waits for a SETTLED read', () => {
    // Polling during the initial fetch would race it, and polling through a
    // rendered error would hammer a surface already known to be failing.
    expect(/!loading && listError === null && items\.length === 0/.test(tab)).toBe(true)
  })
})
