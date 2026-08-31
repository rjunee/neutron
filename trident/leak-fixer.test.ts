/**
 * Unit — trident/leak-fixer.ts, the agent-backed reword turn behind the purity
 * preflight.
 *
 * Pins the terminal-marker protocol (REWORDED / CANNOT-FIX, with CANNOT-FIX
 * winning over a stray REWORDED), the conservative not-fixed fallback on every
 * crash / timeout / silence / start failure, the scratch-worktree rooting, and —
 * the guard that matters most here — that the STATIC prompt template carries no
 * banned vocabulary of its own: the gate's rule ids reach the turn only as
 * runtime data interpolated from findings.
 *
 * NOTE: the rule id this suite's fixtures name embeds the six-letter retired
 * multi-org word that `scripts/ci/leak-gate.sh:367` / `:387` ban anywhere in a
 * committed file. It is assembled from FRAGMENTS at runtime (below), never
 * written as a literal, so this suite's own source stays silent under the very
 * gate it models — the discipline `scripts/ci/leak-gate-selftest.test.ts`
 * established and `trident/leak-preflight.test.ts` follows.
 */

import { describe, expect, test } from 'bun:test'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { buildReplArgv } from '@neutronai/runtime/adapters/claude-code/persistent/build-repl-argv.ts'
import { RESOLVER_TOOL_NAMES } from './conflict-resolver.ts'
import { DEFAULT_TIMEOUT_MS } from './liveness.ts'
import { buildLeakPreflightFixer } from './leak-fixer.ts'

// ── Fixtures ─────────────────────────────────────────────────────────────────
const T2 = 'ten' + 'ant'
const RULE_W = `${T2}-word`
const PLAN_DOC = '.trident/plans/trident/x.md'
const WORKTREE = 'repos/neutron-leak-scan'

const fixInput = () => ({
  worktree: WORKTREE,
  branch: 'trident/example',
  findings: [{ rule: RULE_W, file: PLAN_DOC, line: 7 }],
  attempt: 1,
})

const completion = (): Event => ({
  kind: 'completion',
  usage: { input_tokens: 1, output_tokens: 1 },
  substrate_instance_id: 'mock',
})

/** A mocked per-cwd substrate factory that replays a scripted terminal text. */
function scriptedFactory(
  text: string,
  opts: { throwOnStart?: boolean; hang?: boolean; errorEvent?: boolean } = {},
): { build: (cwd: string) => Substrate; cwds: string[]; specs: AgentSpec[] } {
  const cwds: string[] = []
  const specs: AgentSpec[] = []
  const build = (cwd: string): Substrate => {
    cwds.push(cwd)
    return {
      start(spec: AgentSpec): SessionHandle {
        specs.push(spec)
        if (opts.throwOnStart === true) throw new Error('cold start failed')
        let cancelSignal: (() => void) | null = null
        const cancelled = new Promise<void>((r) => {
          cancelSignal = r
        })
        async function* gen(): AsyncGenerator<Event> {
          yield { kind: 'token', text }
          if (opts.errorEvent === true) {
            yield { kind: 'error', message: 'repl died', retryable: false }
            return
          }
          if (opts.hang === true) {
            await cancelled
            return
          }
          yield completion()
        }
        return {
          events: gen(),
          async respondToTool(): Promise<void> {
            throw new Error('no tools')
          },
          async cancel(): Promise<void> {
            if (cancelSignal !== null) cancelSignal()
          },
          tool_resolution: 'internal',
        }
      },
    }
  }
  return { build, cwds, specs }
}

