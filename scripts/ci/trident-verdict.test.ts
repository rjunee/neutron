/**
 * scripts/ci/trident-verdict.test.ts — the mutation-shaped proof for the
 * `trident-verdict` gate.
 *
 * Every test here is written so a named mutant of the gate makes it fail, and the
 * mutant table lives in the as-built entry
 * (`docs/as-built/2026-08-10-trident-verdict-gate.md`) with the test each one
 * reds. It is written there rather than here because THIS FILE'S FIRST VERSION
 * CLAIMED SEVENTEEN MUTANTS "EACH CAUGHT" AND THREE OF THEM SURVIVED — the
 * pagination terminator, the negative-count guard and the empty-mutation-field
 * guard, all three guards with code and no test. A coverage claim written in a
 * docblock is a claim; the battery is a script whose result is reproducible.
 *
 * The subject is `runGate` — the REAL call site — with the GitHub API faked at
 * the `fetchJson` seam, not only the pure helpers. A test that exercises only
 * `parseVerdict` stays green through most of the table.
 *
 * ONE STRUCTURAL WARNING, from the defect that cost the most here. The
 * `every failure path prints …` cases are a TABLE with a universal NAME, and the
 * first version of that table omitted four real failure paths while its name
 * asserted it covered all of them. A universal claim in a test name is only as
 * true as the table under it. When adding a failure path to the gate, add its row.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CONTROL_COMMENT,
  CONTROL_HEAD_SHA,
  DISPATCHER_PARSED_FLAGS,
  filesTouchGatedSurface,
  isTrustedAuthor,
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

/** A comment as the issue-comments endpoint returns it. */
type ApiComment = { body: string; author_association?: string | undefined }
/** A changed file as the pulls/files endpoint returns it. */
type ApiFile = { filename?: string | undefined; previous_filename?: string | undefined }

/**
 * `OWNER` by default, because that is what the review loop posts as and the
 * overwhelming majority of these cases are about the verdict's CONTENT. The
 * author-trust cases pass it explicitly.
 */
function asComments(input: (string | ApiComment)[]): ApiComment[] {
  return input.map((c) => (typeof c === 'string' ? { body: c, author_association: 'OWNER' } : c))
}

function harness(opts: {
  comments?: (string | ApiComment)[]
  /** Pages of comments, for the paginator. Overrides `comments`. */
  commentPages?: ApiComment[][]
  files?: (string | ApiFile)[]
  /** Pages of files, for the paginator. Overrides `files`. */
  filePages?: ApiFile[][]
  /** What the PR endpoint reports. Defaults to the real length of the file list. */
  changedFiles?: unknown
  commitMessage?: string
  env?: Record<string, string | undefined>
  control?: (() => { ok: boolean; detail: string }) | undefined
}): Harness {
  const lines: string[] = []
  const commentPages = opts.commentPages ?? [asComments(opts.comments ?? [])]
  const filePages =
    opts.filePages ??
    [(opts.files ?? ['open/composer.ts']).map((f) => (typeof f === 'string' ? { filename: f } : f))]
  const changedFiles = 'changedFiles' in opts ? opts.changedFiles : filePages.flat().length
  const page = (pages: unknown[][], path: string): unknown[] => {
    const n = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1')
    return pages[n - 1] ?? []
  }
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
      if (/\/pulls\/\d+\/files\?/.test(path)) return page(filePages, path)
      // The PR object itself — no `/files`, no `per_page`. It carries the
      // changed_files count the truncation check compares the list against.
      if (/\/pulls\/\d+$/.test(path)) return { changed_files: changedFiles }
      if (path.includes('/comments')) return page(commentPages, path)
      throw new Error(`unexpected path ${path}`)
    },
  }
  return { deps, output: () => lines.join('\n') }
}

/**
 * A gate whose API call fails outright.
 *
 * Found by running the real CLI against a real PR with a head SHA the API does not
 * have: `gh` exited 422, `execFileSync` threw, and the gate printed a stack trace
 * with NO redeeming command. A red check whose message an author cannot act on is
 * exactly how a gate earns a bypass habit, so the throw is now caught, named as
 * "could not read" rather than "no verdict", and still redeems.
 */
