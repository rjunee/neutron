import { describe, expect, test } from 'bun:test'
import {
  boardLabelForProjectId,
  buildWorkBoardChatAck,
  GENERAL_BOARD_LABEL,
  UNKNOWN_BOARD_LABEL,
  type WorkBoardChatAckKind,
  type WorkBoardProjectRow,
} from './chat-ack.ts'
import { GENERAL_WORK_BOARD_PROJECT_ID } from './store.ts'

interface Posted {
  chat_id: string
  text: string
}

/** The stand-in project rail. `p1`/`p2` mirror the ids the dedup tests post. */
const RAIL: WorkBoardProjectRow[] = [
  { id: 'p1', label: 'Example Project' },
  { id: 'p2', label: 'Second Project' },
  { id: 'proj-x', label: 'Project X' },
]

function harness(opts?: {
  now?: () => number
  dedup_window_ms?: number
  projects?: () => readonly WorkBoardProjectRow[]
}) {
  const posts: Posted[] = []
  const resolvedWith: Array<string | null> = []
  const ack = buildWorkBoardChatAck({
    resolve_chat_id: (project_id) => {
      resolvedWith.push(project_id)
      return project_id === null ? 'chat:general' : `chat:${project_id}`
    },
    projects: opts?.projects ?? (() => RAIL),
    post: (chat_id, text) => {
      posts.push({ chat_id, text })
    },
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
    ...(opts?.dedup_window_ms !== undefined ? { dedup_window_ms: opts.dedup_window_ms } : {}),
  })
  return { ack, posts, resolvedWith }
}

describe('buildWorkBoardChatAck — exact texts', () => {
  test('card_added text', () => {
    const { ack, posts } = harness()
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'Ship the landing page', kind: 'card_added' })
    expect(posts).toEqual([
      { chat_id: 'chat:p1', text: '▸ On the Work Board · Example Project: "Ship the landing page"' },
    ])
  })

  test('build_dispatched text', () => {
    const { ack, posts } = harness()
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'Auth service', kind: 'build_dispatched' })
    expect(posts[0]?.text).toBe(
      '⑂ Build dispatched · Example Project: "Auth service" — running autonomously; the result will post here when it lands.',
    )
  })

  test('inline_started text', () => {
    const { ack, posts } = harness()
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'Tidy the README', kind: 'inline_started' })
    expect(posts[0]?.text).toBe(
      '› Started "Tidy the README" · Example Project — I\'ll post here when it\'s done.',
    )
  })

  test('title longer than 96 chars truncates to 95 + ellipsis', () => {
    const { ack, posts } = harness()
    const long = 'x'.repeat(200)
    ack.post({ project_id: 'p1', item_id: 'i1', title: long, kind: 'card_added' })
    const expectedTitle = `${'x'.repeat(95)}…`
    expect(expectedTitle.length).toBe(96)
    expect(posts[0]?.text).toBe(`▸ On the Work Board · Example Project: "${expectedTitle}"`)
  })

  test('title exactly 96 chars is NOT truncated', () => {
    const { ack, posts } = harness()
    const title = 'y'.repeat(96)
    ack.post({ project_id: 'p1', item_id: 'i1', title, kind: 'card_added' })
    expect(posts[0]?.text).toBe(`▸ On the Work Board · Example Project: "${title}"`)
  })

  // Argus r2 nit: truncation must land on a code-POINT boundary, never split an
  // astral pair into a lone surrogate. An emoji straddling the 95/96 cut must be
  // dropped whole, not halved into mojibake.
  test('truncation of an astral-heavy title yields no lone surrogate', () => {
    const { ack, posts } = harness()
    // 100 astral chars (each is a surrogate pair) — over MAX_TITLE_LEN (96) by code
    // points; a naive UTF-16 slice at unit index 95 would cut mid-pair.
    const title = '😀'.repeat(100)
    ack.post({ project_id: 'p1', item_id: 'i1', title, kind: 'card_added' })
    const text = posts[0]!.text
    // No unpaired surrogate survived (each code point round-trips).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false)
    // 95 whole emoji + the ellipsis (MAX_TITLE_LEN - 1 code points, then '…').
    expect(text).toBe(`▸ On the Work Board · Example Project: "${'😀'.repeat(95)}…"`)
  })
})

