/**
 * A VOICE NOTE'S WORDS SURVIVE THE DEVICE.
 *
 * THE GAP THIS CLOSES, AND HOW IT WAS FOUND. The first half of this fix returned the
 * transcript on the upload response so the uploading device could index it locally.
 * That was shipped on the belief that a user's own messages are not persisted
 * server-side — and that belief was FALSE. They are: `app_chat_messages` holds user
 * rows, and `replayAfter` is how a reconnecting or freshly-installed device rebuilds
 * its history from them.
 *
 * So the fix worked only on the phone that happened to perform the upload. On a new
 * device, after a reinstall, or after a local database is cleared, the voice notes came
 * back with their audio and none of their words — unsearchable again, permanently, and
 * with nothing to indicate anything was missing.
 *
 * WHY THE SERVER RESOLVES THE TRANSCRIPT RATHER THAN ACCEPTING IT FROM THE CLIENT. The
 * text already exists on this machine — written to a content-addressed sidecar beside
 * the audio at upload time. Asking the client to send it back would be a round trip of
 * data we already hold, and it would let any client write arbitrary text into a field
 * that is indexed and read by the agent. The client's copy exists only for its own
 * local index; this one is the record.
 */

import { describe, expect, it } from 'bun:test'

import type { AppChatRow } from '@neutronai/persistence/index.ts'

import { AppWsAdapter, appChatRowToEnvelope } from '../adapter.ts'
import type { AppWsOutbound, AppWsOutboundUserMessageEcho } from '../envelope.ts'

/** A socket registry that records nothing — these tests assert on the STORE. */
function makeRegistry() {
  const sinks = new Map<string, (e: AppWsOutbound) => void>()
  return {
    register: (topic: string, sink: (e: AppWsOutbound) => void) => sinks.set(topic, sink),
    send: (topic: string, e: AppWsOutbound) => {
      sinks.get(topic)?.(e)
      return true
    },
  } as never
}

function userRow(over: Partial<AppChatRow> = {}): AppChatRow {
  return {
    topic_id: 'app:owner',
    seq: 7,
    message_id: 'm-voice',
    role: 'user',
    body: '',
    client_msg_id: 'c-voice',
    project_id: null,
    attachments: ['/api/app/upload/owner/abc123.m4a'],
    meta: null,
    transcript: 'renegotiate the warehouse lease before the quarter ends',
    created_at: 1000,
    ...over,
  }
}

const replay = (row: AppChatRow): AppWsOutboundUserMessageEcho =>
  appChatRowToEnvelope(row) as AppWsOutboundUserMessageEcho

describe('replay carries the transcript — the half that survives a reinstall', () => {
  it('puts the stored transcript on the replayed user_message envelope', () => {
    const env = replay(userRow())
    expect(env.type).toBe('user_message')
    expect(env.transcript).toBe('renegotiate the warehouse lease before the quarter ends')
  })

  it('still carries the audio alongside it', () => {
    // The words are additional to the attachment, never a replacement — the bubble
    // still has to render a player.
    const env = replay(userRow())
    expect(env.attachments).toEqual(['/api/app/upload/owner/abc123.m4a'])
  })

  it('OMITS the field for an ordinary typed message', () => {
    // Not `transcript: null`. Every non-audio message would otherwise gain a field
    // that every client has to reason about, for nothing.
    const env = replay(userRow({ body: 'typed', attachments: null, transcript: null }))
    expect('transcript' in env).toBe(false)
  })

  it('OMITS an empty transcript rather than sending an empty string', () => {
    // The ASR genuinely returns nothing for silence, and `''` downstream is
    // indistinguishable from "transcribed to nothing" — so absence is the honest
    // encoding of both.
    const env = replay(userRow({ transcript: '' }))
    expect('transcript' in env).toBe(false)
  })

  it('leaves the agent-message envelope untouched', () => {
    // The control. Agent messages have no audio, and a change to the shared row
    // decoder is exactly where an unrelated envelope grows a stray field.
    const env = appChatRowToEnvelope(
      userRow({ role: 'agent', body: 'hi', attachments: null, transcript: null }),
    ) as unknown as Record<string, unknown>
    expect(env['type']).toBe('agent_message')
    expect('transcript' in env).toBe(false)
  })
})