function throwingHarness(): Harness {
  const lines: string[] = []
  return {
    output: () => lines.join('\n'),
    deps: {
      env: {
        GITHUB_REPOSITORY: 'example-org/example-repo',
        PR_NUMBER: PR,
        PR_HEAD_SHA: HEAD,
        PR_HEAD_REF: BRANCH,
      },
      log: (line) => {
        lines.push(line)
      },
      fetchJson: async () => {
        throw new Error('gh: No commit found for SHA (HTTP 422)\nstack line that must not be echoed')
      },
    },
  }
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

  test('an extensionless executable is gated — bin/neutron is not prose', () => {
    // Suffix-only classification called the CLI entry point prose, so a PR that
    // only rewrote it owed no evidence. A shebang script has no extension by
    // convention, so the directory is the only signal there is.
    expect(touchesGatedSurface('bin/neutron')).toBe(true)
    expect(touchesGatedSurface('scripts/release')).toBe(true)
    // …and the rule is about extensionless files, not about the directory as a
    // whole: an asset in the same tree is still an asset.
    expect(touchesGatedSurface('bin/logo.svg')).toBe(false)
    expect(touchesGatedSurface('README')).toBe(false)
  })

  test('the shared base tsconfig is gated — it sets the type surface every other config extends', () => {
    expect(touchesGatedSurface('tsconfig.base.json')).toBe(true)
  })

  test('a rename cannot hide the surface it moved off', async () => {
    // GitHub reports a rename under its DESTINATION path. Classifying that alone
    // let `git mv .github/workflows/ci.yml docs/ci.yml` — or a production module
    // renamed to *.test.ts — read as prose-only while changing exactly the
    // behaviour the evidence requirement exists for.
    expect(filesTouchGatedSurface([{ filename: 'docs/ci.yml', previous_filename: '.github/workflows/ci.yml' }])).toBe(
      true,
    )
    expect(filesTouchGatedSurface([{ filename: 'open/thing.test.ts', previous_filename: 'open/thing.ts' }])).toBe(true)
    expect(filesTouchGatedSurface([{ filename: 'docs/b.md', previous_filename: 'docs/a.md' }])).toBe(false)
    // Through the real call site: a mutation-free verdict must not pass.
    const h = harness({
      comments: [verdictBlock(HEAD, {}, false)],
      files: [{ filename: 'docs/ci.yml', previous_filename: '.github/workflows/ci.yml' }],
    })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('no mutation evidence')
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
  const failing: { name: string; make: () => Harness; pr?: string }[] = [
    { name: 'no verdict at all', make: () => harness({ comments: [] }) },
    { name: 'a verdict for an old sha', make: () => harness({ comments: [verdictBlock(OLD)] }) },
    { name: 'a hedged ran field', make: () => harness({ comments: [verdictBlock(HEAD, { 'codex.ran': 'pending' })] }) },
    { name: 'a malformed block', make: () => harness({ comments: ['```review-evidence\nnope\n```'] }) },
    {
      name: 'a bypass with no reason',
      make: () => harness({ comments: [], commitMessage: 'fix: thing\n\nTRIDENT_BYPASS=\n' }),
    },
    { name: 'the API call failing outright', make: () => throwingHarness() },
    // The four paths the previous round MISSED. Each returned 1 with no redeeming
    // command, while the module header, the doc and the as-built all claimed
    // "every failure path prints it" — and the universal test NAME hid the gap,
    // because the table it looped over simply did not enumerate these shapes.
    {
      name: 'a broken positive control',
      make: () => harness({ comments: [], control: () => ({ ok: false, detail: 'the parser cannot read its own fixture' }) }),
    },
    {
      name: 'an absent PR number',
      make: () => harness({ comments: [], env: { PR_NUMBER: undefined } }),
      // No PR number to name, so the command degrades to the placeholder rather
      // than inventing one. Still the SAME single definition of the command.
      pr: '',
    },
    { name: 'a partial head SHA', make: () => harness({ comments: [], env: { PR_HEAD_SHA: 'b'.repeat(12) } }) },
    {
      name: 'an absent repository',
      make: () => harness({ comments: [], env: { GITHUB_REPOSITORY: undefined } }),
    },
    {
      name: 'a verdict from an author without write access',
      make: () => harness({ comments: [{ body: verdictBlock(HEAD), author_association: 'NONE' }] }),
    },
    {
      name: 'a truncated file list',
      make: () => harness({ comments: [verdictBlock(HEAD)], files: ['open/a.ts'], changedFiles: 3200 }),
    },
  ]

  for (const { name, make, pr } of failing) {
    test(`every failure path prints the command that reviews THIS branch — ${name}`, async () => {
      const h = make()
      expect(await runGate(h.deps)).toBe(1)
      const out = h.output()
      // The exact command, with this branch and this PR filled in.
      expect(out).toContain(redeemCommand({ branch: BRANCH, prNumber: pr ?? PR }))
      expect(out).toContain(BRANCH)
      // And the promise that makes it safe to run.
      expect(out).toContain('REUSES this')
      expect(out).toContain('will not open a duplicate')
    })
  }

  test('the printed command contains NO argument spelling the dispatcher would silently swallow', () => {
    // THE defect of the previous round. The command read
    // `branch=<b> prNumber=<n>`, borrowed from the inner workflow's argument
    // names — which are real there and unreachable from the typed command. The
    // dispatcher's parse step recognises only `repo=`, `rounds=`, `mode=` and a
    // bare `ralph`; everything else that looks like a flag becomes part of the
    // TASK TEXT, and the task text is what gets slugified into a branch name. So
    // the redeeming command, pasted verbatim, opened a SECOND branch and a
    // duplicate PR — the precise waste it exists to prevent.
    //
    // This assertion is not a restatement of the string: it inspects the string
    // for flag SHAPES and fails on any that is not parsed. Re-adding `branch=`
    // reds it.
    for (const cmd of [
      redeemCommand({ branch: BRANCH, prNumber: PR }),
      redeemCommand({ branch: null, prNumber: null }),
    ]) {
      const flagLike = [...cmd.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9_]*)=/g)].map((m) => m[1]!)
      expect(flagLike.length).toBeGreaterThan(0)
      expect(flagLike.filter((f) => !DISPATCHER_PARSED_FLAGS.has(f))).toEqual([])
    }
  })

  test('the failure names THIS run to re-trigger, not a generic gesture at one', async () => {
    // A verdict posted after the run finished is correct and invisible — nothing
    // re-triggers on a comment. The run id is already in the environment, so it
    // goes into the output rather than being left as an exercise.
    const h = harness({ comments: [], env: { GITHUB_RUN_ID: '987654321' } })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('gh run rerun --failed 987654321')
  })

  test('the command names this branch, this PR, and the instruction not to duplicate them', () => {
    const cmd = redeemCommand({ branch: BRANCH, prNumber: 7 })
    expect(cmd.startsWith('/trident v2 ')).toBe(true)
    expect(cmd).toContain(BRANCH)
    expect(cmd).toContain('PR #7')
    expect(cmd).toContain('reuse that PR')
    expect(cmd).toContain('do not restart from scratch')
    expect(cmd).toContain('do not open a new PR')
  })

  test('an unknown branch or PR degrades to a placeholder rather than a wrong value', () => {
    const cmd = redeemCommand({ branch: null, prNumber: '' })
    expect(cmd).toContain('<this branch>')
    expect(cmd).toContain('the open PR')
    // Never a bare `#` with nothing after it, which reads as a real PR number.
    expect(cmd).not.toMatch(/PR #(\s|$)/)
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
  test('the known-good fixture parses and clears the bar', async () => {
    const result = await selfTest()
    expect(result.ok).toBe(true)
    const parsed = parseVerdict(CONTROL_COMMENT)
    expect(parsed.commit).toBe(CONTROL_HEAD_SHA)
    expect(verdictFailures(parsed, CONTROL_HEAD_SHA, { touchesSource: true })).toEqual([])
  })

  test('the control reports what it actually proved: a positive AND two negatives', async () => {
    // The control drives `gate` three times — good verdict, no verdict, stale
    // verdict — so it covers the candidate filter, the pagination and the API
    // shape handling, not just the parser. That is the whole difference from the
    // previous round: a mutant emptying the candidate filter passed a
    // parser-only control while reporting "no verdict recorded" for every PR.
    // With the control driving the real path, the SAME mutant now turns
    // `selfTest().ok` false and the test above red.
    const result = await selfTest()
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('the full lookup')
  })

  test('a control that cannot find a positive is not allowed to look like an absence', async () => {
    const h = harness({ comments: [verdictBlock(HEAD)], control: () => ({ ok: false, detail: 'no positive' }) })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('THE LOOKUP IS BROKEN')
    expect(h.output()).not.toContain('no trident verdict recorded')
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

describe('an unreadable API is red, and says so in its own words', () => {
  test('a failing API call is "could not read", not "no verdict", and still redeems', async () => {
    const h = throwingHarness()
    expect(await runGate(h.deps)).toBe(1)
    const out = h.output()
    expect(out).toContain('could not READ this PR')
    expect(out).not.toContain('no trident verdict recorded')
    expect(out).toContain('HTTP 422')
    // Only the first line of the error — a stack trace is not a message.
    expect(out).not.toContain('stack line that must not be echoed')
    expect(out).toContain(redeemCommand({ branch: BRANCH, prNumber: PR }))
  })
})

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
// A verdict is an APPROVAL, and this repository is public
// --------------------------------------------------------------------------- //

describe('only an author with write access can record a verdict', () => {
  test('a stranger cannot green the gate', async () => {
    for (const assoc of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', undefined]) {
      const h = harness({ comments: [{ body: verdictBlock(HEAD), author_association: assoc }] })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('none of them is a verdict')
    }
  })

  test('and a stranger cannot RED it either, by posting something malformed', async () => {
    // The mirror-image abuse, and the reason the filter runs BEFORE the parse: a
    // malformed newest candidate is fatal by design, so an untrusted comment that
    // reached the parser would let anyone force a red check on a reviewed PR.
    const h = harness({
      comments: [
        { body: verdictBlock(HEAD), author_association: 'OWNER' },
        { body: `${verdictBlock(OLD)}\n${verdictBlock(HEAD)}`, author_association: 'NONE' },
      ],
    })
    expect(await runGate(h.deps)).toBe(0)
  })

  test('the three write-access associations count, case-insensitively, and nothing else does', () => {
    for (const ok of ['OWNER', 'MEMBER', 'COLLABORATOR', 'owner', ' Collaborator ']) {
      expect(isTrustedAuthor(ok)).toBe(true)
    }
    for (const no of ['CONTRIBUTOR', 'NONE', '', undefined, 'OWNER_OF_SOMETHING']) {
      expect(isTrustedAuthor(no)).toBe(false)
    }
  })

  test('"posted but not counted" is a different message from "nobody posted one"', async () => {
    const stranger = harness({ comments: [{ body: verdictBlock(HEAD), author_association: 'NONE' }] })
    await runGate(stranger.deps)
    expect(stranger.output()).not.toContain('no trident verdict recorded')

    const nobody = harness({ comments: ['just chatting'] })
    await runGate(nobody.deps)
    expect(nobody.output()).toContain('no trident verdict recorded')
  })
})

// --------------------------------------------------------------------------- //
// Pagination — the untested direction was the fail-OPEN one
// --------------------------------------------------------------------------- //

describe('a paginated list is accumulated, and a truncated one is refused', () => {
  const filler = (n: number, name: (i: number) => string): { filename: string }[] =>
    Array.from({ length: n }, (_, i) => ({ filename: name(i) }))

  test('an executable file on page 2 still requires mutation evidence', async () => {
    // The mutant `if (batch.length < PER_PAGE) return items` → `return items`
    // survived the previous suite, because no case ever had a second page. Its
    // untested direction is the fail-OPEN one: a >100-file PR whose only
    // executable file sits on page 2 classifies as prose only and the mutation
    // requirement disappears.
    const page1 = filler(100, (i) => `docs/note-${i}.md`)
    const page2 = [{ filename: 'open/composer.ts' }]
    const h = harness({ comments: [verdictBlock(HEAD, {}, false)], filePages: [page1, page2] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('no mutation evidence')
  })

  test('a verdict on page 2 of the comments is found, not read as absent', async () => {
    const page1: { body: string; author_association: string }[] = Array.from({ length: 100 }, (_, i) => ({
      body: `discussion ${i}`,
      author_association: 'OWNER',
    }))
    const page2 = [{ body: verdictBlock(HEAD), author_association: 'OWNER' }]
    const h = harness({ comments: [], commentPages: [page1, page2] })
    expect(await runGate(h.deps)).toBe(0)
  })

  test('newest-wins still holds ACROSS pages', async () => {
    const page1 = [
      { body: verdictBlock(HEAD), author_association: 'OWNER' },
      ...Array.from({ length: 99 }, (_, i) => ({ body: `noise ${i}`, author_association: 'OWNER' })),
    ]
    const page2 = [{ body: verdictBlock(OLD), author_association: 'OWNER' }]
    const h = harness({ comments: [], commentPages: [page1, page2] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('the reviewed tree is not the tree being merged')
  })

  test('a file list capped by the API is refused, not read as a complete list', async () => {
    // The files endpoint caps at 3,000 files, and a capped response is a
    // complete-LOOKING short page: it terminates the paginator exactly like a
    // genuine last page. So the list is compared against the PR's own
    // changed_files count.
    const h = harness({ comments: [verdictBlock(HEAD)], files: ['docs/a.md'], changedFiles: 3200 })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('could not READ this PR')
    expect(h.output()).toContain('of 3200 changed files')
  })

  test('a PR endpoint with no usable changed_files is unreadable, not a pass', async () => {
    for (const bad of [undefined, 'lots', 1.5, -1]) {
      const h = harness({ comments: [verdictBlock(HEAD)], changedFiles: bad })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('could not READ this PR')
    }
  })
})

// --------------------------------------------------------------------------- //
// The guards whose removal survived the previous suite
// --------------------------------------------------------------------------- //

describe('the numeric and evidence guards have coverage, not just code', () => {
  test('a negative blocking count is rejected — including `-0`', async () => {
    // Removing the guard survived the previous suite: no case ever fed a negative
    // count, so a regressed producer emitting `codex.blocking: -1` would have read
    // as clean. `-0` is the sharper case: `Number('-0') < 0` is false, so a
    // value-based guard passes it. The SIGN is what is rejected.
    for (const bad of ['-1', '-0', '-2']) {
      expect(() => parseVerdict(verdictBlock(HEAD, { 'codex.blocking': bad }))).toThrow(/non-negative/)
      const h = harness({ comments: [verdictBlock(HEAD, { 'adversarial.blocking': bad })] })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('malformed verdict block')
    }
    // The honest zero still passes, so this is not a blanket rejection.
    expect(parseVerdict(verdictBlock(HEAD, { 'codex.blocking': '0' })).codexBlocking).toBe(0)
  })

  test('a blank mutation field is rejected — a mutation nobody ran is not evidence', async () => {
    for (const blank of ['', '   ']) {
      const body = [
        '```review-evidence',
        `commit: ${HEAD}`,
        'codex.ran: true',
        'codex.blocking: 0',
        'adversarial.ran: true',
        'adversarial.blocking: 0',
        '- mutant: dropped the sha comparison',
        `  red:${blank ? ` ${blank}` : ''}`,
        '  control: 12/12 green',
        '```',
      ].join('\n')
      expect(() => parseVerdict(body)).toThrow(/empty red/)
      const h = harness({ comments: [body] })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('malformed verdict block')
    }
  })

  test('an `n/a`-shaped mutation field is rejected — the same bar the producer applies', async () => {
    // The producing side refuses empty, `<...>`, and tbd/n-a/none/unknown before
    // it posts. This gate applied only the first two, so a HAND-WRITTEN verdict
    // was held to a LOWER bar than a generated one, and `- mutant: n/a` satisfied
    // the clause that exists to stop exactly that.
    for (const junk of ['n/a', 'N/A', 'none', 'TBD', 'unknown', '-', 'todo']) {
      const body = verdictBlock(HEAD).replace('  control: 12/12 green', `  control: ${junk}`)
      expect(() => parseVerdict(body)).toThrow(/unusable control/)
      const h = harness({ comments: [body] })
      expect(await runGate(h.deps)).toBe(1)
    }
    // A real control line that merely CONTAINS one of those words is fine — the
    // rule is about the whole value, not a substring.
    expect(() =>
      parseVerdict(verdictBlock(HEAD).replace('  control: 12/12 green', '  control: 12/12 green, none skipped')),
    ).not.toThrow()
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
    // Single source: the hook delegates to the advisory, which asks the gate for
    // the command, instead of carrying a second copy that would drift out of
    // agreement with the CI output.
    expect(hook).toContain('scripts/ci/trident-redeem-advisory.sh')
    // It must not hand-copy the command text.
    expect(hook).not.toContain('/trident v2 repo=')
    // The advisory block must not be able to change the push's exit status.
    const advisory = hook.slice(hook.indexOf('trident-verdict advisory'))
    expect(advisory).not.toMatch(/\bexit\s+1\b/)
    expect(advisory).not.toContain('STATUS=')
    // It must feed the hook's ref lines in, NOT consult the checked-out branch.
    expect(advisory).toContain('$REFLINES')
    expect(advisory).not.toContain('abbrev-ref')
  })

  test('the hook keeps the ref lines it consumes, so the advisory can read them', () => {
    const hook = read('.githooks/pre-push')
    // The leak-gate loop consumes stdin, so the advisory cannot re-read it. The
    // lines are captured inside the loop.
    expect(hook).toMatch(/REFLINES="\$\{REFLINES\}/)
  })
})

// --------------------------------------------------------------------------- //
// The advisory NAMES THE PUSHED BRANCH — a behaviour probe, not a text assertion
// --------------------------------------------------------------------------- //

describe('the push-time advisory names the ref being pushed', () => {
  const ADVISORY = fileURLToPath(new URL('trident-redeem-advisory.sh', import.meta.url))
  const ZERO = '0'.repeat(40)
  const SHA = 'd'.repeat(40)

  const run = (stdin: string): { code: number; err: string } => {
    const p = Bun.spawnSync(['bash', ADVISORY], {
      stdin: new TextEncoder().encode(stdin),
      cwd: fileURLToPath(REPO_ROOT),
    })
    return { code: p.exitCode, err: new TextDecoder().decode(p.stderr) }
  }

  test('it names the PUSHED branch, not the checked-out one', () => {
    // The previous version read `git rev-parse --abbrev-ref HEAD`, so
    // `git push origin some-other-branch` printed a redemption command for
    // whatever happened to be checked out. Naming the wrong branch in a
    // redemption command is worse than naming none: it sends the work somewhere
    // it is not. Run with a real ref line, and the output is checked — the only
    // coverage this had before was an assertion about the hook's text.
    const { code, err } = run(`refs/heads/some-other-branch ${SHA} refs/heads/some-other-branch ${ZERO}\n`)
    expect(code).toBe(0)
    expect(err).toContain('some-other-branch')
    expect(err).toContain('/trident v2 repo=')
    // The branch this test actually runs on must not appear as the subject.
    const checkedOut = new TextDecoder()
      .decode(Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: fileURLToPath(REPO_ROOT) }).stdout)
      .trim()
    if (checkedOut && checkedOut !== 'some-other-branch') expect(err).not.toContain(checkedOut)
  })

  test('a multi-ref push names every branch it pushes', () => {
    const { code, err } = run(
      `refs/heads/one ${SHA} refs/heads/one ${ZERO}\nrefs/heads/two ${SHA} refs/heads/two ${ZERO}\n`,
    )
    expect(code).toBe(0)
    expect(err).toContain('EXISTING branch one ')
    expect(err).toContain('EXISTING branch two ')
  })

  test('a tag push and a branch deletion say nothing at all', () => {
    for (const stdin of [
      `refs/tags/v1.2.3 ${SHA} refs/tags/v1.2.3 ${ZERO}\n`,
      `refs/heads/gone ${ZERO} refs/heads/gone ${SHA}\n`,
      '',
    ]) {
      const { code, err } = run(stdin)
      expect(code).toBe(0)
      expect(err).not.toContain('/trident v2')
    }
  })
})
