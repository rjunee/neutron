/**
 * The composer's push sink is PRESENCE-AWARE — asserted on the composition, not
 * on the two modules it composes.
 *
 * `gateway/push/web-presence.test.ts` proves the wrapper suppresses when its
 * predicate says so. `gateway/push/chat-message-push.test.ts` proves the sink
 * pushes. Neither proves that the composer actually puts one around the other,
 * or that the predicate it supplies asks about the MESSAGE rather than about the
 * owner in general. Those are the two claims that were unreachable while this
 * composition was six inline lines in a 6000-line file, and they are the two
 * claims whose failure mode is a phone that quietly stops notifying.
 *
 * So each test here drives the built sink and reads the fan-out. Remove the
 * wrapper and the first suite reds; drop `msg.project_id` from the predicate and
 * the second does.
 */

import { describe, expect, it } from 'bun:test'

import type { ChatMessagePushInput } from '@neutronai/gateway/push/chat-message-push.ts'
import { createWebPresenceTracker } from '@neutronai/gateway/push/web-presence.ts'
import { buildPresenceAwareChatPushSink } from '../chat-push-sink.ts'

const OWNER = 'owner-1'
const SLUG = 'workspace'

/**
 * Records every Expo fan-out the sink actually performs, and reports ONE real
 * delivery.
 *
 * `delivered: 1` is load-bearing rather than arbitrary: the underlying sink fails
 * closed on any result that does not report a count ≥ 1, so a lazier double would
 * make every test below read `false` and the suppression assertions would pass
 * for the wrong reason.
 */
function recordingFanOut(): {
  fanOut: Parameters<typeof buildPresenceAwareChatPushSink>[0]['fanOut']
  pushed: string[]
} {
  const pushed: string[] = []
  return {
    pushed,
    fanOut: {
      pushAll: async (_slug: string, message: { body: string }) => {
        pushed.push(message.body)
        return { ok: true, delivered: 1 }
      },
    },
  }
}

function msg(project_id: string | null, body = 'hello'): ChatMessagePushInput {
  return { project_id, message_id: `m-${body}`, body }
}

describe('buildPresenceAwareChatPushSink', () => {
  it('CONTROL: with nothing declared, the push goes out', async () => {
    // Without this the suppression assertions below would pass equally against a
    // fan-out that never pushes anything at all.
    const fo = recordingFanOut()
    const sink = buildPresenceAwareChatPushSink({
      fanOut: fo.fanOut,
      project_slug: SLUG,
      presence: createWebPresenceTracker(),
      owner_user_id: OWNER,
    })
    expect(await sink(msg(null))).toBe(true)
    expect(fo.pushed).toHaveLength(1)
  })

  it('the presence check IS wrapped around the sink — a foregrounded tab suppresses', async () => {
    const fo = recordingFanOut()
    const presence = createWebPresenceTracker()
    const sink = buildPresenceAwareChatPushSink({
      fanOut: fo.fanOut,
      project_slug: SLUG,
      presence,
      owner_user_id: OWNER,
    })
    presence.foreground(OWNER, 'conn-1', null)
    expect(await sink(msg(null))).toBe(false)
    expect(fo.pushed).toHaveLength(0)
  })

  it('the question is asked PER CONVERSATION — another project still notifies', async () => {
    // The global-suppression regression, pinned at the composition layer: with a
    // predicate that ignored its argument, one open tab silenced every other chat.
    const fo = recordingFanOut()
    const presence = createWebPresenceTracker()
    const sink = buildPresenceAwareChatPushSink({
      fanOut: fo.fanOut,
      project_slug: SLUG,
      presence,
      owner_user_id: OWNER,
    })
    presence.foreground(OWNER, 'conn-a', 'proj-a')

    expect(await sink(msg('proj-a', 'reading-this'))).toBe(false) // control: it can suppress
    expect(await sink(msg('proj-b', 'other-project'))).toBe(true)
    expect(await sink(msg(null, 'general'))).toBe(true)
    expect(fo.pushed).toEqual(['other-project', 'general'])
  })

  it('the presence question is asked about THE OWNER, not about anyone with a tab open', async () => {
    const fo = recordingFanOut()
    const presence = createWebPresenceTracker()
    const sink = buildPresenceAwareChatPushSink({
      fanOut: fo.fanOut,
      project_slug: SLUG,
      presence,
      owner_user_id: OWNER,
    })
    presence.foreground('some-guest', 'conn-guest', null)
    expect(await sink(msg(null))).toBe(true)
    expect(fo.pushed).toHaveLength(1)

    // Control: the same tracker DOES suppress for the owner, so the assertion
    // above is about the identity and not about a tracker that records nothing.
    presence.foreground(OWNER, 'conn-owner', null)
    expect(await sink(msg(null))).toBe(false)
  })
})
