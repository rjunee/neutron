/**
 * ONE MAPPING FROM `project_id` TO THE BOARD NAME THE OWNER READS.
 *
 * Three owner-facing surfaces answer "which board?" — the deterministic work-board
 * chat acks, the per-turn `<work_board>` prompt block, and the `/status` project
 * line. Each is wired in `open/composer.ts`, and the whole point of the fix is that
 * all three go through `boardLabelForProjectId`.
 *
 * WHY A STRUCTURAL TEST AND NOT A BEHAVIOURAL ONE. The behaviour of the mapping is
 * covered by `work-board/chat-ack.test.ts` (labels, the General short-circuit, the
 * id-never-leaks guard) and its delivery end-to-end by
 * `work-board/agent-tool.test.ts` over the real ack. Neither can see a SECOND
 * mapping growing somewhere else in the composer — and that is exactly what had
 * happened: the `/status` line carried its own
 * `readProjectRows().find(...)?.label ?? 'General'`, which named the WRONG board
 * (`General`) for a project id it could not resolve, printed beside an
 * `active_work_items` count read from the real project scope. Two numbers, two
 * different boards, one line. A duplicate mapping is invisible to every
 * behavioural test of the mapping itself, because each copy is self-consistent.
 *
 * So this file asserts the SHAPE of the wiring. It is deliberately narrow: it pins
 * that the label sites call the shared resolver and that no local `?? 'General'`
 * name fallback exists, and nothing about how the resolver behaves.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const composerPath = fileURLToPath(new URL('../../open/composer.ts', import.meta.url))
const composer = readFileSync(composerPath, 'utf8')

/** Source lines, comments stripped, so a docblock quoting a pattern is not a hit. */
const codeLines = composer
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''))

describe('every owner-facing board name resolves through ONE mapping', () => {
  test('the composer imports the shared resolver', () => {
    expect(composer).toContain('boardLabelForProjectId')
    expect(composer).toContain("from '@neutronai/work-board/chat-ack.ts'")
  })

  // The regression that motivated this file: a second, subtly different mapping.
  // `?? 'General'` after a project lookup is that shape — it names General for an
  // id it merely failed to resolve, which is a WRONG board, not a missing name.
  test('no local project-name lookup falls back to a bare General literal', () => {
    const offenders = codeLines.filter(
      (line) => /\?\?\s*'General'/.test(line) || /:\s*'General'/.test(line),
    )
    expect(offenders).toEqual([])
  })

  // `General` is one word of owner-facing vocabulary and belongs in one place.
  // A local literal is how a second spelling ("general", "Default") starts.
  test("the word General is not re-spelled as a literal in the composer", () => {
    expect(codeLines.filter((line) => line.includes("'General'"))).toEqual([])
    expect(composer).toContain('GENERAL_BOARD_LABEL')
  })

  test('the /status project line resolves through the shared resolver', () => {
    const statusLine = codeLines.find((line) => line.includes('const activeProject'))
    expect(statusLine).toBeDefined()
    expect(statusLine).toContain('boardLabelForProjectId')
  })

  // The ack takes a project-NAME lookup, not the full rail read. `readProjectRows()`
  // is O(projects) SQL plus a per-project unread + rail-extras query, and these
  // callers want one name — on every ack and every agent turn.
  test('the label sites use the single-row lookup, not the full rail read', () => {
    const labelSites = codeLines.filter(
      (line) => line.includes('boardLabelForProjectId(') || line.includes('project_name:'),
    )
    // The import line is not a call site.
    expect(labelSites.length).toBeGreaterThanOrEqual(3)
    for (const site of labelSites) {
      expect(site).not.toContain('readProjectRows')
    }
  })

  test('the work-board prompt block is handed a resolved label, not a raw id', () => {
    const snapshotIdx = codeLines.findIndex((line) => line.includes('workBoardSnapshot:'))
    expect(snapshotIdx).toBeGreaterThan(-1)
    const body = codeLines.slice(snapshotIdx, snapshotIdx + 8).join('\n')
    expect(body).toContain('formatWorkBoardFragment(')
    expect(body).toContain('boardLabelForProjectId(')
  })
})
