/**
 * ISSUES #399 — the app-ws topic a socket binds to.
 *
 * There was NO coverage of this choice at all, which is how a
 * `platform === 'web'` gate sat in front of it: native silently bound the
 * user-scoped topic, received General's transcript, and never got its
 * per-project history. Nothing failed, because nothing asserted it.
 *
 * The invariant is platform-independent by design — see
 * `resolveChannelTopicId`.
 */
import { describe, expect, it } from 'bun:test'

import { resolveChannelTopicId } from '../app-ws-surface.ts'

describe('resolveChannelTopicId — per-project scoping (#399)', () => {
  it('no project_id ⇒ the user-scoped General topic', () => {
    expect(resolveChannelTopicId('owner', null)).toBe('app:owner')
  })

  it('a project_id ⇒ that project’s own topic', () => {
    expect(resolveChannelTopicId('owner', 'willow')).toBe('app:owner:willow')
  })

  it('two projects never collide, and neither is General', () => {
    const willow = resolveChannelTopicId('owner', 'willow')
    const tabs = resolveChannelTopicId('owner', 'tabs')
    expect(willow).not.toBe(tabs)
    expect(willow).not.toBe(resolveChannelTopicId('owner', null))
  })

  it('an empty project_id is treated as General, not as a topic suffix', () => {
    // Guards `app:owner:` — a key that belongs to no project and would strand
    // whatever landed in it.
    expect(resolveChannelTopicId('owner', '')).toBe('app:owner')
  })

  it('the scoping does NOT depend on the client platform', () => {
    // The regression that was #399: this function takes no platform argument,
    // so native and web cannot diverge. Asserted structurally rather than by
    // simulating an upgrade, because the gate lived in exactly this expression.
    expect(resolveChannelTopicId.length).toBe(2)
    expect(resolveChannelTopicId('owner', 'willow')).toBe('app:owner:willow')
  })
})