// #502 — the defect this closes. The owner watched a General pane read "No work
// tracked yet" beside a chat that said `▸ On the Work Board: "…"`. The message was
// TRUE (the item landed on a project board) and unfalsifiable, so it read as a lie.
// Every ack must now name the board it mutated, in the owner's own vocabulary.
describe('boardLabelForProjectId — the ONE board-name mapping', () => {
  test('a real project resolves to its RAIL LABEL, not its id', () => {
    expect(boardLabelForProjectId('p1', RAIL)).toBe('Example Project')
  })

  test('null project_id (the General surface) is "General"', () => {
    expect(boardLabelForProjectId(null, RAIL)).toBe(GENERAL_BOARD_LABEL)
    expect(GENERAL_BOARD_LABEL).toBe('General')
  })

  test('undefined / blank / whitespace project_id is also "General"', () => {
    expect(boardLabelForProjectId(undefined, RAIL)).toBe('General')
    expect(boardLabelForProjectId('', RAIL)).toBe('General')
    expect(boardLabelForProjectId('   ', RAIL)).toBe('General')
  })

  // (b) The STORAGE key collapses General onto the instance slug (store.ts
  // `workBoardScopeKey`). That key is an internal identifier and must never reach
  // the chat — General is answered WITHOUT consulting the rail at all, so even a
  // rail row whose id is the `general` sentinel cannot rename it.
  test('the `general` sentinel id is "General" and never consults the rail', () => {
    const trap: WorkBoardProjectRow[] = [{ id: GENERAL_WORK_BOARD_PROJECT_ID, label: 'owner' }]
    expect(boardLabelForProjectId(GENERAL_WORK_BOARD_PROJECT_ID, trap)).toBe('General')
  })

  test('General resolves even when the rail is EMPTY (no lookup needed)', () => {
    expect(boardLabelForProjectId(null, [])).toBe('General')
  })

  // (c) A project_id that no longer resolves must NOT fall back to the raw id.
  test('an unresolvable project_id degrades to a word, never the id', () => {
    const label = boardLabelForProjectId('deleted-project', RAIL)
    expect(label).toBe(UNKNOWN_BOARD_LABEL)
    expect(label).not.toContain('deleted-project')
  })

  test('a project whose name is blank also degrades to the word', () => {
    expect(boardLabelForProjectId('p9', [{ id: 'p9', label: '   ' }])).toBe(UNKNOWN_BOARD_LABEL)
  })

  test('a surrounding-whitespace project name is trimmed', () => {
    expect(boardLabelForProjectId('p9', [{ id: 'p9', label: '  Example Project  ' }])).toBe(
      'Example Project',
    )
  })

  test('a pathologically long project name is capped at 48 code points', () => {
    const label = boardLabelForProjectId('p9', [{ id: 'p9', label: 'z'.repeat(200) }])
    expect(label).toBe(`${'z'.repeat(47)}…`)
    expect(Array.from(label).length).toBe(48)
  })
})

