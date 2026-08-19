/**
 * @neutronai/trident — async result delivery (gap-audit P0-1).
 *
 * Unit coverage for the terminal-result composer + the channel-posting
 * hook: the right copy per terminal state, the chat_id/thread_id →
 * channel_topic_id mapping, the no-originating-chat no-op, and the
 * outbound `send` payload.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildTridentDelivery,
  composeTerminalDelivery,
  infraDeathSentence,
  interpretFailure,
  topicForRun,
  type OutboundSink,
} from './delivery.ts'
import { deriveInfraBlock } from './infra-block.ts'
import {
  TRIDENT_SNAPSHOT_FAILURE_MARKER,
  TRIDENT_SNAPSHOT_MARKER,
} from './orchestrator.ts'
import type { OutgoingMessage } from '@neutronai/channels/types.ts'
import type { TridentPhase, TridentRun } from './store.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

function runWith(overrides: Partial<TridentRun> = {}): TridentRun {
  return makeTridentRun({
    id: 'run-1',
    slug: 'add-flag',
    project_slug: 'proj-1',
    phase: 'done',
    branch: 'trident/add-flag',
    subagent_run_id: null,
    subagent_status: 'completed',
    repo_path: '/repo',
    task: 'add a feature flag',
    chat_id: '12345',
    thread_id: '678',
    last_advanced_at: '2026-01-01T01:00:00.000Z',
    ...overrides,
  })
}

/** A recording outbound sink — captures every message the hook sends. */
function recordingSink(): { sink: OutboundSink; sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = []
  return {
    sent,
    sink: {
      async send(message) {
        sent.push(message)
        return `msg-${sent.length}`
      },
    },
  }
}

