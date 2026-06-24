/**
 * WAVE 3 (Calendar Core completion) — the `/cal` chat-command filter is
 * surfaced through `boot-helpers.ts` + the gateway entry barrel alongside
 * its sibling Cores, so the production composer chains it into
 * `buildChainedChatCommandFilter([...])` exactly like `/remind` and
 * `/code`. Mirrors `trident-code-command-wiring.test.ts`.
 *
 * Proves:
 *   1. `buildCalendarChatCommandFilter` is reachable from BOTH
 *      `../boot-helpers.ts` (the non-entry module the Managed composer
 *      imports) AND the `../index.ts` barrel — the parity asymmetry this
 *      sprint closed.
 *   2. The filter claims `/cal` commands (non-null) and dispatches CRUD
 *      against the supplied `CalendarClient` (agent-native chat parity).
 *   3. Non-`/cal` bodies and unrecognized `/cal` subcommands fall through
 *      (return null) so the LLM path still owns them.
 *   4. It composes inside `buildChainedChatCommandFilter`.
 */

import { describe, expect, test } from 'bun:test'
import { buildInMemoryCalendarClient } from '@neutronai/calendar-core'
import {
  buildCalendarChatCommandFilter,
  buildChainedChatCommandFilter,
} from '../boot-helpers.ts'
// Barrel reachability — the production composer imports filter builders
// from the gateway entry barrel; assert `/cal` is reachable there too.
import { buildCalendarChatCommandFilter as fromBarrel } from '../index.ts'

const NOW = (): Date => new Date('2026-06-24T17:00:00Z')

const matchInput = (body: string): {
  user_id: string
  project_slug: string
  channel_topic_id: string
  project_id: string
  body: string
} => ({
  user_id: 'u1',
  project_slug: 'proj-1',
  channel_topic_id: 'topic-1',
  project_id: 'proj-1',
  body,
})

function buildFilter(): import('../http/app-ws-surface.ts').ChatCommandFilter {
  return buildCalendarChatCommandFilter({
    client: buildInMemoryCalendarClient(),
    cacheFor: async () => null,
    now: NOW,
  })
}

describe('buildCalendarChatCommandFilter', () => {
  test('is reachable from the gateway barrel (parity with /remind, /code)', () => {
    expect(fromBarrel).toBe(buildCalendarChatCommandFilter)
  })

  test('/cal show claims the command (non-null result)', async () => {
    const res = await buildFilter().match(matchInput('/cal show today'))
    expect(res).not.toBeNull()
    expect(typeof res!.text).toBe('string')
  })

  test('/cal create dispatches CRUD against the calendar client', async () => {
    const client = buildInMemoryCalendarClient()
    const filter = buildCalendarChatCommandFilter({
      client,
      cacheFor: async () => null,
      now: NOW,
    })
    const res = await filter.match(
      matchInput('/cal create Standup @ tomorrow 09:00 for 30m with user@example.com'),
    )
    expect(res).not.toBeNull()
    // The created event is now listable via the SAME client — proves the
    // chat command reached the backend, not just the parser.
    const events = await client.list({
      range_start: '2026-06-20T00:00:00Z',
      range_end: '2026-07-01T00:00:00Z',
    })
    expect(events.some((e) => e.title === 'Standup')).toBe(true)
  })

  test('non-/cal body falls through (returns null)', async () => {
    expect(await buildFilter().match(matchInput('what is on my calendar'))).toBeNull()
  })

  test('unrecognized /cal subcommand falls through (returns null)', async () => {
    expect(await buildFilter().match(matchInput('/cal wat'))).toBeNull()
  })

  test('composes into buildChainedChatCommandFilter — /cal is claimed', async () => {
    const passthrough: import('../http/app-ws-surface.ts').ChatCommandFilter = {
      match: async () => null,
    }
    const chained = buildChainedChatCommandFilter([passthrough, buildFilter()])
    const res = await chained.match(matchInput('/cal show today'))
    expect(res).not.toBeNull()
  })
})
