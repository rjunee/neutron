import { describe, expect, test } from 'bun:test'

import {
  deriveProjectActivity,
  stripMarkdownForPreview,
  truncatePreview,
  PREVIEW_MAX_CHARS,
  type ProjectActivitySignals,
} from './project-rail.ts'

function signals(over: Partial<ProjectActivitySignals> = {}): ProjectActivitySignals {
  return {
    chatTurnInProgress: false,
    liveRunCount: 0,
    hasInlineActive: false,
    hasFailedNotDone: false,
    hasStalledLiveRun: false,
    ...over,
  }
}

describe('deriveProjectActivity — precedence (M1 UX REDESIGN)', () => {
  test('no signals → idle', () => {
    expect(deriveProjectActivity(signals())).toBe('idle')
  })

  test('a live chat turn → working', () => {
    expect(deriveProjectActivity(signals({ chatTurnInProgress: true }))).toBe('working')
  })

  test('a live bound run → working', () => {
    expect(deriveProjectActivity(signals({ liveRunCount: 2 }))).toBe('working')
  })

  test('an inline-active item → working', () => {
    expect(deriveProjectActivity(signals({ hasInlineActive: true }))).toBe('working')
  })

  test('a failed-not-done item → attention', () => {
    expect(deriveProjectActivity(signals({ hasFailedNotDone: true }))).toBe('attention')
  })

  test('a stalled live run → attention', () => {
    expect(deriveProjectActivity(signals({ hasStalledLiveRun: true }))).toBe('attention')
  })

  test('attention WINS over working (a stalled run while a chat turn runs)', () => {
    expect(
      deriveProjectActivity(
        signals({ chatTurnInProgress: true, liveRunCount: 1, hasStalledLiveRun: true }),
      ),
    ).toBe('attention')
  })

  test('a failed-not-done item outranks a concurrent live run', () => {
    expect(
      deriveProjectActivity(signals({ liveRunCount: 1, hasFailedNotDone: true })),
    ).toBe('attention')
  })
})

describe('stripMarkdownForPreview', () => {
  test('drops emphasis, code, headings, links, and collapses whitespace', () => {
    const raw = '# Title\n\nSome **bold** and _italic_ and `code` and [a link](https://x.com).'
    expect(stripMarkdownForPreview(raw)).toBe('Title Some bold and italic and code and a link.')
  })

  test('keeps image/link visible text, drops the url', () => {
    expect(stripMarkdownForPreview('see ![alt](a.png) and [click](http://y)')).toBe(
      'see alt and click',
    )
  })

  test('flattens bullet lists and blockquotes to one line', () => {
    expect(stripMarkdownForPreview('> quoted\n- one\n- two')).toBe('quoted one two')
  })
})

describe('truncatePreview', () => {
  test('null/empty body → null', () => {
    expect(truncatePreview(null)).toBeNull()
    expect(truncatePreview(undefined)).toBeNull()
    expect(truncatePreview('   ')).toBeNull()
    expect(truncatePreview('```')).toBeNull() // strips to empty
  })

  test('short body passes through stripped, no ellipsis', () => {
    expect(truncatePreview('hello there')).toBe('hello there')
  })

  test('truncates a long body to the budget with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const out = truncatePreview(long)!
    expect(out.length).toBe(PREVIEW_MAX_CHARS)
    expect(out.endsWith('…')).toBe(true)
  })

  test('honours a custom max', () => {
    const out = truncatePreview('abcdefghij', 5)!
    expect(out).toBe('abcd…')
    expect(out.length).toBe(5)
  })

  test('truncation strips markdown first (budget applies to visible text)', () => {
    const raw = '**' + 'a'.repeat(100) + '**'
    const out = truncatePreview(raw)!
    // The `**` markers are gone, so all 90 budget chars are real content.
    expect(out.startsWith('a')).toBe(true)
    expect(out.length).toBe(PREVIEW_MAX_CHARS)
  })
})