describe('composeTerminalDelivery', () => {
  test('failed PR sentinel does not render PR #0', () => {
    const text = composeTerminalDelivery(runWith({ phase: 'failed', merge_mode: 'pr', pr: 0 }))!.text
    expect(text).not.toContain('PR #0')
    expect(text).not.toContain('left open for review')
  })

  test('failed positive PR renders the review trail', () => {
    const text = composeTerminalDelivery(runWith({ phase: 'failed', merge_mode: 'pr', pr: 57 }))!.text
    expect(text).toContain('PR #57 left open for review.')
  })

  test('done PR sentinel does not render PR #0', () => {
    const text = composeTerminalDelivery(runWith({ phase: 'done', merge_mode: 'pr', pr: 0 }))!.text
    expect(text).not.toContain('PR #0')
  })

  test('done positive PR still renders its reference', () => {
    const text = composeTerminalDelivery(runWith({ phase: 'done', merge_mode: 'pr', pr: 57 }))!.text
    expect(text).toContain('(PR #57)')
  })

  test('done / pr mode → humanized "merged and deployed", title-forward, keeps the openable PR ref (#361)', () => {
    const out = composeTerminalDelivery(runWith({ phase: 'done', merge_mode: 'pr', pr: 42 }))
    expect(out).not.toBeNull()
    expect(out!.text).toContain('✅')
    // #361 — leads with the WORK TITLE (run.task), not the machine slug.
    expect(out!.text).toContain('add a feature flag')
    expect(out!.text).not.toContain('`add-flag`')
    // Plain "merged and deployed" — no "build done" jargon.
    expect(out!.text).toContain('merged and deployed')
    expect(out!.text).not.toContain('build done')
    // The PR number rides inline (openable artifact, not jargon).
    expect(out!.text).toContain('PR #42')
  })

  test('done / local mode → plain "merged and deployed", no branch jargon (#361)', () => {
    const out = composeTerminalDelivery(runWith({ phase: 'done', merge_mode: 'local' }))
    expect(out!.text).toContain('add a feature flag')
    expect(out!.text).toContain('merged and deployed')
    // Branch names are jargon — dropped.
    expect(out!.text).not.toContain('trident/add-flag')
    expect(out!.text).not.toContain('PR #')
  })

  test('done → drops the review-round jargon regardless of round count (#361)', () => {
    const out = composeTerminalDelivery(runWith({ phase: 'done', round: 3 }))
    expect(out!.text).toContain('merged and deployed')
    expect(out!.text).not.toContain('review round')
    expect(out!.text).not.toContain('after 3')
  })

  test('done on the first round → still no round jargon', () => {
    const out = composeTerminalDelivery(runWith({ phase: 'done', round: 1 }))
    expect(out!.text).not.toContain('review round')
  })

  test('failed (exhausted rounds) → plain-language review outcome, no raw reason paste (#352)', () => {
    const out = composeTerminalDelivery(
      runWith({
        phase: 'failed',
        branch: 'trident/add-flag',
        failure_reason: 'inner loop exhausted 8 round(s) without Argus APPROVE',
      }),
    )
    expect(out!.text).toContain('❌')
    // Leads with the work title, plain language — NOT the raw internal reason.
    expect(out!.text).toContain('add a feature flag')
    expect(out!.text).toContain('blocking findings')
    expect(out!.text).not.toContain('inner loop exhausted')
    // #361 — branch jargon dropped; the saved-progress cue is plain.
    expect(out!.text).not.toContain('trident/add-flag')
    expect(out!.text.toLowerCase()).toContain('progress is saved')
  })

  test('failed / pr mode → points at the open PR', () => {
    const out = composeTerminalDelivery(
      runWith({ phase: 'failed', merge_mode: 'pr', pr: 7, failure_reason: 'merge failed: conflict' }),
    )
    expect(out!.text).toContain('PR #7 left open for review')
  })

  test('failed (merge-mechanics) → NEVER pastes raw git stderr (#352)', () => {
    const out = composeTerminalDelivery(
      runWith({
        phase: 'failed',
        branch: 'trident/add-flag',
        failure_reason:
          'merge failed: git checkout base failed: error: you need to resolve your current index first',
      }),
    )
    expect(out!.text).toContain('❌')
    // The raw git stderr is DISCARDED — plain language only.
    expect(out!.text).not.toContain('resolve your current index')
    expect(out!.text).not.toContain('git checkout')
    expect(out!.text.toLowerCase()).toContain('git step failed')
  })

  test('failed → an authored merge-conflict question rides the message verbatim (specific input needed)', () => {
    const question =
      "couldn't auto-resolve the merge conflict in flush.ts for `trident/x` — it needs your call before I can land it."
    const out = composeTerminalDelivery(runWith({ phase: 'failed', failure_reason: question }))
    expect(out!.text).toContain('❌')
    // The specific decision the operator must make is surfaced verbatim.
    expect(out!.text).toContain(question)
    // ...framed with a plain-language summary of what happened.
    expect(out!.text).toContain('edited the same code')
  })

  test('salvage metadata keeps the authored cause and exposes the recovery ref', () => {
    const authored =
      'The build paused after the executor disappeared; inspect the preserved edits before retrying.'
    const ref = 'refs/tags/trident-salvage/run-1'
    const out = composeTerminalDelivery(
      runWith({
        phase: 'failed',
        failure_reason: `${authored} — 0 commits; 292 uncommitted text line(s) across 3 file(s) (2 untracked) — ${TRIDENT_SNAPSHOT_MARKER} — recovery ref ${ref}`,
      }),
    )

    expect(out?.text).toContain(authored)
    expect(out?.text).toContain(`Recovery snapshot: ${ref}.`)
    expect(out?.text).not.toContain('The build did not complete.')

    const alreadyPublished = composeTerminalDelivery(
      runWith({
        phase: 'failed',
        pr: 7,
        failure_reason: `${authored}; plus 12 uncommitted text line(s) across 2 file(s) — ${TRIDENT_SNAPSHOT_MARKER} — recovery ref ${ref}`,
      }),
    )
    expect(alreadyPublished?.text).toContain(authored)
    expect(alreadyPublished?.text).toContain(`Recovery snapshot: ${ref}.`)
  })

  test('a persisted capture failure is visible without changing failure classification', () => {
    const authored = 'The executor disappeared before it could finish the build.'
    const detail = 'snapshot update-ref failed: simulated ref refusal'
    const failed = runWith({
      phase: 'failed',
      failure_reason: `${authored} — 0 commits; ${TRIDENT_SNAPSHOT_FAILURE_MARKER}: ${detail}`,
    })

    expect(interpretFailure(failed)).toEqual(
      interpretFailure(runWith({ phase: 'failed', failure_reason: authored })),
    )
    expect(composeTerminalDelivery(failed)?.text).toContain(`Recovery warning: ${detail}.`)
  })

  test('stopped → a plain stopped notice', () => {
    const out = composeTerminalDelivery(runWith({ phase: 'stopped' }))
    expect(out!.text).toContain('🛑')
    expect(out!.text).toContain('stopped')
  })

  test('a non-terminal run composes nothing (defensive null)', () => {
    for (const phase of ['forge-init', 'ralph-plan', 'ralph-task', 'argus', 'forge-fix'] as TridentPhase[]) {
      expect(composeTerminalDelivery(runWith({ phase }))).toBeNull()
    }
  })

  test('a long title is truncated in the header', () => {
    const longTask = 'x'.repeat(200)
    const out = composeTerminalDelivery(runWith({ phase: 'done', task: longTask }))
    expect(out!.text).toContain('…')
    // the title is clamped to ≤ 80 chars (the header lead)
    expect(out!.text.includes('x'.repeat(81))).toBe(false)
  })
})

