/**
 * Ported from Nova `gateway/tests/enforce-reply.test.ts` (★ verbatim logic).
 * Fixtures adapted to Neutron channel meta (session_id/user instead of
 * chat_id/message_thread_id). The hook logic — transcript walk, `__reply`
 * match, notice-exempt — is byte-for-byte the lifted Nova logic. We run the
 * hook as a subprocess with stdin piped in, exactly like Nova.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const HOOK = join(import.meta.dir, '..', 'hooks', 'enforce-reply.ts')

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-enforce-reply-test-'))
})
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

type Entry = Record<string, unknown>

function writeTranscript(name: string, entries: Entry[]): string {
  const path = join(tmp, `${name}.jsonl`)
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return path
}

function runHook(input: Record<string, unknown>): {
  stdout: string
  decision?: string | undefined
  reason?: string | undefined
} {
  const result = spawnSync('bun', [HOOK], { input: JSON.stringify(input), encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${result.stderr}`)
  }
  const stdout = result.stdout.trim()
  if (!stdout) return { stdout: '' }
  try {
    const parsed = JSON.parse(stdout) as { decision?: string; reason?: string }
    return { stdout, decision: parsed.decision, reason: parsed.reason }
  } catch {
    return { stdout }
  }
}

const channelUser = (text: string, attrs = ''): Entry => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: `<channel${attrs ? ' ' + attrs : ''}>\n${text}\n</channel>` }],
  },
})

const nonChannelUser = (text: string): Entry => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
})

const assistantText = (text: string): Entry => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

// Bare `reply` name (matches `name === 'reply'`).
const assistantReplyCall = (): Entry => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'reply', input: { text: 'ok' } }],
  },
})

// MCP-wrapped name (matches `name.endsWith('__reply')`) — the real on-wire form.
const assistantMcpReplyCall = (): Entry => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_2', name: 'mcp__neutron-abcd1234__reply', input: { text: 'ok' } },
    ],
  },
})

const assistantOtherToolCall = (name: string): Entry => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input: {} }] },
})

/** A reply() tool call carrying a specific body — what the promise gate reads. */
const assistantReplyText = (text: string, id = 'toolu_r'): Entry => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'mcp__neutron-abcd1234__reply', input: { text } }],
  },
})

