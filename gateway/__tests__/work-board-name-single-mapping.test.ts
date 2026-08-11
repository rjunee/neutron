/**
 * ONE MAPPING FROM `project_id` TO THE BOARD NAME THE OWNER READS.
 *
 * Four owner-facing surfaces answer "which board?" — the deterministic work-board
 * chat acks, the per-turn `<work_board>` prompt block, the `/status` project line,
 * and the `#339` build-delivery topic. Each is wired in `open/composer.ts`, and the
 * whole point of the fix is that all of them go through the SHARED resolvers
 * (`boardLabelForProjectId` for the name, `normalizeBoardProjectId` for the scope).
 *
 * WHY A STRUCTURAL TEST AND NOT A BEHAVIOURAL ONE. The behaviour of the mapping is
 * covered by `work-board/chat-ack.test.ts`, and the DB-to-name-to-topic wiring
 * end-to-end through a real Open boot by
 * `tests/integration/work-board-ack-names-board.open.test.ts`. Neither can see a
 * SECOND mapping growing somewhere else in the composer — and that is exactly what
 * had happened: the `/status` line carried its own
 * `readProjectRows().find(...)?.label ?? 'General'`, which named the WRONG board
 * (`General`) for a project id it could not resolve, printed beside an
 * `active_work_items` count read from the real project scope. Two numbers, two
 * different boards, one line. A duplicate mapping is invisible to every
 * behavioural test of the mapping itself, because each copy is self-consistent.
 *
 * WHAT THIS FILE LEARNED FROM ITS OWN MUTATION TESTING (Argus r2, MAJOR). The first
 * version pinned a SPELLING and a COUNT, which is not the invariant:
 *
 *   - it asserted `labelSites.length >= 3`, so adding a FOURTH duplicate mapping
 *     made the guard greener rather than red;
 *   - it matched only the literal `?? 'General'`, so the same fallback written
 *     with backticks or double quotes sailed through;
 *   - its comment-stripper deleted everything after `//` on any line, which also
 *     ate `//` INSIDE a string literal and blinded it to code on that line.
 *
 * So it now asserts the invariant directly: the only way to turn a project id into
 * an owner-facing name in this file is the shared resolver, and the only way to
 * decide "is this General?" is the shared normalizer. Both are stated as
 * "no line may do X", which a duplicate cannot satisfy by adding to a count.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const composerPath = fileURLToPath(new URL('../../open/composer.ts', import.meta.url))
const composer = readFileSync(composerPath, 'utf8')

/**
 * Source lines with COMMENTS stripped, so a docblock quoting a banned pattern is
 * not a hit. Deliberately only strips comments that own the WHOLE line
 * (`// …` / ` * …`) — the previous `replace(/\/\/.*$/)` also truncated any line
 * containing `//` inside a string literal (a URL, a path), silently hiding real
 * code from every assertion below. Trailing same-line comments therefore DO reach
 * the assertions; that is the safe direction (a false positive is visible, a
 * false negative is not), and the fix is to not quote a banned pattern in a
 * trailing comment.
 */
const codeLines = composer
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))

/** Every spelling of a `General` string literal: quotes, double quotes, backticks. */
const GENERAL_LITERAL = /(['"`])General\1/

describe('every owner-facing board name resolves through ONE mapping', () => {
  test('the composer imports the shared resolvers', () => {
    expect(composer).toContain('boardLabelForProjectId')
    expect(composer).toContain("from '@neutronai/work-board/chat-ack.ts'")
    expect(composer).toContain('normalizeBoardProjectId')
  })

  /**
   * The regression that motivated this file: a second, subtly different mapping.
   * A `General` literal is where one starts, in ANY quoting style — the previous
   * version pinned single quotes only, and a backtick copy survived its mutant.
   */
  test('the word General is never a literal in the composer, in any quoting style', () => {
    const offenders = codeLines.filter((line) => GENERAL_LITERAL.test(line))
    expect(offenders).toEqual([])
    // It exists exactly once, as owner-facing vocabulary, in the work-board module.
    expect(composer).toContain('GENERAL_BOARD_LABEL')
  })

  /**
   * THE INVARIANT, stated so a duplicate cannot satisfy it: the single-row name
   * query is a PRIVATE input to the shared resolver, never a name source in its
   * own right. Every mention of it must be its own definition, or an argument
   * handed to `boardLabelForProjectId` / the ack's `project_name` port.
   *
   * This is what kills the "second mapping" mutant regardless of how it is
   * spelled: any new `readProjectName(...)` call that renders a name itself is an
   * offender line, and adding more of them cannot make a count pass.
   */
  test('the project-name query is only ever consumed by the shared resolver', () => {
    const mentions = codeLines.filter((line) => line.includes('readProjectName'))
    // Definition + every legitimate consumption. Nothing else may touch it.
    const allowed = mentions.filter(
      (line) =>
        line.includes('const readProjectName =') ||
        line.includes('boardLabelForProjectId(') ||
        line.includes('project_name:'),
    )
    expect(mentions.length).toBeGreaterThan(0)
    expect(mentions).toEqual(allowed)
  })

  /**
   * The full rail read is O(projects) SQL plus a per-project unread + rail-extras
   * query, and a label site wants ONE name. It is also the shape the duplicate
   * `/status` mapping used, so a label site reaching for it is the regression.
   */
  test('no label site resolves a name through the full rail read', () => {
    const labelSites = codeLines.filter(
      (line) => line.includes('boardLabelForProjectId(') || line.includes('project_name:'),
    )
    expect(labelSites.length).toBeGreaterThan(0)
    for (const site of labelSites) {
      expect(site).not.toContain('readProjectRows')
    }
  })

  test('the /status project line resolves through the shared resolver', () => {
    const statusLine = codeLines.find((line) => line.includes('const activeProject'))
    expect(statusLine).toBeDefined()
    expect(statusLine).toContain('boardLabelForProjectId')
  })

  test('the work-board prompt block is handed a resolved label, not a raw id', () => {
    const snapshotIdx = codeLines.findIndex((line) => line.includes('workBoardSnapshot:'))
    expect(snapshotIdx).toBeGreaterThan(-1)
    const body = codeLines.slice(snapshotIdx, snapshotIdx + 8).join('\n')
    expect(body).toContain('formatWorkBoardFragment(')
    expect(body).toContain('boardLabelForProjectId(')
  })

  /**
   * The SCOPE twin of the name invariant. "Is this General?" is a three-way test
   * (`null` / `''` / the `'general'` sentinel) and every hand-rolled copy of it has
   * omitted the sentinel — which is precisely how the ack came to name the right
   * board and deliver to a topic nobody subscribes to. The chat-topic router must
   * ask the shared normalizer, not re-derive the test.
   */
  test('the chat-topic router decides General through the shared normalizer', () => {
    const idx = codeLines.findIndex((line) => line.includes('const tridentDeliveryChatId ='))
    expect(idx).toBeGreaterThan(-1)
    const body = codeLines.slice(idx, idx + 6).join('\n')
    expect(body).toContain('normalizeBoardProjectId(')
    // The hand-rolled test this replaced, which the sentinel walked straight past.
    expect(body).not.toContain('.length > 0')
  })
})