describe('interpretFailure (#352) — plain-language classification, never a raw error paste', () => {
  const RAW_GIT_TOKENS = [
    'resolve your current index',
    'CONFLICT (content)',
    'error: ',
    'fatal: ',
    'exit code',
    'stderr',
    'MERGE_HEAD',
    'rebase --continue',
  ]

  // Every class'd message must be free of raw git/tool leakage.
  function assertNoRawLeak(text: string): void {
    for (const tok of RAW_GIT_TOKENS) {
      expect(text.toLowerCase()).not.toContain(tok.toLowerCase())
    }
  }

  test('hang → plain "stopped making progress" + retry', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: 'no progress for 25 min — suspected agent hang (inner workflow stopped advancing)' }),
    )
    expect(interp.klass).toBe('hang')
    expect(interp.summary.toLowerCase()).toContain('progress')
    expect(interp.input_needed.toLowerCase()).toContain('retry')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
  })

  test('review-unresolved → plain "blocking findings" + review the branch', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: 'inner loop exhausted 8 round(s) without Argus APPROVE' }),
    )
    expect(interp.klass).toBe('review-unresolved')
    expect(interp.summary.toLowerCase()).toContain('blocking findings')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
  })

  test('crash-recovery budget → the SUPERVISOR died, never "the reviewer had findings"', () => {
    // The orchestrator's budget reason EMBEDS the latched launcher-crash text, which
    // is not ours to keyword-proof — here it carries 'stalled' and 'exhausted', the
    // exact tokens the hang + review branches match on. Mutation killed: remove this
    // branch (or order it after them) and a gateway-restart casualty is reported as a
    // review that found blocking problems, which is the #240 failure shape.
    const interp = interpretFailure(
      runWith({
        phase: 'failed',
        failure_reason:
          'launcher crashed 4 time(s); crash-recovery budget (3) used up — not relaunching. ' +
          'Last crash: inner workflow child crashed: pooled child exited (the pool had stalled and exhausted its slots)',
      }),
    )
    expect(interp.klass).toBe('infra')
    expect(interp.summary.toLowerCase()).not.toContain('reviewer')
    expect(interp.summary.toLowerCase()).not.toContain('blocking findings')
    expect(interp.summary.toLowerCase()).toContain('supervisor')
    // The work is not lost — it is on the branch, and the user is told so.
    expect(interp.summary.toLowerCase()).toContain('branch')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
  })

  test('merge-conflict (authored question) → surfaces the specific question as the input needed', () => {
    const q = "couldn't auto-resolve the merge conflict in flush.ts for `trident/x` — it needs your call before I can land it."
    const interp = interpretFailure(runWith({ phase: 'failed', failure_reason: q }))
    expect(interp.klass).toBe('merge-conflict')
    expect(interp.input_needed).toBe(q)
    expect(interp.summary.toLowerCase()).toContain('same code')
  })

  test('#361 tools-not-enabled → classified INTERNAL (infra), never leaks the raw "file/shell tools" stderr', () => {
    for (const raw of [
      'forge:build reported: I don\'t have access to a bash execution tool — I only have reply and send_typing',
      'resolver failed: tools not enabled in this context; re-run with file/shell tools enabled',
      'Edit tool is not enabled in this context',
    ]) {
      const interp = interpretFailure(runWith({ phase: 'failed', failure_reason: raw }))
      // A toolless subprocess is a purely INTERNAL misconfiguration.
      expect(interp.klass).toBe('infra')
      // The raw "tools not enabled" / "file/shell tools" stderr is NEVER surfaced.
      const shown = (interp.summary + ' ' + interp.input_needed).toLowerCase()
      expect(shown).not.toContain('tools not enabled')
      expect(shown).not.toContain('file/shell tools')
      expect(shown).not.toContain('re-run with')
      expect(shown).not.toContain('send_typing')
      expect(shown).toContain('internal')
      expect(interp.input_needed.toLowerCase()).toContain('retry')
    }
  })

  test('merge-mechanics (raw git stderr) → the raw stderr is DISCARDED', () => {
    const interp = interpretFailure(
      runWith({
        phase: 'failed',
        failure_reason:
          'merge failed: git checkout base failed: error: you need to resolve your current index first',
      }),
    )
    expect(interp.klass).toBe('merge-mechanics')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
    expect(interp.summary.toLowerCase()).toContain('git step failed')
  })

  test('stale-state → plain, never surfaces "resolve your current index first"', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: 'error: you need to resolve your current index first' }),
    )
    expect(interp.klass).toBe('stale-state')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
    expect(interp.input_needed.toLowerCase()).toContain('retry')
  })

  test('infra → plain internal-error + retry (provenance gate etc.)', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: 'inner workflow reported APPROVE but no recorded argus-approved checkpoint (provenance gate)' }),
    )
    expect(interp.klass).toBe('infra')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
  })

  test('underspecified → surfaces the (already plain) guidance', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: 'Plan item is underspecified — add a design doc or a detailed title.' }),
    )
    expect(interp.klass).toBe('underspecified')
    expect(interp.input_needed.length).toBeGreaterThan(0)
  })

  test('unknown/empty → a safe generic message, never a multi-line raw paste', () => {
    const interp = interpretFailure(runWith({ phase: 'failed', failure_reason: null }))
    expect(interp.klass).toBe('unknown')
    expect(interp.summary.length).toBeGreaterThan(0)
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
  })
})

