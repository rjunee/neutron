/**
 * scripts/ci/trident-verdict.test.ts — the mutation-shaped proof for the
 * `trident-verdict` gate.
 *
 * Every test here is written so a named mutant of the gate makes it fail. The
 * mutants proved by hand before this landed, each caught by the test named in
 * the comment beside it:
 *
 *   1. accept a PR with no verdict comment          → `rejects a hand-rolled PR …`
 *   2. compare the verdict to the BRANCH, not the SHA → `a verdict for an OLD sha …`
 *   3. treat `codex.ran: yes (backgrounded)` as true → `only the literal true …`
 *   4. last-line-wins on a duplicate key             → `a duplicate key is a contradiction`
 *   5. drop the redeeming command from the failure    → `every failure path prints …`
 *   6. let an empty `TRIDENT_BYPASS=` through         → `an empty bypass reason …`
 *   7. believe a negative from a broken lookup        → `a broken lookup is its own outcome`
 *
 * The subject is `runGate` — the REAL call site — with the GitHub API faked at
 * the `fetchJson` seam, not only the pure helpers. A test that exercises only
 * `parseVerdict` would stay green through mutants 1, 5 and 7.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CONTROL_COMMENT,
  CONTROL_HEAD_SHA,
  parseVerdict,
  readBypass,
  redeemCommand,
  runGate,
  selfTest,
  touchesGatedSurface,
  VerdictError,
  verdictFailures,
  type GateDeps,
} from './trident-verdict.ts'

const HEAD = 'b'.repeat(40)
const OLD = 'c'.repeat(40)
const BRANCH = 'trident/some-work'
const PR = '123'

function verdictBlock(sha: string, over: Partial<Record<string, string>> = {}, withMutation = true): string {
  const rows: Record<string, string> = {
    commit: sha,
    'codex.ran': 'true',
    'codex.blocking': '0',
    'adversarial.ran': 'true',
    'adversarial.blocking': '0',
    ...over,
  }
  const lines = ['```review-evidence', ...Object.entries(rows).map(([k, v]) => `${k}: ${v}`)]
  if (withMutation) {
    lines.push('- mutant: dropped the sha comparison', '  red: gate accepted a stale verdict', '  control: 12/12 green')
  }
  lines.push('```')
  return lines.join('\n')
}

interface Harness {
  deps: GateDeps
  output: () => string
}

function harness(opts: {
  comments?: string[]
  files?: string[]
  commitMessage?: string
  env?: Record<string, string | undefined>
  control?: (() => { ok: boolean; detail: string }) | undefined
}): Harness {
  const lines: string[] = []
  const comments = (opts.comments ?? []).map((body) => ({ body }))
  const files = (opts.files ?? ['open/composer.ts']).map((filename) => ({ filename }))
  const deps: GateDeps = {
    env: {
      GITHUB_REPOSITORY: 'example-org/example-repo',
      PR_NUMBER: PR,
      PR_HEAD_SHA: HEAD,
      PR_HEAD_REF: BRANCH,
      ...opts.env,
    },
    log: (line) => {
      lines.push(line)
    },
    control: opts.control,
    fetchJson: async (path) => {
      if (path.startsWith('repos/example-org/example-repo/commits/')) {
        return { commit: { message: opts.commitMessage ?? 'fix: something\n' } }
      }
      // Page 1 returns everything; page 2+ returns [] (the paginator stops on a
      // short page, so page 1 alone is enough for these sizes).
      const page = /[?&]page=(\d+)/.exec(path)?.[1] ?? '1'
      if (page !== '1') return []
      if (path.includes('/pulls/')) return files
      if (path.includes('/comments')) return comments
      throw new Error(`unexpected path ${path}`)
    },
  }
  return { deps, output: () => lines.join('\n') }
}

// --------------------------------------------------------------------------- //
// MUTANT 1 + the SHA keying (MUTANT 2)
// --------------------------------------------------------------------------- //

describe('the gate rejects an unreviewed PR and accepts a reviewed one', () => {
  test('rejects a hand-rolled PR with no verdict for its head SHA', async () => {
    const h = harness({ comments: ['LGTM, merging this one by hand'] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('no trident verdict recorded')
    expect(h.output()).toContain(HEAD)
  })

  test('accepts a verdict recorded for the CORRECT head SHA', async () => {
    const h = harness({ comments: [verdictBlock(HEAD)] })
    expect(await runGate(h.deps)).toBe(0)
    expect(h.output()).toContain('trident-verdict: PASS')
    expect(h.output()).toContain('1 mutation(s) named')
  })

  test('a verdict for an OLD sha does NOT satisfy a newer head — a fix commit forces a fresh round', async () => {
    const h = harness({ comments: [verdictBlock(OLD)] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('the reviewed tree is not the tree being merged')
    // Named by prefix so the failure says WHICH tree was reviewed.
    expect(h.output()).toContain(OLD.slice(0, 12))
  })

  test('the newest verdict wins, so a re-review supersedes a stale one', async () => {
    const h = harness({ comments: [verdictBlock(OLD), 'discussion', verdictBlock(HEAD)] })
    expect(await runGate(h.deps)).toBe(0)
  })

  test('a stale verdict posted AFTER a good one is what the gate reads (newest wins, both ways)', async () => {
    const h = harness({ comments: [verdictBlock(HEAD), verdictBlock(OLD)] })
    expect(await runGate(h.deps)).toBe(1)
  })

  test('a comment that merely QUOTES a block does not compete for newest', async () => {
    const quoted = verdictBlock(OLD)
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
    const h = harness({ comments: [verdictBlock(HEAD), `re-posting for context:\n${quoted}`] })
    expect(await runGate(h.deps)).toBe(0)
  })

  test('an indented opening fence above a column-0 closing fence is not a verdict either', async () => {
    const sloppy = ['  ```review-evidence', `commit: ${OLD}`, 'codex.ran: true', '```'].join('\n')
    const h = harness({ comments: [verdictBlock(HEAD), sloppy] })
    expect(await runGate(h.deps)).toBe(0)
  })
})

// --------------------------------------------------------------------------- //
// MUTANT 3 + 4 — parser strictness, through the real call site
// --------------------------------------------------------------------------- //

describe('a verdict cannot be faked by a hedge or a contradiction', () => {
  test('only the literal `true` counts as ran', async () => {
    for (const hedge of ['yes (backgrounded)', 'pending', 'probably', 'True', 'TRUE']) {
      const h = harness({ comments: [verdictBlock(HEAD, { 'codex.ran': hedge })] })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('codex.ran is not the literal `true`')
    }
  })

  test('unresolved blocking findings fail even when both passes ran', async () => {
    const h = harness({ comments: [verdictBlock(HEAD, { 'adversarial.blocking': '2' })] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('2 unresolved adversarial P0/P1')
  })

  test('a duplicate key is a contradiction, not an update', () => {
    const body = ['```review-evidence', `commit: ${HEAD}`, 'codex.blocking: 2', 'codex.blocking: 0', '```'].join('\n')
    expect(() => parseVerdict(body)).toThrow(VerdictError)
    expect(() => parseVerdict(body)).toThrow(/duplicate key/)
  })

  test('two blocks in one comment is an error rather than a pick', () => {
    expect(() => parseVerdict(`${verdictBlock(HEAD)}\n${verdictBlock(OLD)}`)).toThrow(/expected exactly 1/)
  })

  test('a truncated or prose commit value can never equal a head SHA', () => {
    expect(() => parseVerdict(verdictBlock('b'.repeat(12)))).toThrow(/full 40-hex/)
    expect(() => parseVerdict(verdictBlock('the tip of my branch'))).toThrow(/full 40-hex/)
  })

  test('an unfilled template posted at column 0 cannot satisfy the mutation requirement', async () => {
    // The gate PRINTS a fill-in template, and the doc contains one too. Indenting
    // is what stops the printed copy from parsing — but a copy taken from the doc
    // and pasted at column 0 parses fine, and every scalar it carries is caught by
    // a type rule (a placeholder `commit` is not 40-hex, a placeholder count is not
    // an integer). The MUTATION entry has no type rule: its values are free text.
    // So `<...>` rejection is the only thing standing between a pasted template
    // and a satisfied mutation-evidence clause. Discovered by a surviving mutant —
    // the "own output pasted back" test could not see this, because that output
    // never gets as far as the placeholder check.
    const body = [
      '```review-evidence',
      `commit: ${HEAD}`,
      'codex.ran: true',
      'codex.blocking: 0',
      'adversarial.ran: true',
      'adversarial.blocking: 0',
      '- mutant: <what production behaviour you broke>',
      '  red: <the test that went RED, with its observed failure>',
      '  control: <the test that stayed GREEN unmutated>',
      '```',
    ].join('\n')
    expect(() => parseVerdict(body)).toThrow(/unfilled template placeholder/)
    const h = harness({ comments: [body] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('unfilled template placeholder')
  })

  test('a placeholder scalar is rejected as a placeholder, not merely as the wrong type', () => {
    const body = [
      '```review-evidence',
      `commit: ${HEAD}`,
      'codex.ran: <true>',
      'codex.blocking: 0',
      'adversarial.ran: true',
      'adversarial.blocking: 0',
      '```',
    ].join('\n')
    expect(() => parseVerdict(body)).toThrow(/unfilled template placeholder/)
  })

  test("the doc's own example template does not parse as a verdict either", () => {
    const doc = read('docs/trident-verdict-gate.md')
    const fenced = /^```review-evidence[\s\S]*?^```$/m.exec(doc)
    expect(fenced).not.toBeNull()
    expect(() => parseVerdict(fenced![0])).toThrow()
  })

  test('a malformed block is reported as malformed, not as absent', async () => {
    const h = harness({ comments: ['```review-evidence\nthis is not a verdict\n```'] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('malformed verdict block')
  })
})

describe('mutation evidence is owed by executable surface, not by prose', () => {
  test('an executable change with no mutation named fails', async () => {
    const h = harness({ comments: [verdictBlock(HEAD, {}, false)], files: ['gateway/http/chat-bridge.ts'] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('no mutation evidence')
  })

  test('a prose-only change with no mutation named passes', async () => {
    const h = harness({
      comments: [verdictBlock(HEAD, {}, false)],
      files: ['docs/AS_BUILT.md', 'docs/as-built/2026-01-01-thing.md'],
    })
    expect(await runGate(h.deps)).toBe(0)
  })

  test('classification: what is gated and what is deliberately not', () => {
    for (const gated of [
      'open/composer.ts',
      'scripts/run-tests.sh',
      '.github/workflows/ci.yml',
      '.githooks/pre-push',
      'package.json',
      'app/components/Thing.tsx',
    ]) {
      expect(touchesGatedSurface(gated)).toBe(true)
    }
    for (const exempt of [
      'docs/SYSTEM-OVERVIEW.md',
      'README.md',
      'open/__tests__/route-slot-coverage.test.ts',
      'scripts/ci/trident-verdict.test.ts',
      'bun.lock',
      'app/assets/icon.png',
    ]) {
      expect(touchesGatedSurface(exempt)).toBe(false)
    }
  })
})

// --------------------------------------------------------------------------- //
// MUTANT 5 — the redeeming message. This is the requirement the gate exists for.
// --------------------------------------------------------------------------- //

describe('the failure REDEEMS the branch into a review lane', () => {
  const failing: { name: string; make: () => Harness }[] = [
    { name: 'no verdict at all', make: () => harness({ comments: [] }) },
    { name: 'a verdict for an old sha', make: () => harness({ comments: [verdictBlock(OLD)] }) },
    { name: 'a hedged ran field', make: () => harness({ comments: [verdictBlock(HEAD, { 'codex.ran': 'pending' })] }) },
    { name: 'a malformed block', make: () => harness({ comments: ['```review-evidence\nnope\n```'] }) },
    {
      name: 'a bypass with no reason',
      make: () => harness({ comments: [], commitMessage: 'fix: thing\n\nTRIDENT_BYPASS=\n' }),
    },
  ]

  for (const { name, make } of failing) {
    test(`every failure path prints the command that reviews THIS branch — ${name}`, async () => {
      const h = make()
      expect(await runGate(h.deps)).toBe(1)
      const out = h.output()
      // The exact command, with this branch and this PR filled in.
      expect(out).toContain(redeemCommand({ branch: BRANCH, prNumber: PR }))
      expect(out).toContain(`branch=${BRANCH}`)
      expect(out).toContain(`prNumber=${PR}`)
      // And the promise that makes it safe to run.
      expect(out).toContain('REUSES this')
      expect(out).toContain('will not open a duplicate')
    })
  }

  test('the failure names THIS run to re-trigger, not a generic gesture at one', async () => {
    // A verdict posted after the run finished is correct and invisible — nothing
    // re-triggers on a comment. The run id is already in the environment, so it
    // goes into the output rather than being left as an exercise.
    const h = harness({ comments: [], env: { GITHUB_RUN_ID: '987654321' } })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('gh run rerun --failed 987654321')
  })

  test('the command names the arguments the review loop actually takes', () => {
    const cmd = redeemCommand({ branch: BRANCH, prNumber: 7 })
    expect(cmd.startsWith('/trident v2 ')).toBe(true)
    expect(cmd).toContain(`branch=${BRANCH}`)
    expect(cmd).toContain('prNumber=7')
    expect(cmd).toContain('reuse its PR')
    expect(cmd).toContain('do not restart from scratch')
  })

  test('an unknown branch or PR degrades to a placeholder rather than a wrong value', () => {
    const cmd = redeemCommand({ branch: null, prNumber: '' })
    expect(cmd).toContain('branch=<this branch>')
    expect(cmd).toContain('prNumber=<the PR number>')
  })

  test("the gate's own FAIL output, pasted back as a comment, still fails", async () => {
    const h = harness({ comments: [] })
    expect(await runGate(h.deps)).toBe(1)
    const failOutput = h.output()
    // The template it printed must not parse as a verdict…
    expect(() => parseVerdict(failOutput)).toThrow()
    // …and feeding the whole thing back as the newest comment must not pass.
    const again = harness({ comments: [failOutput] })
    expect(await runGate(again.deps)).toBe(1)
  })

  test("the gate's own FAIL output, pasted into a commit message, does not arm the bypass", async () => {
    const h = harness({ comments: [] })
    await runGate(h.deps)
    expect(readBypass(h.output()).kind).toBe('none')
  })
})

// --------------------------------------------------------------------------- //
// MUTANT 6 — the bypass leaves a paper trail and is never empty
// --------------------------------------------------------------------------- //

describe('TRIDENT_BYPASS is allowed, recorded, and never empty', () => {
  test('a real reason merges and the reason is echoed into the check output', async () => {
    const h = harness({
      comments: [],
      commitMessage: 'ops: rotate the expired signing key\n\nTRIDENT_BYPASS=key expiry, the review lane is slower than the outage\n',
    })
    expect(await runGate(h.deps)).toBe(0)
    expect(h.output()).toContain('BYPASSED')
    expect(h.output()).toContain('key expiry, the review lane is slower than the outage')
    // A GitHub annotation, so it is visible without opening the log.
    expect(h.output()).toContain('::notice title=trident-verdict bypassed::')
  })

  test('an empty bypass reason is not a bypass', async () => {
    for (const message of ['x\n\nTRIDENT_BYPASS=\n', 'x\n\nTRIDENT_BYPASS=   \n']) {
      const h = harness({ comments: [], commitMessage: message })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('carries no reason')
    }
  })

  test('an unfilled placeholder reason is not a bypass', () => {
    expect(readBypass('x\n\nTRIDENT_BYPASS=<why this one cannot wait>\n')).toEqual({
      kind: 'invalid',
      detail: 'TRIDENT_BYPASS reason is an unfilled placeholder ("<why this one cannot wait>")',
    })
  })

  test('a reason with nothing readable in it is not a bypass', () => {
    expect(readBypass('x\n\nTRIDENT_BYPASS=1\n').kind).toBe('invalid')
    expect(readBypass('x\n\nTRIDENT_BYPASS=-\n').kind).toBe('invalid')
  })

  test('two markers is a contradiction, not a pick', () => {
    const outcome = readBypass('x\n\nTRIDENT_BYPASS=one thing\nTRIDENT_BYPASS=another thing\n')
    expect(outcome.kind).toBe('invalid')
  })

  test('an indented marker does not arm it — the hatch is column-0 only', () => {
    expect(readBypass('x\n\n    TRIDENT_BYPASS=pasted from a CI log\n').kind).toBe('none')
  })

  test('the bypass is keyed to the head commit, so a NEW commit needs a new marker', async () => {
    // The gate reads the message of PR_HEAD_SHA. A marker that lived on an
    // earlier commit is simply not in this message.
    const h = harness({ comments: [], commitMessage: 'fix: follow-up commit with no marker\n' })
    expect(await runGate(h.deps)).toBe(1)
  })
})

// --------------------------------------------------------------------------- //
// MUTANT 7 — the positive control
// --------------------------------------------------------------------------- //

describe('the lookup proves it can return a POSITIVE before any negative is believed', () => {
  test('the known-good fixture parses and clears the bar', () => {
    const result = selfTest()
    expect(result.ok).toBe(true)
    const parsed = parseVerdict(CONTROL_COMMENT)
    expect(parsed.commit).toBe(CONTROL_HEAD_SHA)
    expect(verdictFailures(parsed, CONTROL_HEAD_SHA, { touchesSource: true })).toEqual([])
  })

  test('a broken lookup is its own outcome, never reported as "no verdict"', async () => {
    const h = harness({
      comments: [verdictBlock(HEAD)],
      control: () => ({ ok: false, detail: 'the fence regex matched nothing' }),
    })
    expect(await runGate(h.deps)).toBe(1)
    const out = h.output()
    expect(out).toContain('THE LOOKUP IS BROKEN')
    expect(out).toContain('the fence regex matched nothing')
    // The distinction is the whole point: it must NOT claim the PR has no verdict.
    expect(out).not.toContain('no trident verdict recorded')
  })

  test('a broken lookup is red even when a real verdict is present', async () => {
    const h = harness({ comments: [verdictBlock(HEAD)], control: () => ({ ok: false, detail: 'broken' }) })
    expect(await runGate(h.deps)).toBe(1)
  })
})

// --------------------------------------------------------------------------- //
// Fail-closed on a misconfigured invocation
// --------------------------------------------------------------------------- //

describe('a misconfigured gate is red, never green', () => {
  test('an absent PR number fails closed rather than reporting nothing to gate', async () => {
    const h = harness({ comments: [verdictBlock(HEAD)], env: { PR_NUMBER: undefined } })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('PR_NUMBER is absent')
  })

  test('a non-numeric PR number fails closed', async () => {
    const h = harness({ comments: [], env: { PR_NUMBER: '12; rm -rf /' } })
    expect(await runGate(h.deps)).toBe(1)
  })

  test('an absent or partial head SHA fails closed', async () => {
    for (const sha of [undefined, 'b'.repeat(12), 'HEAD']) {
      const h = harness({ comments: [verdictBlock(HEAD)], env: { PR_HEAD_SHA: sha } })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('PR_HEAD_SHA')
    }
  })

  test('an absent repository fails closed', async () => {
    const h = harness({ comments: [], env: { GITHUB_REPOSITORY: undefined } })
    expect(await runGate(h.deps)).toBe(1)
  })
})

// --------------------------------------------------------------------------- //
// Wiring — a gate nothing runs is not a gate
// --------------------------------------------------------------------------- //

const REPO_ROOT = new URL('../..', import.meta.url)
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, REPO_ROOT)), 'utf8')

describe('the gate is actually wired into CI and into the pre-push hook', () => {
  const ci = read('.github/workflows/ci.yml')

  test('ci.yml defines a trident-verdict job that runs the gate script', () => {
    expect(ci).toMatch(/^ {2}trident-verdict:\s*$/m)
    expect(ci).toContain('scripts/ci/trident-verdict.ts')
  })

  test('the job only ever runs on a pull_request, so no other event can mint a green one', () => {
    const job = ci.slice(ci.indexOf('  trident-verdict:'))
    expect(job).toContain("if: github.event_name == 'pull_request'")
  })

  test('it passes the PR HEAD sha, not the ephemeral merge commit', () => {
    // github.sha on a pull_request event is the merge commit, which no reviewer
    // examined. Keying on it would make every verdict stale by construction.
    expect(ci).toContain('PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}')
    expect(ci).not.toMatch(/PR_HEAD_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/)
  })

  test('the required `test` aggregator needs it, so the gate is blocking rather than advisory', () => {
    // `test` is the required status context on this repo, so riding it is what
    // makes this enforceable without a branch-protection change.
    expect(ci).toMatch(/needs:\s*\[[^\]]*trident-verdict[^\]]*\]/)
    expect(ci).toContain('needs.trident-verdict.result')
  })

  test('the aggregator demands success on a PR — a skipped verdict job cannot satisfy it', () => {
    const aggregator = ci.slice(ci.indexOf('\n  test:'))
    // The verdict is consulted only on a pull_request (a push to main has no PR
    // to read one for), and `success` is DEMANDED there — so `skipped` fails the
    // required context instead of satisfying it, which is the inversion of what a
    // required check normally does with a skip.
    expect(aggregator).toMatch(/github\.event_name\s*\}\}"\s*=\s*"pull_request"/)
    expect(aggregator).toMatch(/needs\.trident-verdict\.result\s*\}\}"\s*!=\s*"success"/)
    expect(aggregator).toMatch(/exit 1/)
  })

  test('the pre-push hook WARNS with the same command and never blocks the push', () => {
    const hook = read('.githooks/pre-push')
    // Single source: the hook asks the gate for the command instead of carrying a
    // second copy that would drift out of agreement with the CI output.
    expect(hook).toContain('--redeem-command')
    expect(hook).toContain('scripts/ci/trident-verdict.ts')
    // It must not hand-copy the command text.
    expect(hook).not.toContain('/trident v2 repo=')
    // The advisory block must not be able to change the push's exit status.
    const advisory = hook.slice(hook.indexOf('trident-verdict advisory'))
    expect(advisory).not.toMatch(/\bexit\s+1\b/)
    expect(advisory).not.toContain('STATUS=')
  })
})
