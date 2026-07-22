import { describe, expect, test } from 'bun:test'
import { buildWorkBoardChatAck, type WorkBoardChatAckKind } from './chat-ack.ts'

interface Posted {
  chat_id: string
  text: string
}

function harness(opts?: { now?: () => number; dedup_window_ms?: number }) {
  const posts: Posted[] = []
  const resolvedWith: Array<string | null> = []
  const ack = buildWorkBoardChatAck({
    resolve_chat_id: (project_id) => {
      resolvedWith.push(project_id)
      return project_id === null ? 'chat:general' : `chat:${project_id}`
    },
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
    expect(posts).toEqual([{ chat_id: 'chat:p1', text: '▸ On the Work Board: "Ship the landing page"' }])
  })

  test('build_dispatched text', () => {
    const { ack, posts } = harness()
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'Auth service', kind: 'build_dispatched' })
    expect(posts[0]?.text).toBe(
      '⑂ Build dispatched: "Auth service" — running autonomously; the result will post here when it lands.',
    )
  })

  test('inline_started text', () => {
    const { ack, posts } = harness()
    ack.post({ project_id: 'p1', item_id: 'i1', title: 'Tidy the README', kind: 'inline_started' })
    expect(posts[0]?.text).toBe('› Working on "Tidy the README" now — I\'ll post here when it\'s done.')
  })

  test('title longer than 96 chars truncates to 95 + ellipsis', () => {
    const { ack, posts } = harness()
    const long = 'x'.repeat(200)
    ack.post({ project_id: 'p1', item_id: 'i1', title: long, kind: 'card_added' })
    const expectedTitle = `${'x'.repeat(95)}…`
    expect(expectedTitle.length).toBe(96)
    expect(posts[0]?.text).toBe(`▸ On the Work Board: "${expectedTitle}"`)
  })

  test('title exactly 96 chars is NOT truncated', () => {
    const { ack, posts } = harness()
    const title = 'y'.repeat(96)
    ack.post({ project_id: 'p1', item_id: 'i1', title, kind: 'card_added' })
    expect(posts[0]?.text).toBe(`▸ On the Work Board: "${title}"`)
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
    expect(text).toBe(`▸ On the Work Board: "${'😀'.repeat(95)}…"`)
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
})

describe('buildWorkBoardChatAck — never throws', () => {
  test('a throwing post is swallowed and post() returns normally', () => {
    const ack = buildWorkBoardChatAck({
      resolve_chat_id: () => 'chat:p1',
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