/**
 * AN INFRA-ONLY BLOCK IS INFRASTRUCTURE, NEVER THE AGENT'S WORK BEING REJECTED.
 *
 * The board was full of `[failed]` cards whose builds were fine and whose infrastructure
 * was not: a required check that never ran, a PR conflicting with base, a credential that
 * blinked — all terminating wearing REQUEST_CHANGES clothes over code no reviewer read.
 * These pin the three-way matrix: an infra block renders as infrastructure; a GENUINE
 * rejection is byte-identical to before; a run with no findings and no infra signal is
 * not silently relabelled either way. Plus the stale-`inner_result` gate.
 */
describe('infra-only block delivers as infrastructure', () => {
  /** A harvested, failed row carrying the workflow's own infra-only terminal result. */
  function infraRun(cause: string | null, overrides: Partial<TridentRun> = {}): TridentRun {
    const result: Record<string, unknown> = {
      ok: false,
      verdict: 'REQUEST_CHANGES',
      round: 1,
      checkpoint: null,
      blockKind: 'infra-only',
    }
    if (cause !== null) result['terminalCause'] = cause
    return runWith({
      phase: 'failed',
      inner_result: JSON.stringify(result),
      harvested_at: 1755300000000,
      failure_reason:
        cause !== null
          ? `review never ran (infra-only) at round 1 of 10: ${cause}`
          : 'review never ran (infra-only) at round 1 of 10',
      ...overrides,
    })
  }

  test('a required check that never ran → an infrastructure deferral naming the check', () => {
    const run = infraRun('required check test has not run')
    const interp = interpretFailure(run)
    expect(interp.klass).toBe('infra-blocked')
    // The measured cause rides the summary VERBATIM — the owner learns which machine broke.
    expect(interp.summary).toContain('required check test has not run')

    const out = composeTerminalDelivery(run)
    expect(out!.text.startsWith('🚧')).toBe(true)
    expect(out!.text).toContain('deferred')
    expect(out!.text).toContain('required check test has not run')
    // ...and what would clear it.
    expect(out!.text.toLowerCase()).toContain('re-run ci')
    // NEVER a rejection.
    expect(out!.text).not.toContain('❌')
    expect(out!.text.toLowerCase()).not.toContain('changes requested')
    expect(out!.text.toLowerCase()).not.toContain('blocking findings')
  })

  test('a "conflicting with base" cause is infrastructure, NOT the merge-conflict class', () => {
    // THE MISROUTE THIS PINS. The measured cause is CI prose containing the bare token
    // `conflict`, which `isAuthoredConflictQuestion` matches — so before the structured
    // check ran first, this produced the confident FALSE sentence "two changes edited the
    // same code…" about a build nobody had reviewed.
    const run = infraRun('PR is conflicting with base')
    const interp = interpretFailure(run)
    expect(interp.klass).toBe('infra-blocked')
    expect(interp.klass).not.toBe('merge-conflict')

    const out = composeTerminalDelivery(run)
    expect(out!.text).not.toContain('two changes edited the same code')
    expect(out!.text).not.toContain('❌')
    expect(out!.text).toContain('PR is conflicting with base')
    expect(interp.input_needed.toLowerCase()).toMatch(/rebase|merge the base branch/)
  })

  test('an infra-only stop with NO measured cause stays infra-blocked and generic', () => {
    const run = infraRun(null)
    const interp = interpretFailure(run)
    // The block KIND was measured even though the cause was not.
    expect(interp.klass).toBe('infra-blocked')
    expect(interp.summary).toBe(
      'The build was blocked by infrastructure before any reviewer judged the code.',
    )
    // No dangling colon where a cause would have been quoted.
    expect(interp.summary).not.toContain(':')
    expect(interp.input_needed.toLowerCase()).toContain('retry')
    const out = composeTerminalDelivery(run)
    expect(out!.text.startsWith('🚧')).toBe(true)
    expect(out!.text).not.toContain('❌')
  })

  test('a GENUINE review rejection is unchanged — still ❌ and still a review outcome', () => {
    const run = runWith({
      phase: 'failed',
      harvested_at: 1755300000000,
      inner_result: JSON.stringify({
        ok: false,
        verdict: 'REQUEST_CHANGES',
        round: 8,
        checkpoint: 'argus-request-changes',
        blockKind: 'code',
        terminalCause: 'the reviewer left 3 blocking findings',
      }),
      failure_reason: 'inner loop exhausted 8 round(s) without Argus APPROVE',
    })
    const interp = interpretFailure(run)
    expect(interp.klass).toBe('review-unresolved')
    expect(interp.summary.toLowerCase()).toContain('blocking findings')
    const out = composeTerminalDelivery(run)
    expect(out!.text.startsWith('❌')).toBe(true)
    // Byte-identical to the composition with no structured result at all.
    const bare = composeTerminalDelivery(
      runWith({
        phase: 'failed',
        failure_reason: 'inner loop exhausted 8 round(s) without Argus APPROVE',
      }),
    )
    expect(out!.text).toBe(bare!.text)
  })

  test('no findings and no infra signal is not silently relabelled either way', () => {
    // (a) nothing structured at all → the existing generic handling, ❌ kept.
    const noSignal = runWith({
      phase: 'failed',
      harvested_at: 1755300000000,
      inner_result: null,
      failure_reason: 'inner workflow ended at round 1 of 10 without Argus APPROVE',
    })
    expect(interpretFailure(noSignal).klass).toBe('unknown')
    expect(composeTerminalDelivery(noSignal)!.text.startsWith('❌')).toBe(true)

    // (b) a GARBLED block kind decodes fail-closed to null and must never be read as
    // infra-only — the decoder's rule, not a second opinion here.
    const garbled = runWith({
      phase: 'failed',
      harvested_at: 1755300000000,
      inner_result: JSON.stringify({
        ok: false,
        verdict: 'REQUEST_CHANGES',
        round: 1,
        checkpoint: null,
        blockKind: 'infra_only',
        terminalCause: 'required check test has not run',
      }),
      failure_reason: 'inner workflow ended at round 1 of 10 without Argus APPROVE',
    })
    expect(interpretFailure(garbled).klass).not.toBe('infra-blocked')
    expect(composeTerminalDelivery(garbled)!.text).not.toContain('🚧')
  })

  test('a STALE infra-only result on an unharvested or non-failed row changes nothing', () => {
    // (a) never harvested — the row was force-terminated while an older parseable result
    // sat in the column, so it says nothing about how this run ended.
    const unharvested = infraRun('required check test has not run', {
      harvested_at: null,
      failure_reason: 'no progress for 25 min — suspected agent hang (inner workflow stopped advancing)',
    })
    expect(interpretFailure(unharvested).klass).toBe('hang')
    expect(composeTerminalDelivery(unharvested)!.text).not.toContain('🚧')

    // (b) a stopped row still composes the stopped line.
    const stopped = infraRun('required check test has not run', { phase: 'stopped' })
    expect(composeTerminalDelivery(stopped)!.text).toContain('🛑')
  })

  describe('deriveInfraBlock — the three-condition gate, each condition falsified alone', () => {
    const inner = JSON.stringify({
      ok: false,
      verdict: 'REQUEST_CHANGES',
      round: 1,
      checkpoint: null,
      blockKind: 'infra-only',
      terminalCause: 'PR is conflicting with base',
    })
    const gated = { phase: 'failed' as const, harvested_at: 1755300000000, inner_result: inner }

    test('all three hold → the measured cause', () => {
      expect(deriveInfraBlock(gated)).toEqual({ cause: 'PR is conflicting with base' })
    })

    test('phase is not failed → null', () => {
      for (const phase of ['done', 'stopped', 'argus'] as TridentPhase[]) {
        expect(deriveInfraBlock({ ...gated, phase })).toBeNull()
      }
    })

    test('never harvested → null (the stale-result hazard)', () => {
      expect(deriveInfraBlock({ ...gated, harvested_at: null })).toBeNull()
    })

    test('the block kind is not exactly infra-only → null', () => {
      for (const kind of ['code', 'none', 'round-lost', 'infra_only', 'INFRA-ONLY']) {
        const raw = JSON.stringify({ round: 1, blockKind: kind, terminalCause: 'x' })
        expect(deriveInfraBlock({ ...gated, inner_result: raw })).toBeNull()
      }
      expect(deriveInfraBlock({ ...gated, inner_result: null })).toBeNull()
      expect(deriveInfraBlock({ ...gated, inner_result: 'not json' })).toBeNull()
    })

    test('infra-only with no measured cause → a block with a null cause, not null', () => {
      const raw = JSON.stringify({ round: 1, blockKind: 'infra-only' })
      expect(deriveInfraBlock({ ...gated, inner_result: raw })).toEqual({ cause: null })
    })
  })
})