describe('buildWorkBoardChatAck — every text names its board', () => {
  test('a General-scoped add says "General", NOT a slug or an id', () => {
    const { ack, posts } = harness()
    ack.post({ project_id: null, item_id: 'i1', title: 'Call the plumber', kind: 'card_added' })
    expect(posts[0]?.text).toBe('▸ On the Work Board · General: "Call the plumber"')
  })

  test('all three kinds carry the board name', () => {
    const { ack, posts } = harness()
    const kinds: WorkBoardChatAckKind[] = ['card_added', 'build_dispatched', 'inline_started']
    kinds.forEach((kind, idx) => {
      ack.post({ project_id: 'p1', item_id: `i${idx}`, title: 'Thing', kind })
    })
    expect(posts.length).toBe(3)
    for (const p of posts) expect(p.text).toContain('Example Project')
  })

  test('two adds on DIFFERENT boards read differently', () => {
    const { ack, posts } = harness()
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'Same title', kind: 'card_added' })
    ack.post({ project_id: null, item_id: 'i2', title: 'Same title', kind: 'card_added' })
    expect(posts[0]?.text).not.toBe(posts[1]?.text)
    expect(posts[0]?.text).toContain('Example Project')
    expect(posts[1]?.text).toContain('General')
  })

  test('an unresolvable project never leaks the id into the chat', () => {
    const { ack, posts } = harness()
    ack.post({ project_id: 'ghost-id', item_id: 'i1', title: 'Thing', kind: 'card_added' })
    expect(posts[0]?.text).toBe(`▸ On the Work Board · ${UNKNOWN_BOARD_LABEL}: "Thing"`)
    expect(posts[0]?.text).not.toContain('ghost-id')
  })

  // A project-store read failure must degrade the LABEL and still DELIVER — an ack
  // swallowed for want of a name is the silent chat the ack exists to prevent.
  test('a THROWING projects reader still delivers (General stays "General")', () => {
    const { ack, posts } = harness({
      projects: () => {
        throw new Error('project store down')
      },
    })
    ack.post({ project_id: null, item_id: 'i1', title: 'Thing', kind: 'card_added' })
    ack.post({ project_id: 'p1', item_id: 'i2', title: 'Thing', kind: 'card_added' })
    expect(posts.length).toBe(2)
    expect(posts[0]?.text).toContain('· General:')
    expect(posts[1]?.text).toContain(`· ${UNKNOWN_BOARD_LABEL}:`)
  })

  test('the rail is read FRESH per ack (a mid-session rename is picked up)', () => {
    let label = 'Old Name'
    const { ack, posts } = harness({ projects: () => [{ id: 'p1', label }] })
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'A', kind: 'card_added' })
    label = 'New Name'
    ack.post({ project_id: 'p1', item_id: 'i2', title: 'B', kind: 'card_added' })
    expect(posts[0]?.text).toContain('Old Name')
    expect(posts[1]?.text).toContain('New Name')
  })
})

describe('buildWorkBoardChatAck — chat-id resolution', () => {
  test('resolver receives the project_id', () => {
    const { ack, posts, resolvedWith } = harness()
    ack.post({ project_id: 'proj-x', item_id: 'i1', title: 't', kind: 'card_added' })
    expect(resolvedWith).toEqual(['proj-x'])
    expect(posts[0]?.chat_id).toBe('chat:proj-x')
  })

  test('null project_id still calls the resolver (General surface)', () => {
    const { ack, posts, resolvedWith } = harness()
    ack.post({ project_id: null, item_id: 'i1', title: 't', kind: 'card_added' })
    expect(resolvedWith).toEqual([null])
    expect(posts[0]?.chat_id).toBe('chat:general')
  })
})

describe('buildWorkBoardChatAck — dedup', () => {
  test('same (item, kind) within window is suppressed', () => {
    let t = 1_000
    const { ack, posts } = harness({ now: () => t })
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' })
    t += 5_000
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' })
    expect(posts.length).toBe(1)
  })

  test('different kind for the same item is NOT suppressed', () => {
    let t = 1_000
    const { ack, posts } = harness({ now: () => t })
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' })
    t += 100
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'build_dispatched' })
    expect(posts.length).toBe(2)
    const kinds = posts.map((p) => p.text.slice(0, 1))
    expect(kinds).toEqual(['▸', '⑂'])
  })

  test('same kind for a DIFFERENT item is NOT suppressed', () => {
    let t = 1_000
    const { ack, posts } = harness({ now: () => t })
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'a', kind: 'card_added' })
    t += 100
    ack.post({ project_id: 'p1', item_id: 'i2', title: 'b', kind: 'card_added' })
    expect(posts.length).toBe(2)
  })

  test('after the window elapses the same (item, kind) reposts', () => {
    let t = 1_000
    const { ack, posts } = harness({ now: () => t })
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' })
    t += 30_000 // == default window; boundary reposts
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' })
    expect(posts.length).toBe(2)
  })

  test('custom dedup window is honoured', () => {
    let t = 0
    const { ack, posts } = harness({ now: () => t, dedup_window_ms: 1_000 })
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' })
    t += 500
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' }) // suppressed
    t += 600 // now 1100 total → past 1000ms window from first
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' })
    expect(posts.length).toBe(2)
  })

  // Argus r2 finding — UNBOUND dispatches (no board item → item_id='') must not
  // collapse to one dedup identity. Before the fix, key = `${item_id}\0${kind}`
  // meant every unbound build within the window shared `\0build_dispatched`, so
  // the second distinct build's ack was silently swallowed.
  test('two UNBOUND dispatches (item_id="") with DIFFERENT titles both post', () => {
    let t = 1_000
    const { ack, posts } = harness({ now: () => t })
    ack.post({ project_id: 'p1', item_id: '', title: 'Build auth service', kind: 'build_dispatched' })
    t += 5_000 // still well within the 30s window
    ack.post({ project_id: 'p1', item_id: '', title: 'Build billing worker', kind: 'build_dispatched' })
    expect(posts.length).toBe(2)
  })

  test('same UNBOUND dispatch (item_id="", same title) within window is still deduped', () => {
    let t = 1_000
    const { ack, posts } = harness({ now: () => t })
    ack.post({ project_id: 'p1', item_id: '', title: 'Build auth service', kind: 'build_dispatched' })
    t += 5_000
    ack.post({ project_id: 'p1', item_id: '', title: 'Build auth service', kind: 'build_dispatched' })
    expect(posts.length).toBe(1)
  })

  test('same empty-item event in DIFFERENT projects is NOT suppressed (project_id in key)', () => {
    let t = 1_000
    const { ack, posts } = harness({ now: () => t })
    ack.post({ project_id: 'p1', item_id: '', title: 'Build X', kind: 'build_dispatched' })
    t += 100
    ack.post({ project_id: 'p2', item_id: '', title: 'Build X', kind: 'build_dispatched' })
    expect(posts.length).toBe(2)
  })
})

