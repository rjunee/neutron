/**
 * M2 task 4 — the `/reset` narrow Neutron chat command.
 *
 * Proves `buildResetChatCommandFilter`:
 *   - claims `/reset` (exact-command word boundary) and returns a reply composed
 *     from the INJECTED reset thunk's live outcome (behavior, not a
 *     `toHaveBeenCalled` gap-test — the reply TEXT + `data` carry the outcome);
 *   - threads the turn's `project_id` into the reset thunk (and omits the key when
 *     the turn has none — the General scope);
 *   - falls through (`null`) on `/resetfoo` / `/resets` / any non-command, and the
 *     injected reset thunk is NEVER invoked for those (word-boundary-never-resets);
 *   - maps each outcome variant to the right reply text + `error` shape
 *     (`busy`/`reset_failed` carry `error`; `no_live_session` is honest text, no
 *     error);
 *   - chains LAST after passthrough links (the composer wiring shape);
 *   - `formatResetOutcome` renders each variant.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildChainedChatCommandFilter,
  buildResetChatCommandFilter,
  formatResetOutcome,
  type ResetChatOutcome,
} from '../boot-helpers.ts'
import type { ChatCommandFilter } from '../http/app-ws-surface.ts'

const matchInput = (body: string, project_id?: string) => ({
  user_id: 'owner',
  project_slug: 'acme',
  channel_topic_id: 'app:owner',
  ...(project_id !== undefined ? { project_id } : {}),
  body,
})

describe('buildResetChatCommandFilter', () => {
  test('/reset claims and returns the outcome-derived confirmation + typed data', async () => {
    const filter = buildResetChatCommandFilter({
      reset: async () => ({ ok: true, sessions_reset: 1 }),
    })
    const res = await filter.match(matchInput('/reset'))
    expect(res).not.toBeNull()
    // Real behavior: the reply body reflects a genuine success, not a canned string.
    expect(res!.text).toContain('context cleared')
    expect(res!.text).toContain('starts fresh')
    // The structured outcome rides `data`.
    expect(res!.data).toEqual({ ok: true, sessions_reset: 1 })
    // A success carries NO error.
    expect(res!.error).toBeUndefined()
  })

  test('threads the turn project_id into the reset thunk', async () => {
    let seen: string | undefined = 'UNSET'
    const filter = buildResetChatCommandFilter({
      reset: async (i) => {
        seen = i.project_id
        return { ok: true, sessions_reset: 1 }
      },
    })
    await filter.match(matchInput('/reset', 'proj-42'))
    expect(seen).toBe('proj-42')
  })

  test('omits project_id when the turn has none (General)', async () => {
    let hadKey = true
    const filter = buildResetChatCommandFilter({
      reset: async (i) => {
        hadKey = 'project_id' in i
        return { ok: true, sessions_reset: 1 }
      },
    })
    await filter.match(matchInput('/reset'))
    expect(hadKey).toBe(false)
  })

  test('tolerates leading whitespace and trailing args', async () => {
    let calls = 0
    const filter = buildResetChatCommandFilter({
      reset: async () => {
        calls++
        return { ok: true, sessions_reset: 1 }
      },
    })
    expect(await filter.match(matchInput('  /reset'))).not.toBeNull()
    expect(await filter.match(matchInput('/reset now please'))).not.toBeNull()
    expect(calls).toBe(2)
  })

  test('/resetfoo + /resets + prose fall through (word-boundary) and NEVER reset', async () => {
    let called = 0
    const filter = buildResetChatCommandFilter({
      reset: async () => {
        called++
        return { ok: true, sessions_reset: 1 }
      },
    })
    expect(await filter.match(matchInput('/resetfoo'))).toBeNull()
    expect(await filter.match(matchInput('/resets'))).toBeNull()
    expect(await filter.match(matchInput('please reset my context'))).toBeNull()
    expect(await filter.match(matchInput('/remind me tomorrow'))).toBeNull()
    // The reset thunk must NEVER run for a non-command — word boundary never resets.
    expect(called).toBe(0)
  })

  test('busy outcome → busy text + error.code === busy', async () => {
    const filter = buildResetChatCommandFilter({
      reset: async () => ({ ok: false, reason: 'busy' }),
    })
    const res = await filter.match(matchInput('/reset'))
    expect(res!.text).toContain('still in flight')
    expect(res!.text).toContain('Nothing was cleared')
    expect(res!.error).toEqual({ code: 'busy', message: 'busy' })
    expect(res!.data).toEqual({ ok: false, reason: 'busy' })
  })

  test('no_live_session outcome → honest text, NO error', async () => {
    const filter = buildResetChatCommandFilter({
      reset: async () => ({ ok: false, reason: 'no_live_session' }),
    })
    const res = await filter.match(matchInput('/reset'))
    expect(res!.text).toContain('No live session')
    // Informational — not a command failure, so no structured error.
    expect(res!.error).toBeUndefined()
  })

  test('reset_failed outcome → error populated with the detail', async () => {
    const filter = buildResetChatCommandFilter({
      reset: async () => ({ ok: false, reason: 'reset_failed', detail: 'pty write EPIPE' }),
    })
    const res = await filter.match(matchInput('/reset'))
    expect(res!.text).toContain('Reset failed: pty write EPIPE')
    expect(res!.error).toEqual({ code: 'reset_failed', message: 'pty write EPIPE' })
  })
})

describe('/reset chained after other filters (the composer wiring shape)', () => {
  // Mirrors `open/composer.ts`: the reset filter is the LAST link in
  // `buildChainedChatCommandFilter([...cores, skillForge, status, reset])`.
  const passthrough: ChatCommandFilter = { match: async () => null }

  test('an inbound the earlier filters disclaim reaches /reset', async () => {
    let called = 0
    const chain = buildChainedChatCommandFilter([
      passthrough,
      passthrough,
      buildResetChatCommandFilter({
        reset: async () => {
          called++
          return { ok: true, sessions_reset: 1 }
        },
      }),
    ])
    const res = await chain.match(matchInput('/reset'))
    expect(res).not.toBeNull()
    expect(res!.text).toContain('context cleared')
    expect(called).toBe(1)
  })

  test('a non-command inbound falls through the whole chain to null (no reset)', async () => {
    let called = 0
    const chain = buildChainedChatCommandFilter([
      passthrough,
      buildResetChatCommandFilter({
        reset: async () => {
          called++
          return { ok: true, sessions_reset: 1 }
        },
      }),
    ])
    expect(await chain.match(matchInput('just chatting'))).toBeNull()
    expect(called).toBe(0)
  })
})

describe('Layer B — /reset rehydration emit (the composer thunk shape)', () => {
  // Mirrors `open/composer.ts`'s `/reset` thunk verbatim: the composer wraps the
  // injected `reset` so that ON A SUCCESSFUL clear it emits the turn's project
  // scope onto the context-reset bus (the SAME bus the periodic policy uses),
  // then returns the outcome unchanged. This closes the known /reset persona-loss
  // gap — the next turn re-composes cold. A NON-ok outcome (busy / no_live_session
  // / reset_failed) emits NOTHING (nothing was cleared → no rehydration).
  const buildComposerResetThunk = (
    reset: () => Promise<ResetChatOutcome>,
    emit: (scope: string) => void,
  ) => async (input: { user_id: string; project_slug: string; project_id?: string }) => {
    const outcome = await reset()
    if (outcome.ok) emit(input.project_id ?? 'general')
    return outcome
  }

  test('emits the project scope on a successful reset', async () => {
    const emitted: string[] = []
    const filter = buildResetChatCommandFilter({
      reset: buildComposerResetThunk(async () => ({ ok: true, sessions_reset: 1 }), (s) => emitted.push(s)),
    })
    await filter.match(matchInput('/reset', 'proj-A'))
    expect(emitted).toEqual(['proj-A'])
  })

  test('emits "general" on success when the turn has no project_id', async () => {
    const emitted: string[] = []
    const filter = buildResetChatCommandFilter({
      reset: buildComposerResetThunk(async () => ({ ok: true, sessions_reset: 1 }), (s) => emitted.push(s)),
    })
    await filter.match(matchInput('/reset'))
    expect(emitted).toEqual(['general'])
  })

  test('does NOT emit on busy (nothing was cleared → no rehydration)', async () => {
    const emitted: string[] = []
    const filter = buildResetChatCommandFilter({
      reset: buildComposerResetThunk(async () => ({ ok: false, reason: 'busy' }), (s) => emitted.push(s)),
    })
    await filter.match(matchInput('/reset', 'proj-A'))
    expect(emitted).toEqual([])
  })

  test('does NOT emit on no_live_session', async () => {
    const emitted: string[] = []
    const filter = buildResetChatCommandFilter({
      reset: buildComposerResetThunk(async () => ({ ok: false, reason: 'no_live_session' }), (s) => emitted.push(s)),
    })
    await filter.match(matchInput('/reset', 'proj-A'))
    expect(emitted).toEqual([])
  })
})

describe('formatResetOutcome', () => {
  const cases: Array<[ResetChatOutcome, string]> = [
    [{ ok: true, sessions_reset: 1 }, 'context cleared'],
    [{ ok: false, reason: 'busy' }, 'still in flight'],
    [{ ok: false, reason: 'no_live_session' }, 'No live session'],
    [{ ok: false, reason: 'reset_failed', detail: 'boom' }, 'Reset failed: boom'],
  ]
  test('renders each outcome variant', () => {
    for (const [outcome, needle] of cases) {
      expect(formatResetOutcome(outcome)).toContain(needle)
    }
  })

  test('reset_failed with no detail still renders a safe fallback', () => {
    expect(formatResetOutcome({ ok: false, reason: 'reset_failed' })).toContain('unknown error')
  })
})