describe('topicForRun', () => {
  test('chat_id + thread_id → `<chat>:<thread>` channel_topic_id (telegram)', () => {
    const topic = topicForRun(runWith({ chat_id: '12345', thread_id: '678' }), 'telegram')
    expect(topic).not.toBeNull()
    expect(topic!.channel_kind).toBe('telegram')
    expect(topic!.channel_topic_id).toBe('12345:678')
  })

  test('chat_id only → bare `<chat>` channel_topic_id', () => {
    const topic = topicForRun(runWith({ chat_id: '12345', thread_id: null }), 'telegram')
    expect(topic!.channel_topic_id).toBe('12345')
  })

  test('no chat_id → null (nothing to deliver to)', () => {
    expect(topicForRun(runWith({ chat_id: null }), 'telegram')).toBeNull()
    expect(topicForRun(runWith({ chat_id: '' }), 'telegram')).toBeNull()
  })

  test('honours a non-default channel kind', () => {
    const topic = topicForRun(runWith({ chat_id: 'web:u1', thread_id: null }), 'app_socket')
    expect(topic!.channel_kind).toBe('app_socket')
  })
})

describe('buildTridentDelivery.onTerminal', () => {
  test('posts the composed result to the run’s originating topic', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({ sink })
    await hook.onTerminal(runWith({ phase: 'done', merge_mode: 'pr', pr: 99, chat_id: '500', thread_id: '12' }))

    expect(sent.length).toBe(1)
    expect(sent[0]!.topic.channel_topic_id).toBe('500:12')
    expect(sent[0]!.topic.channel_kind).toBe('telegram')
    expect(sent[0]!.text).toContain('PR #99')
  })

  test('no-ops when the run has no originating chat', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({ sink })
    await hook.onTerminal(runWith({ phase: 'done', chat_id: null }))
    expect(sent.length).toBe(0)
  })

  // #317 — the delivery channel is derived PER RUN from `run.channel_kind`,
  // not hard-coded to telegram. A `/code` build dispatched from the app-WS
  // surface delivers its result back to that surface.
  test('#317 derives the delivery channel from the run record (app_socket)', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({ sink }) // no channel_kind override
    await hook.onTerminal(
      runWith({ phase: 'done', chat_id: 'web:u1', thread_id: null, channel_kind: 'app_socket' }),
    )
    expect(sent.length).toBe(1)
    expect(sent[0]!.topic.channel_kind).toBe('app_socket')
    expect(sent[0]!.topic.channel_topic_id).toBe('web:u1')
  })

  test('#317 a Telegram-origin run still delivers to telegram', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({ sink })
    await hook.onTerminal(runWith({ phase: 'done', chat_id: '500', channel_kind: 'telegram' }))
    expect(sent[0]!.topic.channel_kind).toBe('telegram')
  })

  test('#317 the run record wins over the build-time fallback channel', async () => {
    const { sink, sent } = recordingSink()
    // Even with a telegram fallback, an app_socket run routes to app_socket.
    const hook = buildTridentDelivery({ sink, channel_kind: 'telegram' })
    await hook.onTerminal(
      runWith({ phase: 'done', chat_id: 'web:u9', channel_kind: 'app_socket' }),
    )
    expect(sent[0]!.topic.channel_kind).toBe('app_socket')
  })

  test('a custom composer returning null suppresses the post', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({ sink, compose: () => null })
    await hook.onTerminal(runWith({ phase: 'failed', chat_id: '1' }))
    expect(sent.length).toBe(0)
  })

  test('propagates a sink failure to the caller (the loop logs + continues)', async () => {
    const hook = buildTridentDelivery({
      sink: { async send() { throw new Error('telegram 502') } },
    })
    await expect(hook.onTerminal(runWith({ phase: 'done', chat_id: '1' }))).rejects.toThrow('telegram 502')
  })

  test('forwards inline_choices when a custom composer supplies them', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({
      sink,
      compose: () => ({ text: 'done', inline_choices: [{ label: 'View', callback_data: 'v' }] }),
    })
    await hook.onTerminal(runWith({ phase: 'done', chat_id: '1' }))
    expect(sent[0]!.inline_choices).toEqual([{ label: 'View', callback_data: 'v' }])
  })
})