describe('buildLeakPreflightFixer', () => {
  test('REWORDED → fixed:true; substrate rooted at the scratch worktree; the file/shell tool grant; the finding interpolated', async () => {
    const f = scriptedFactory('...work...\nREWORDED')
    const fix = buildLeakPreflightFixer({ build_substrate: f.build })
    const out = await fix(fixInput())
    expect(out).toEqual({ fixed: true })
    // Built once, rooted at the preflight's throwaway scan worktree.
    expect(f.cwds).toEqual([WORKTREE])
    // #361 — an empty grant ships a toolless `--tools ""` subprocess that cannot
    // open, edit or `git add` the flagged file.
    expect(f.specs[0]!.tools.map((t) => t.name)).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'Bash',
    ])
    expect(f.specs[0]!.tools.length).toBeGreaterThan(0)

    const prompt = f.specs[0]!.prompt
    // The finding — rule id, file, line — reaches the turn as runtime data.
    expect(prompt).toContain(`[${RULE_W}] ${PLAN_DOC}:7`)
    // The tree it is actually standing in, and the confinement that goes with an
    // unsandboxed Edit/Write/Bash grant on a shared box.
    expect(prompt).toContain('THROWAWAY, DETACHED')
    expect(prompt).toContain('STAY INSIDE YOUR CWD')
    expect(prompt).toContain(WORKTREE)
    expect(prompt).toContain("Do NOT run the project's test suite")
    // THE FOUR PROHIBITIONS, in the rendered prompt. A reword is a reword: the
    // cheap ways to make a scanner quiet — delete the file, delete the section,
    // edit the scanner — are each named and refused.
    expect(prompt).toContain('never delete a file')
    expect(prompt).toContain('never drop a plan doc\'s "Do not" section')
    // The gate is right; the prose is wrong — never "fix" the scanner.
    expect(prompt).toContain('Never touch `scripts/ci/leak-gate.sh`')
    expect(prompt).toContain('leak-gate-allowlist.txt')
    // Stage only; the outer preflight commits (and owns the compare-and-swap).
    expect(prompt).toContain('`git add` EVERY reworded file')
    expect(prompt).toContain('Do NOT `git commit`')
    // …and the prompt says the caller AUDITS the index, because it does: the same four
    // prohibitions are enforced mechanically in `leak-preflight.ts` before anything is committed.
    expect(prompt).toContain('THE CALLER AUDITS THE INDEX')
    expect(prompt).toContain('CANNOT-FIX')
    expect(prompt).toContain('attempt 1 of at most 2')
    expect(f.specs[0]!.model_preference.length).toBeGreaterThan(0)
  })

  /**
   * THE SELF-REFERENTIAL GUARD. This module's prompt is prose the builder may
   * echo into committed bytes (a plan doc, an as-built note, a log the gate
   * scans). If the STATIC template named the banned vocabulary — even to warn
   * against it — the fixer would re-seed the exact violation it exists to
   * remove, which is precisely how the 2026-08-31 reds were authored. So the
   * root may enter the prompt ONLY as interpolated finding data.
   */
  test('the static prompt template never carries the banned root; it enters only as runtime finding data', async () => {
    const neutral = scriptedFactory('REWORDED')
    const fixNeutral = buildLeakPreflightFixer({ build_substrate: neutral.build })
    await fixNeutral({
      worktree: WORKTREE,
      branch: 'trident/example',
      findings: [{ rule: 'secret-scan', file: 'notes.md', line: 3 }],
      attempt: 1,
    })
    expect(neutral.specs[0]!.prompt.includes(T2)).toBe(false)

    // With a real gate rule id in the findings it appears — once, via the
    // interpolated finding line.
    const real = scriptedFactory('REWORDED')
    const fixReal = buildLeakPreflightFixer({ build_substrate: real.build })
    await fixReal(fixInput())
    expect(real.specs[0]!.prompt.includes(T2)).toBe(true)
  })

  test('CANNOT-FIX: <reason> → fixed:false with the reason as note', async () => {
    const f = scriptedFactory('looked at it.\nCANNOT-FIX: every finding is in COMMIT-MESSAGE')
    const fix = buildLeakPreflightFixer({ build_substrate: f.build })
    const out = await fix(fixInput())
    expect(out.fixed).toBe(false)
    expect(out.note).toContain('COMMIT-MESSAGE')
  })

  test('CANNOT-FIX wins over a stray REWORDED', async () => {
    const f = scriptedFactory('REWORDED maybe?\nCANNOT-FIX: the sentence loses its meaning')
    const fix = buildLeakPreflightFixer({ build_substrate: f.build })
    const out = await fix(fixInput())
    expect(out.fixed).toBe(false)
    expect(out.note).toContain('loses its meaning')
  })

  test('no clear marker → not fixed, conservatively', async () => {
    const f = scriptedFactory('I edited some files, probably fine.')
    const fix = buildLeakPreflightFixer({ build_substrate: f.build })
    const out = await fix(fixInput())
    expect(out.fixed).toBe(false)
    expect(out.note).toMatch(/no clear result/)
  })

  test('a substrate that fails to start → not fixed (and never throws)', async () => {
    const f = scriptedFactory('REWORDED', { throwOnStart: true })
    const fix = buildLeakPreflightFixer({ build_substrate: f.build })
    const out = await fix(fixInput())
    expect(out.fixed).toBe(false)
    expect(out.note).toMatch(/could not start/)
  })

  test('an error event → not fixed', async () => {
    const f = scriptedFactory('partway through...', { errorEvent: true })
    const fix = buildLeakPreflightFixer({ build_substrate: f.build })
    const out = await fix(fixInput())
    expect(out.fixed).toBe(false)
    expect(out.note).toMatch(/errored/)
  })

  test('a timeout cancels the turn → not fixed', async () => {
    const f = scriptedFactory('REWORDED', { hang: true })
    let fire: () => void = () => {}
    const fix = buildLeakPreflightFixer({
      build_substrate: f.build,
      timeout_ms: 1000,
      set_timer: (fn) => {
        fire = fn
        return 1
      },
      clear_timer: () => {},
    })
    const p = fix(fixInput())
    // Trip the timeout immediately.
    fire()
    const out = await p
    expect(out.fixed).toBe(false)
    expect(out.note).toMatch(/timed out/)
  })

  test('the turn budget is the resolver\'s, and an explicit one is passed through', async () => {
    // (b) of the boundary contract: the wall-clock ceiling the fixer arms is the
    // SAME constant the conflict resolver arms — one bounded turn, one budget —
    // and an injected override reaches the timer verbatim.
    const seen: number[] = []
    const f = scriptedFactory('REWORDED')
    const fixDefault = buildLeakPreflightFixer({
      build_substrate: f.build,
      set_timer: (_fn, ms) => {
        seen.push(ms)
        return 1
      },
      clear_timer: () => {},
    })
    expect(await fixDefault(fixInput())).toEqual({ fixed: true })
    expect(seen).toEqual([DEFAULT_TIMEOUT_MS])

    const g = scriptedFactory('REWORDED')
    const fixExplicit = buildLeakPreflightFixer({
      build_substrate: g.build,
      timeout_ms: 90_000,
      set_timer: (_fn, ms) => {
        seen.push(ms)
        return 2
      },
      clear_timer: () => {},
    })
    expect(await fixExplicit(fixInput())).toEqual({ fixed: true })
    expect(seen).toEqual([DEFAULT_TIMEOUT_MS, 90_000])
  })

  test('an over-long CANNOT-FIX reason is capped', async () => {
    const f = scriptedFactory(`CANNOT-FIX: ${'x'.repeat(1000)}`)
    const fix = buildLeakPreflightFixer({ build_substrate: f.build })
    const out = await fix(fixInput())
    expect(out.fixed).toBe(false)
    expect(out.note!.length).toBeLessThanOrEqual(300)
  })

  // THE regression guard for #361 — DO NOT MOCK PAST THE SEAM. A spy substrate
  // runs the spec's declared tools through the REAL `buildReplArgv` (the exact
  // prod function that turns `spec.tools.map(t => t.name)` into the spawned
  // `claude`'s `--tools` flag). A regression to `tools: []` becomes
  // `--tools ""` — a subprocess that cannot reword anything — and fails here.
  test('#361 the declared tool grant reaches the launch boundary → real `--tools Read,Glob,Grep,Edit,Write,Bash`', async () => {
    let launchedArgv: string[] | null = null
    const spyBuild = (cwd: string): Substrate => ({
      start(spec: AgentSpec): SessionHandle {
        launchedArgv = buildReplArgv({
          sessionId: 'sess',
          resume: false,
          channelName: 'ch',
          mcpConfigPath: '/tmp/mcp.json',
          settingsPath: '/tmp/settings.json',
          appendSystemPromptFile: '/tmp/agent.md',
          model: spec.model_preference[0] ?? 'opus',
          addDir: cwd,
          tools: spec.tools.map((t) => t.name),
          skipPermissions: true,
        })
        async function* gen(): AsyncGenerator<Event> {
          yield { kind: 'token', text: 'REWORDED' }
          yield completion()
        }
        return {
          events: gen(),
          async respondToTool(): Promise<void> {},
          async cancel(): Promise<void> {},
          tool_resolution: 'internal',
        }
      },
    })

    const fix = buildLeakPreflightFixer({ build_substrate: spyBuild })
    const out = await fix(fixInput())
    expect(out).toEqual({ fixed: true })

    expect(launchedArgv).not.toBeNull()
    const argv = launchedArgv as unknown as string[]
    const toolsIdx = argv.indexOf('--tools')
    expect(toolsIdx).toBeGreaterThanOrEqual(0)
    const toolsValue = argv[toolsIdx + 1]
    expect(toolsValue).toBe('Read,Glob,Grep,Edit,Write,Bash')
    expect(toolsValue).not.toBe('')
    expect(toolsValue).toBe(RESOLVER_TOOL_NAMES.join(','))
  })
})