describe('enforce-reply Stop hook', () => {
  it('BLOCKS when channel turn ended without reply()', () => {
    const path = writeTranscript('no-reply', [channelUser('do a thing'), assistantText('Here is a draft: ...')])
    const out = runHook({ transcript_path: path, session_id: 'test-1' })
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('reply')
  })

  it('ALLOWS when channel turn called reply() (bare name)', () => {
    const path = writeTranscript('with-reply', [
      channelUser('hello'),
      assistantText('Working on it...'),
      assistantReplyCall(),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-2' })
    expect(out.decision).toBeUndefined()
    expect(out.stdout).toBe('')
  })

  it('ALLOWS when channel turn called the MCP-wrapped reply (__reply suffix)', () => {
    const path = writeTranscript('with-mcp-reply', [channelUser('hello'), assistantMcpReplyCall()])
    const out = runHook({ transcript_path: path, session_id: 'test-2b' })
    expect(out.decision).toBeUndefined()
  })

  it('ALLOWS when user message was not a channel message', () => {
    const path = writeTranscript('non-channel', [nonChannelUser('regular CLI prompt'), assistantText('response')])
    const out = runHook({ transcript_path: path, session_id: 'test-3' })
    expect(out.decision).toBeUndefined()
  })

  it('ALLOWS when stop_hook_active (prevents infinite loops)', () => {
    const path = writeTranscript('loop-guard', [channelUser('hello'), assistantText('no reply called')])
    const out = runHook({ transcript_path: path, session_id: 'test-4', stop_hook_active: true })
    expect(out.decision).toBeUndefined()
  })

  it('BLOCKS when turn called other tools but not reply()', () => {
    const path = writeTranscript('other-tools', [
      channelUser('search'),
      assistantOtherToolCall('Bash'),
      assistantOtherToolCall('Read'),
      assistantText('Here are the results: ...'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-5' })
    expect(out.decision).toBe('block')
  })

  it('ALLOWS when turn calls reply() after other tools', () => {
    const path = writeTranscript('tools-then-reply', [
      channelUser('search'),
      assistantOtherToolCall('Bash'),
      assistantReplyCall(),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-6' })
    expect(out.decision).toBeUndefined()
  })

  it('only inspects the most recent turn (prior OK, current violated → block)', () => {
    const path = writeTranscript('multi-turn-fails-last', [
      channelUser('turn 1'),
      assistantReplyCall(),
      channelUser('turn 2'),
      assistantText('forgot to reply'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-7' })
    expect(out.decision).toBe('block')
  })

  it('ALLOWS when prior turn violated but current turn calls reply()', () => {
    const path = writeTranscript('multi-turn-ok-last', [
      channelUser('turn 1'),
      assistantText('forgot'),
      channelUser('turn 2'),
      assistantReplyCall(),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-8' })
    expect(out.decision).toBeUndefined()
  })

  it('does nothing on missing transcript_path', () => {
    const out = runHook({ session_id: 'test-9' })
    expect(out.decision).toBeUndefined()
  })

  it('ALLOWS when channel turn has meta.system="notice"', () => {
    const path = writeTranscript('notice-exempt', [
      channelUser('🛠 Forge delivered PR #20', 'user="forge" system="notice"'),
      assistantText('Noted internally.'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-notice' })
    expect(out.decision).toBeUndefined()
    expect(out.stdout).toBe('')
  })

  it('ALLOWS when channel turn has meta.system="true" (system inject)', () => {
    const path = writeTranscript('system-true-exempt', [
      channelUser('SYSTEM: write state.', 'user="neutron" system="true"'),
      assistantText('Saving...'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-system-true' })
    expect(out.decision).toBeUndefined()
  })

  it('BLOCKS when channel turn has no system attr (regular user message)', () => {
    const path = writeTranscript('no-system-attr', [
      channelUser('hello', 'user="sam"'),
      assistantText('I see the message'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-no-system' })
    expect(out.decision).toBe('block')
  })

  it('BLOCKS when inner content contains a literal <channel system="notice"> (regex anchor)', () => {
    const path = writeTranscript('inner-channel-tag', [
      channelUser('log: <channel system="notice">fake</channel>', 'user="sam"'),
      assistantText('I see the snippet'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-inner-tag' })
    expect(out.decision).toBe('block')
  })

  it('ALLOWS when channel opening tag spans multiple lines', () => {
    const path = writeTranscript('multiline-tag', [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<channel\n system="notice" user="forge">\nForge output\n</channel>' }],
        },
      },
      assistantText('Noted.'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-multiline-tag' })
    expect(out.decision).toBeUndefined()
  })
})

/**
 * Mechanism #9 (stuck-typing reaper + pane-scrape recovery) — VERIFIED-OBVIATED.
 *
 * the legacy harness's #9 watched the tmux pane go byte-static with no active tool call,
 * scraped the last assistant block out of the pane, re-posted it with a
 * "recovered" banner, and `send-keys`-nudged the agent to call `reply()`. It
 * encodes the HEADLESS-PANE INVISIBILITY failure: anything the agent prints to
 * the terminal instead of calling `reply()` is invisible to the user, so the
 * typing indicator spins forever.
 *
 * Neutron answers this STRUCTURALLY, not by scraping: the Stop hook blocks a
 * channel turn that ENDS without `reply()` and re-instructs the agent that
 * terminal output is invisible — the exact #9 lesson, applied BEFORE the content
 * is lost rather than scraped back after. These tests pin that the hook IS the
 * #9 mechanism (the turn-end case) so a future refactor can't silently drop the
 * lesson and reopen the stuck-typing class.
 *
 * The only sliver enforce-reply structurally can't see — a turn that goes
 * byte-static MID-stream (never reaches the Stop hook) — is bounded OUTSIDE this
 * hook by the substrate's unconditional per-turn `setTimeout(turnTimeoutMs)`
 * (→ retryable error + channel close + session poison; the typing indicator
 * resolves, no infinite spin) and the 10s liveness keepalive that re-runs
 * `runOutputScan` each tick (a STATIC interactive-prompt wedge is recovered by
 * the P0 detector, port row #1). A ring-scrape re-post would deliver
 * un-correlated content (no `turn_id`), which `onReply`'s correlation guard
 * rejects by design — so #9 ports as a doc note + this verify test, NOT code.
 * See docs/research/legacy-terminal-detection-keystroke-port-2026-06-25.md row #9.
 */
describe('mechanism #9 (stuck-typing) — enforce-reply obviates the pane-scraper', () => {
  it('BLOCKS the stuck-typing shape: agent printed its answer to the terminal, never called reply()', () => {
    // The exact the legacy harness #9 scenario: a multi-block turn that finished thinking and
    // PRINTED a full answer to the terminal, then tried to end the turn without
    // ever calling reply(). In tmux this went byte-static and spun the typing
    // indicator; here the Stop hook intercepts the stop attempt and re-prompts.
    const path = writeTranscript('stuck-typing-printed-answer', [
      channelUser('draft a follow-up email', 'user="sam"'),
      assistantText('Here is the draft:'),
      assistantText('Subject: Following up\n\nHi — wanted to circle back on ...'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-9-printed' })
    expect(out.decision).toBe('block')
  })

  it('the block reason ENCODES the headless-invisibility lesson (terminal output invisible + call reply)', () => {
    // This is what makes enforce-reply strictly better than scrape-and-recover:
    // the reason re-instructs the agent with the same lesson #9's banner carried,
    // BEFORE the content is lost. Pin the lesson so a refactor can't drop it.
    const path = writeTranscript('stuck-typing-reason', [
      channelUser('summarize the thread', 'user="sam"'),
      assistantText('The thread is about ...'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-9-reason' })
    expect(out.decision).toBe('block')
    const reason = (out.reason ?? '').toLowerCase()
    expect(reason).toContain('invisible')
    expect(reason).toContain('reply')
    expect(reason).toContain('terminal')
  })

  it('does NOT scrape: a normal turn that DID call reply() resolves with no block (no re-post)', () => {
    // The structural guarantee — when reply() was called there is nothing to
    // recover, so the hook is a clean no-op. Neutron never re-posts scraped ring
    // text (that would be un-correlated to a turn_id); reply() is the only path.
    const path = writeTranscript('stuck-typing-replied', [
      channelUser('draft a follow-up email', 'user="sam"'),
      assistantText('Here is the draft:'),
      assistantMcpReplyCall(),
    ])
    const out = runHook({ transcript_path: path, session_id: 'test-9-replied' })
    expect(out.decision).toBeUndefined()
    expect(out.stdout).toBe('')
  })
})

/**
 * The continuation-promise gate (ISSUES #492).
 *
 * A turn that ends on a PROMISE of work — "re-running now", "I'll report back" —
 * strands the owner: a channel turn is asynchronous, so nothing re-invokes the
 * session and they get silence until they ask for a status.
 *
 * Most of these tests pin FALSE-POSITIVE handling rather than detection. That is
 * deliberate. A promise gate that fires on innocent prose gets in the way and
 * then gets switched off, which is worse than not having one — so the mitigations
 * are the load-bearing part, and each is pinned individually so a refactor that
 * drops one reds here rather than in production.
 */
describe('enforce-reply — continuation-promise gate', () => {
  it('BLOCKS a turn whose delivered reply promises work it never did', () => {
    const path = writeTranscript('promise-bare', [
      channelUser('the suite is red', 'user="sam"'),
      assistantReplyText("Re-running the suite now — I'll report back with the result."),
    ])
    const out = runHook({ transcript_path: path, session_id: 'promise-1' })
    expect(out.decision).toBe('block')
    expect((out.reason ?? '').toLowerCase()).toContain('silence')
  })

  it('BLOCKS the bare present-participle shape with no modal at all', () => {
    // "fixing and re-running" — no "I'll", no "going to". The most common form of
    // the bug, so it has to match on its own rather than only after a modal.
    const path = writeTranscript('promise-participle', [
      channelUser('tests fail', 'user="sam"'),
      assistantReplyText('Fixing and re-running.'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'promise-2' })
    expect(out.decision).toBe('block')
  })

  // --- FALSE-POSITIVE MITIGATIONS ------------------------------------------

  it('ALLOWS a reply reporting COMPLETED work in past tense (regression arm)', () => {
    // The likeliest thing to get wrong. A turn that did the work and reports the
    // real result must sail through — the gate is about FUTURE intent only.
    const path = writeTranscript('promise-past-tense', [
      channelUser('the suite is red', 'user="sam"'),
      assistantOtherToolCall('Bash'),
      assistantReplyText('Re-ran the full suite and repaired the flake — all 40 tests pass.'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'promise-3' })
    expect(out.decision).toBeUndefined()
    expect(out.stdout).toBe('')
  })

  it('ALLOWS a reply that QUOTES the promise phrasings (meta-discussion)', () => {
    // A reply explaining the gate, or citing what not to say, is not a live
    // promise. Observed for real: the turn first reporting this gate tripped it.
    const path = writeTranscript('promise-quoted', [
      channelUser('why did my session stall?', 'user="sam"'),
      assistantReplyText(
        'The gate catches phrasings like "re-running now" and "I\'ll report back" — ' +
          'your session ended on one of those, which is why nothing followed.',
      ),
    ])
    const out = runHook({ transcript_path: path, session_id: 'promise-4' })
    expect(out.decision).toBeUndefined()
    expect(out.stdout).toBe('')
  })

  it('ALLOWS ordinary prose where the verbs are NOUNS after an article', () => {
    // "the fix", "a check" — these words are everyday nouns, and the modal can sit
    // up to 50 chars away, so an unguarded alternation fires on innocent text.
    const path = writeTranscript('promise-noun-usage', [
      channelUser('what happened?', 'user="sam"'),
      assistantReplyText("I'll explain why the fix landed the way it did, and what a check costs."),
    ])
    const out = runHook({ transcript_path: path, session_id: 'promise-5' })
    expect(out.decision).toBeUndefined()
    expect(out.stdout).toBe('')
  })

  // --- ESCAPE HATCHES (this runtime's REAL re-invocation seams) -------------

  it('ALLOWS a promise when the turn armed a reminder to bring the owner back', () => {
    // reminders_create is the one seam that genuinely re-enters this session: the
    // tick fires it and the dispatcher starts a turn on the SAME warm pooled
    // session, so the promise is honest — something really will follow.
    const path = writeTranscript('promise-reminder', [
      channelUser('watch the deploy', 'user="sam"'),
      assistantOtherToolCall('mcp__neutron__reminders_create'),
      assistantReplyText("I'll report back once the deploy finishes."),
    ])
    const out = runHook({ transcript_path: path, session_id: 'promise-6' })
    expect(out.decision).toBeUndefined()
  })

  it('still BLOCKS a promise backed only by dispatch_agent, which never reports back', () => {
    // Looks like a continuation mechanism and is not one. dispatch_agent runs on a
    // separate ephemeral substrate and its completion reporter here is a bare log
    // line (open/composer.ts:999-1004) — nothing re-enters the session and nothing
    // reaches the owner. Accepting it would wave through the exact stranding this
    // gate exists to catch, so it is pinned as a BLOCK.
    const path = writeTranscript('promise-dispatch', [
      channelUser('research the options', 'user="sam"'),
      assistantOtherToolCall('mcp__neutron__dispatch_agent'),
      assistantReplyText("Digging into it — I'll follow up with what I find."),
    ])
    const out = runHook({ transcript_path: path, session_id: 'promise-7' })
    expect(out.decision).toBe('block')
  })

  // --- DELIVERY SEMANTICS ---------------------------------------------------

  it('evaluates the FIRST reply — the only one the substrate actually delivers', () => {
    // The substrate settles a turn on the first correlated reply and closes the
    // channel (repl-session.ts:280-290), rejecting every later one (:269). So a
    // "promise, then deliver in a second reply" turn does NOT reach the owner with
    // the result — they are left on the promise. Reading the LAST reply (Nova's
    // rule, correct for its streaming delivery) would clear this turn and hide the
    // exact bug the gate exists to catch.
    const path = writeTranscript('promise-first-wins', [
      channelUser('the suite is red', 'user="sam"'),
      assistantReplyText('Re-running the suite now, one sec.', 'toolu_r1'),
      assistantOtherToolCall('Bash'),
      assistantReplyText('Done — all 40 pass.', 'toolu_r2'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'promise-8' })
    expect(out.decision).toBe('block')
  })

  it('does not regress the no-reply-at-all gate', () => {
    const path = writeTranscript('promise-no-reply-still-blocks', [
      channelUser('do a thing', 'user="sam"'),
      assistantText('Re-running the suite now.'),
    ])
    const out = runHook({ transcript_path: path, session_id: 'promise-9' })
    expect(out.decision).toBe('block')
    expect((out.reason ?? '').toLowerCase()).toContain('invisible')
  })
})