/**
 * T4 — AN INFRASTRUCTURE DEATH IS NOT A VERDICT (run `f384460d`, 2026-08-15).
 *
 * The inner workflow threw; its catch path self-asserted `verdict:'REQUEST_CHANGES'` and
 * the owner was told the reviewer rejected work no reviewer ever saw. Every authored
 * infrastructure sentence must land in the `infra` class before embedded cause words can
 * route it into review, hang, or merge-mechanics copy.
 */
describe('interpretFailure — an infrastructure death is delivered as infrastructure', () => {
  test('the authored infra sentence → klass infra, not a review outcome', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: infraDeathSentence(3, 10) }),
    )
    expect(interp.klass).toBe('infra')
    expect(interp.summary.toLowerCase()).toContain('internal error')
    expect(interp.summary.toLowerCase()).not.toContain('blocking findings')
  })

  test("an infra-only reason whose measured cause contains 'stalled' is NOT a hang", () => {
    const interp = interpretFailure(
      runWith({
        phase: 'failed',
        failure_reason:
          'review never ran (infra-only) at round 1 of 10: readiness probe stalled: gh auth login',
      }),
    )
    expect(interp.klass).toBe('infra')
  })

  test("an infra reason carrying 'exhausted' is still infra, never review-unresolved", () => {
    const interp = interpretFailure(
      runWith({
        phase: 'failed',
        failure_reason:
          'review never ran (infra-only) at round 1 of 10: the pool exhausted its slots',
      }),
    )
    expect(interp.klass).toBe('infra')
    expect(interp.summary.toLowerCase()).not.toContain('blocking findings')
  })

  test("main's thrown-with-cause sentence carrying 'git ' stays infra, never merge mechanics", () => {
    const interp = interpretFailure(
      runWith({
        phase: 'failed',
        failure_reason: 'inner workflow failed at round 2 of 10: git push exited 128 mid-publish',
      }),
    )
    expect(interp.klass).toBe('infra')
  })

  test('the composed delivery names the internal error, keeps the PR, and claims no verdict', () => {
    const out = composeTerminalDelivery(
      runWith({
        phase: 'failed',
        merge_mode: 'pr',
        pr: 267,
        inner_verdict: null,
        failure_reason: infraDeathSentence(1, 8),
      }),
    )
    expect(out).not.toBeNull()
    expect(out!.text.toLowerCase()).toContain('internal error')
    expect(out!.text).toContain('PR #267 left open')
    expect(out!.text).not.toContain('blocking findings')
    expect(out!.text).not.toContain('without an approved review')
  })
})