describe('buildWorkBoardChatAck — never throws', () => {
  test('a throwing post is swallowed and post() returns normally', () => {
    const ack = buildWorkBoardChatAck({
      resolve_chat_id: () => 'chat:p1',
      projects: () => RAIL,
      post: () => {
        throw new Error('transport down')
      },
    })
    expect(() =>
      ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' }),
    ).not.toThrow()
  })

  test('a throwing resolver is swallowed', () => {
    const ack = buildWorkBoardChatAck({
      resolve_chat_id: () => {
        throw new Error('resolver blew up')
      },
      projects: () => RAIL,
      post: () => {},
    })
    expect(() =>
      ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' }),
    ).not.toThrow()
  })

  // Argus r2 major: the dedup stamp must be recorded AFTER a successful post, not
  // before. A failed delivery must NOT mute the (item, kind) for the whole window —
  // a retry within the window must be allowed to land once transport recovers.
  test('a failed post does not set the dedup stamp; a retry within the window re-delivers', () => {
    let t = 1_000
    const posts: string[] = []
    let transportUp = false
    const ack = buildWorkBoardChatAck({
      now: () => t,
      resolve_chat_id: () => 'chat:p1',
      projects: () => RAIL,
      post: (_chat_id, text) => {
        if (!transportUp) throw new Error('transport down')
        posts.push(text)
      },
    })
    // First fire: transport is down → throws, swallowed, nothing delivered.
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'Deploy', kind: 'build_dispatched' })
    expect(posts.length).toBe(0)
    // Retry 5s later (well within the 30s window) once transport recovers — it must
    // NOT be suppressed, because the failed attempt left no dedup stamp.
    t += 5_000
    transportUp = true
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'Deploy', kind: 'build_dispatched' })
    expect(posts.length).toBe(1)
    // And NOW the successful delivery does dedup a further in-window fire.
    t += 1_000
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'Deploy', kind: 'build_dispatched' })
    expect(posts.length).toBe(1)
  })

  test('a failed resolve also leaves no dedup stamp (retry re-attempts)', () => {
    let t = 0
    let resolveUp = false
    const resolvedCount: number[] = []
    const ack = buildWorkBoardChatAck({
      now: () => t,
      resolve_chat_id: () => {
        resolvedCount.push(1)
        if (!resolveUp) throw new Error('resolver down')
        return 'chat:p1'
      },
      projects: () => RAIL,
      post: () => {},
    })
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' })
    t += 2_000
    resolveUp = true
    ack.post({ project_id: 'p1', item_id: 'i1', title: 't', kind: 'card_added' })
    // Resolver was invoked BOTH times — the first failure did not mute the second.
    expect(resolvedCount.length).toBe(2)
  })

  test('all three kinds are exhaustively covered', () => {
    const { ack, posts } = harness()
    const kinds: WorkBoardChatAckKind[] = ['card_added', 'build_dispatched', 'inline_started']
    kinds.forEach((kind, idx) => {
      ack.post({ project_id: 'p1', item_id: `i${idx}`, title: 't', kind })
    })
    expect(posts.length).toBe(3)
  })
})