describe('the server RESOLVES the transcript itself — it never trusts the client', () => {
  /**
   * A minimal chat log that records exactly what the adapter tried to persist.
   *
   * This is the "is it wired" half, and it is the half this repo keeps losing: a
   * module can be correct, tested, and never invoked. Mutating the resolver call to
   * `null` left every other test in this file green.
   */
  function recordingAdapter(transcriptFor: (url: string) => string | null) {
    const appended: Array<Record<string, unknown>> = []
    const adapter = new AppWsAdapter({
      registry: makeRegistry(),
      receiver: { receive: async () => {} },
      now: () => 1000,
      generate_message_id: () => 'msg-1',
      chat_log: {
        append: async (input: Record<string, unknown>) => {
          appended.push(input)
          return {
            row: { ...(userRow() as unknown as Record<string, unknown>), ...input } as never,
            was_new: true,
          }
        },
        replayAfter: async () => [],
        maxSeq: async () => 0,
        markPromptChosen: async () => null,
      } as never,
      attachment_transcript: transcriptFor,
    })
    return { adapter, appended }
  }

  it('reads the transcript from the sidecar seam and persists it', async () => {
    const { adapter, appended } = recordingAdapter((url) =>
      url.endsWith('.m4a') ? 'the words that were spoken' : null,
    )
    await adapter.ingestUserMessage({
      channel_topic_id: 'app:owner',
      user_id: 'owner',
      body: '',
      attachments: ['/api/app/upload/owner/abc.m4a'],
    })
    expect(appended).toHaveLength(1)
    expect(appended[0]!['transcript']).toBe('the words that were spoken')
  })

  it('persists nothing extra for a message with no attachments', async () => {
    const { adapter, appended } = recordingAdapter(() => 'should not be consulted')
    await adapter.ingestUserMessage({
      channel_topic_id: 'app:owner',
      user_id: 'owner',
      body: 'typed',
    })
    expect('transcript' in appended[0]!).toBe(false)
  })

  it('joins several audio attachments so nothing said is dropped', async () => {
    const { adapter, appended } = recordingAdapter((url) =>
      url.includes('one') ? 'first clip' : 'second clip',
    )
    await adapter.ingestUserMessage({
      channel_topic_id: 'app:owner',
      user_id: 'owner',
      body: '',
      attachments: ['/x/one.m4a', '/x/two.m4a'],
    })
    expect(appended[0]!['transcript']).toBe('first clip\nsecond clip')
  })

  it('a THROWING seam never fails the send', async () => {
    // Losing searchability on one message is a small harm. Losing the message is not.
    const { adapter, appended } = recordingAdapter(() => {
      throw new Error('sidecar unreadable')
    })
    const res = await adapter.ingestUserMessage({
      channel_topic_id: 'app:owner',
      user_id: 'owner',
      body: '',
      attachments: ['/x/one.m4a'],
    })
    expect(res.message_id).toBe('msg-1')
    expect('transcript' in appended[0]!).toBe(false)
  })

  it('with NO seam wired, behaves exactly as before', async () => {
    const appended: Array<Record<string, unknown>> = []
    const adapter = new AppWsAdapter({
      registry: makeRegistry(),
      receiver: { receive: async () => {} },
      now: () => 1000,
      generate_message_id: () => 'msg-1',
      chat_log: {
        append: async (input: Record<string, unknown>) => {
          appended.push(input)
          return { row: { ...(userRow() as unknown as Record<string, unknown>), ...input } as never, was_new: true }
        },
        replayAfter: async () => [],
        maxSeq: async () => 0,
        markPromptChosen: async () => null,
      } as never,
    })
    await adapter.ingestUserMessage({
      channel_topic_id: 'app:owner',
      user_id: 'owner',
      body: '',
      attachments: ['/x/one.m4a'],
    })
    expect('transcript' in appended[0]!).toBe(false)
  })
})

describe('the COMPOSER actually wires the seam', () => {
  it('passes attachmentTranscript into the adapter it constructs', async () => {
    // THE RECURRING DEFECT IN THIS REPO, ASSERTED AGAINST DIRECTLY. Everything above
    // stayed green while the composer handed the adapter no resolver at all — the
    // module correct, its tests passing, and the feature dead in production. That is
    // the exact shape SPEC.md names as the repeat offender.
    //
    // A SOURCE assertion, not a boot: constructing the real wiring needs a database,
    // a socket registry and a live substrate, which is a heavy and flaky way to check
    // one argument. What it must NOT be is a hand-built config literal asserting the
    // adapter honours a resolver it was handed — that is the shape the composition
    // gate exists to catch, because it passes whether or not anything wires it.
    const src = await Bun.file(
      new URL('../../../../open/wiring/app-ws.ts', import.meta.url),
    ).text()
    const code = src
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    // Scoped to the adapter construction, not the whole file: `attachmentTranscript`
    // also appears in the scribe path, and an unscoped match would pass on that
    // alone — the same over-broad-regex mistake this repo has now made twice.
    const ctor = code.slice(code.indexOf('new AppWsAdapter({'))
    const ctorBlock = ctor.slice(0, ctor.indexOf('\n  })'))
    expect(ctorBlock.includes('attachment_transcript: attachmentTranscript')).toBe(true)
  })
})
