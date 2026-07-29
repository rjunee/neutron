/**
 * Unit tests for {@link parseAnyTopicId} — the shared `channel_topic_id`
 * parser used by the upload handler (and any future caller that needs
 * to derive `(kind, user_id)` from an inbound topic_id string).
 *
 * Argus r1 BLOCKER #1 (PR #258): the upload handler previously only
 * handled `app:<user_id>` via `parseAppWsTopicId`. Production web
 * clients send `web:<sub>` (landing/chat.ts:1313); the handler dropped
 * those into the empty-string user_id fallback and the engine state
 * lookup returned `noop_no_state`, leaving the user stuck in
 * `import_upload_pending` after a 200 OK.
 */

import { describe, expect, test } from 'bun:test'

import { parseAnyTopicId } from '../topic-id.ts'

describe('parseAnyTopicId', () => {
  test('parses app:<user_id> shape (AppWs / Expo)', () => {
    expect(parseAnyTopicId('app:user-1')).toEqual({ kind: 'app', user_id: 'user-1' })
    expect(parseAnyTopicId('app:0000-0000-0000-0000')).toEqual({
      kind: 'app',
      user_id: '0000-0000-0000-0000',
    })
  })

  test('parses web:<user_id> shape (landing/chat.ts)', () => {
    // This is the regression case Argus r1 BLOCKER #1 pinned. The
    // production web chat client always sends `web:<sub>` — pre-fix the
    // handler returned null for this shape and user_id fell back to ''.
    expect(parseAnyTopicId('web:user-1')).toEqual({ kind: 'web', user_id: 'user-1' })
    expect(parseAnyTopicId('web:abc.123-XYZ_')).toEqual({
      kind: 'web',
      user_id: 'abc.123-XYZ_',
    })
  })

  test('recognises bare numeric Telegram shapes', () => {
    expect(parseAnyTopicId('123456')).toEqual({ kind: 'tg' })
    expect(parseAnyTopicId('123456:42')).toEqual({ kind: 'tg' })
  })

  test('recognises explicit tg: prefix shape (engine routing convention)', () => {
    expect(parseAnyTopicId('tg:123456')).toEqual({ kind: 'tg' })
    expect(parseAnyTopicId('tg:123456:42')).toEqual({ kind: 'tg' })
  })

  test('returns null for empty / malformed / legacy placeholder', () => {
    expect(parseAnyTopicId('')).toBeNull()
    expect(parseAnyTopicId('app:')).toBeNull()
    expect(parseAnyTopicId('web:')).toBeNull()
    expect(parseAnyTopicId('tg:')).toBeNull()
    // The pre-S11 hardcoded placeholder `'chat'` is intentionally
    // unrecognised so the upload handler keeps falling back to the
    // engine's legacy empty-user_id lookup for any caller that hasn't
    // wired the header yet.
    expect(parseAnyTopicId('chat')).toBeNull()
    // Random / unknown prefixes — null so callers can branch on
    // "couldn't derive a user_id".
    expect(parseAnyTopicId('weird:abc')).toBeNull()
  })

  test('rejects non-string inputs defensively', () => {
    // Type assertions: real callers pass strings, but the parser is at
    // a process boundary (HTTP header) so the runtime guard matters.
    expect(parseAnyTopicId(null as unknown as string)).toBeNull()
    expect(parseAnyTopicId(undefined as unknown as string)).toBeNull()
    expect(parseAnyTopicId(123 as unknown as string)).toBeNull()
  })
})
