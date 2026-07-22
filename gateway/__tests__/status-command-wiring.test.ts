/**
 * M2 task 3 — the `/status` narrow Neutron chat command.
 *
 * Proves `buildStatusChatCommandFilter`:
 *   - claims `/status` (exact-command word boundary) and returns a formatted
 *     snapshot composed from the INJECTED snapshot thunk (behavior, not a
 *     `toHaveBeenCalled` gap-test — the reply TEXT must carry the snapshot values);
 *   - threads the turn's `project_id` into the snapshot thunk;
 *   - falls through (`null`) on `/statusfoo` and on any non-command, so the LLM
 *     path still fires for those.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildChainedChatCommandFilter,
  buildStatusChatCommandFilter,
  formatStatusSnapshot,
  type StatusSnapshot,
} from '../boot-helpers.ts'
import type { ChatCommandFilter } from '../http/app-ws-surface.ts'

const matchInput = (body: string, project_id?: string) => ({
  user_id: 'owner',
  project_slug: 'acme',
  channel_topic_id: 'app:owner',
  ...(project_id !== undefined ? { project_id } : {}),
  body,
})

const snap = (over: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  active_project: 'General',
  model: 'claude-x',
  pending_reminders: 0,
  active_work_items: 0,
  active_trident_runs: 0,
  ...over,
})

describe('buildStatusChatCommandFilter', () => {
  test('/status returns a formatted snapshot whose TEXT carries every field value', async () => {
    const filter = buildStatusChatCommandFilter({
      snapshot: async () =>
        snap({
          active_project: 'Alpha',
          model: 'claude-sonnet-9',
          pending_reminders: 3,
          active_work_items: 2,
          active_trident_runs: 1,
        }),
    })
    const res = await filter.match(matchInput('/status'))
    expect(res).not.toBeNull()
    // Real behavior: the reply body reflects the snapshot, not just that a fn ran.
    expect(res!.text).toContain('Alpha')
    expect(res!.text).toContain('claude-sonnet-9')
    expect(res!.text).toContain('Pending reminders: 3')
    expect(res!.text).toContain('Active work items: 2')
    expect(res!.text).toContain('Active builds: 1')
    // The structured snapshot rides `data` for a client that wants to render it.
    expect(res!.data).toEqual(
      snap({
        active_project: 'Alpha',
        model: 'claude-sonnet-9',
        pending_reminders: 3,
        active_work_items: 2,
        active_trident_runs: 1,
      }),
    )
  })

  test('threads the turn project_id into the snapshot thunk', async () => {
    let seen: string | undefined = 'UNSET'
    const filter = buildStatusChatCommandFilter({
      snapshot: async (i) => {
        seen = i.project_id
        return snap()
      },
    })
    await filter.match(matchInput('/status', 'proj-42'))
    expect(seen).toBe('proj-42')
  })

  test('omits project_id when the turn has none (General)', async () => {
    let hadKey = true
    const filter = buildStatusChatCommandFilter({
      snapshot: async (i) => {
        hadKey = 'project_id' in i
        return snap()
      },
    })
    await filter.match(matchInput('/status'))
    expect(hadKey).toBe(false)
  })

  test('tolerates leading whitespace and trailing args', async () => {
    let calls = 0
    const filter = buildStatusChatCommandFilter({
      snapshot: async () => {
        calls++
        return snap()
      },
    })
    expect(await filter.match(matchInput('  /status'))).not.toBeNull()
    expect(await filter.match(matchInput('/status right now please'))).not.toBeNull()
    expect(calls).toBe(2)
  })

  test('/statusfoo falls through (word-boundary) — NOT claimed', async () => {
    let called = false
    const filter = buildStatusChatCommandFilter({
      snapshot: async () => {
        called = true
        return snap()
      },
    })
    expect(await filter.match(matchInput('/statusfoo'))).toBeNull()
    expect(await filter.match(matchInput('/statuses'))).toBeNull()
    // The snapshot thunk must NEVER run for a non-command (no wasted store read).
    expect(called).toBe(false)
  })

  test('a non-command inbound falls through to null', async () => {
    const filter = buildStatusChatCommandFilter({ snapshot: async () => snap() })
    expect(await filter.match(matchInput('what is my status?'))).toBeNull()
    expect(await filter.match(matchInput('/remind me tomorrow'))).toBeNull()
  })
})

describe('/status chained after other filters (the composer wiring shape)', () => {
  // Mirrors `open/composer.ts`: the status filter is the LAST link in
  // `buildChainedChatCommandFilter([...cores, skillForge, status])`. Prove a
  // `/status` inbound falls THROUGH the earlier links (which disclaim with null)
  // and is claimed by the status filter, and that a non-`/status` inbound is not.
  const passthrough: ChatCommandFilter = { match: async () => null }

  test('an inbound the earlier filters disclaim reaches /status', async () => {
    const chain = buildChainedChatCommandFilter([
      passthrough,
      passthrough,
      buildStatusChatCommandFilter({ snapshot: async () => snap({ active_project: 'Gamma' }) }),
    ])
    const res = await chain.match(matchInput('/status'))
    expect(res).not.toBeNull()
    expect(res!.text).toContain('Gamma')
  })

  test('a non-command inbound falls through the whole chain to null', async () => {
    const chain = buildChainedChatCommandFilter([
      passthrough,
      buildStatusChatCommandFilter({ snapshot: async () => snap() }),
    ])
    expect(await chain.match(matchInput('just chatting'))).toBeNull()
  })
})

describe('formatStatusSnapshot', () => {
  test('renders each field on its own bullet line under a header', () => {
    const text = formatStatusSnapshot(
      snap({
        active_project: 'Beta',
        model: 'm1',
        pending_reminders: 5,
        active_work_items: 4,
        active_trident_runs: 2,
      }),
    )
    const lines = text.split('\n')
    expect(lines[0]).toBe('**Status**')
    expect(lines).toContain('• Project: Beta')
    expect(lines).toContain('• Model: m1')
    expect(lines).toContain('• Pending reminders: 5')
    expect(lines).toContain('• Active work items: 4')
    expect(lines).toContain('• Active builds: 2')
  })
})
