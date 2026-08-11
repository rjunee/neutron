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
 * redemption cases are a TABLE, and their name used to be a universal claim —
 * "every failure path prints the command" — while the table omitted four real
 * failure paths. A universal claim in a test name is only as true as the table under
 * it, and no enumeration can ever close that gap, because adding a `return 1` to the
 * gate does not add a row here. The universal half is therefore checked against the
 * GATE'S SOURCE ("EVERY red exit in the gate prints the redemption"), and the rows
 * are named for what they are. When adding a failure path, add its row anyway: the
 * structural check proves the command is printed, the row proves it is printed with
 * the right branch and PR in it.
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  /**
   * The PR's own `author_association`, which is what the BYPASS is checked
   * against. `OWNER` by default: the overwhelming majority of these cases are
   * about content, and the author-trust cases set it explicitly.
   */
  prAuthorAssociation?: string | undefined
  /**
   * `head.repo.full_name` — the repository the head branch lives in. A fork's name
   * here disables the bypass hatch; `null` is the deleted-fork shape the API reports.
   */
  headRepo?: string | null | undefined
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
      if (/\/pulls\/\d+$/.test(path)) {
        return {
          changed_files: changedFiles,
          author_association: 'prAuthorAssociation' in opts ? opts.prAuthorAssociation : 'OWNER',
          // Where the HEAD BRANCH lives, which is what decides whether the bypass
          // hatch is available at all. Defaults to this repository — the ordinary case
          // and the only one the hatch is for.
          head: { repo: { full_name: 'headRepo' in opts ? opts.headRepo : 'example-org/example-repo' } },
        }
      }
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
  test('only the literal `true` counts as ran — for BOTH lanes', async () => {
    // Looping the hedges over `codex.ran` alone left `adversarial.ran` with code
    // and no test: deleting its check outright survived the whole suite, so the
    // independent pass could report "pending" and the gate would pass it. Two
    // legs, two loops — a guard that exists twice needs coverage twice.
    for (const key of ['codex.ran', 'adversarial.ran']) {
      for (const hedge of ['yes (backgrounded)', 'pending', 'probably', 'True', 'TRUE', 'false']) {
        const h = harness({ comments: [verdictBlock(HEAD, { [key]: hedge })] })
        expect(await runGate(h.deps)).toBe(1)
        expect(h.output()).toContain(`${key} is not the literal \`true\``)
      }
    }
  })

  test('unresolved blocking findings fail even when both passes ran', async () => {
    const h = harness({ comments: [verdictBlock(HEAD, { 'adversarial.blocking': '2' })] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('2 unresolved adversarial P0/P1')
  })

  test('a verdict hidden inside an HTML comment is not a record, so it is not a verdict', async () => {
    // A cross-model lane's finding. `<!-- ```review-evidence … ``` -->` parses as a
    // perfectly good block and renders as NOTHING in the thread, so a trusted author
    // could green a required check with evidence no human reading the PR can see. The
    // comment IS the audit trail here; a block nobody can see defeats the only reason
    // the verdict lives in a comment rather than in the diff.
    const hidden = `<!--\n${verdictBlock(HEAD)}\n-->`
    const h = harness({ comments: [hidden] })
    expect(await runGate(h.deps)).toBe(1)
    // Ignored ENTIRELY, not treated as malformed: a hidden block must not be able to
    // red the gate either, which is the same bug wearing the other sign.
    expect(h.output()).toContain('no trident verdict recorded')
    expect(h.output()).not.toContain('malformed verdict block')
  })

  test('a hidden block cannot shadow a real one, in either order', async () => {
    // Newest-wins reads the LAST fenced comment, so a hidden block posted after a good
    // verdict would displace it if the filter could see it — and a hidden block in the
    // same comment as a real one would read as "two blocks", which the parser refuses.
    const good = verdictBlock(HEAD)
    const stale = verdictBlock('c'.repeat(40))
    expect(await runGate(harness({ comments: [good, `<!--\n${stale}\n-->`] }).deps)).toBe(0)
    expect(await runGate(harness({ comments: [`<!--\n${stale}\n-->\n\n${good}`] }).deps)).toBe(0)
  })

  test('an unterminated HTML comment hides everything after it, as a renderer does', async () => {
    const h = harness({ comments: [`<!-- opened and never closed\n${verdictBlock(HEAD)}`] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('no trident verdict recorded')
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

  test('a `docs` directory NESTED somewhere else is not prose — only the root docs tree is', () => {
    // `docs` was matched at any depth, so an executable module under a nested
    // directory that happens to be named `docs` owed no mutation evidence. No such
    // file is in the tree today, which is why this survived two rounds — and a
    // classifier that can be walked around as soon as somebody makes a directory is
    // wrong now, not wrong later.
    for (const gated of ['open/docs/handler.ts', 'scripts/docs/build.sh', 'app/docs/render.tsx']) {
      expect(touchesGatedSurface(gated)).toBe(true)
    }
    // The root prose tree still exempts, at any depth inside it.
    for (const exempt of ['docs/plans/thing.md', 'docs/tools/generate.ts']) {
      expect(touchesGatedSurface(exempt)).toBe(false)
    }
    // And `__tests__` keeps its any-depth exemption — that one is test scaffolding
    // wherever it sits, which is the difference between the two sets.
    expect(touchesGatedSurface('open/nested/__tests__/helper.ts')).toBe(false)
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

  test('EVERY red exit SHAPE in the gate prints the redemption — checked against the source', () => {
    // The table below is a table, and its name used to be a universal claim: "every
    // failure path prints the command". It omitted four real paths while asserting
    // it covered all of them, and the enumeration cannot ever prove otherwise —
    // adding a `return 1` to the gate does not add a row here.
    //
    // So the universal half is checked universally, against the gate's own source:
    // every red exit must have a `printRedemption(` call between it and the
    // preceding statement boundary. A new failure path that forgets the redemption
    // reds THIS test on the day it is written, whether or not anybody adds a row.
    // The window is the ENCLOSING BLOCK, walked by indentation, not a fixed number
    // of lines back. A fixed window was the first version of this check and it was
    // useless in the one direction that matters: six lines above a new red exit
    // reached over the block opener into the PREVIOUS branch, found its
    // `printRedemption`, and passed a red exit that printed nothing. Measured — a
    // mutant that adds exactly that survived, which is the whole failure mode this
    // test exists to catch.
    // WHAT "EVERY" MEANS HERE, because the previous name claimed more than the check
    // delivered. This scans the source for red-exit SHAPES: a returned non-zero
    // literal (`return 1`, `return 2`) and a `process.exit(<non-zero>)`. A red exit
    // written some OTHER way — `return code` where `code` is computed, a thrown value
    // some caller turns into 1 — is invisible to a source scan and always will be.
    // Two things keep that gap small rather than open: `runGate` catches everything
    // thrown and redeems on the way out (its own row is in the table below), and the
    // gate has exactly one non-zero return value. The claim is "every red exit shape
    // this scan can see", and now the name says that instead of implying more.
    const src = read('scripts/ci/trident-verdict.ts')
    const lines = src.split('\n')
    const indentOf = (l: string): number => /^ */.exec(l)![0].length
    const isRedExit = (l: string): boolean =>
      /^\s*return [1-9]\d*\b/.test(l) || /^\s*process\.exit\([1-9]\d*\)/.test(l)
    const unredeemed: string[] = []
    lines.forEach((line, i) => {
      if (!isRedExit(line)) return
      let redeemed = false
      for (let j = i - 1; j >= 0; j--) {
        const above = lines[j]!
        if (!above.trim()) continue // a blank line is not a block boundary
        // Less indented than the return means this is the block's opener: stop
        // before crossing into whatever came before it.
        if (indentOf(above) < indentOf(line)) break
        if (above.includes('printRedemption(')) {
          redeemed = true
          break
        }
      }
      if (!redeemed) unredeemed.push(`line ${i + 1}: ${line.trim()}`)
    })
    // The count is asserted too, because `unredeemed` being empty is also what a scan
    // that matched NOTHING reports — an emptiness check alone passes a gate with no red
    // exits left in it at all. What it asserts is exactly that and no more: the scan
    // saw something. It used to restate a number (`>= 8`), which pinned a count nothing
    // in the design fixes — a legitimate consolidation down to seven red exits would
    // have redded this test while every guard it covers still held.
    expect(lines.filter(isRedExit).length).toBeGreaterThan(0)
    expect(unredeemed).toEqual([])
  })

  for (const { name, make, pr } of failing) {
    test(`an enumerated failure path prints the command that reviews THIS branch — ${name}`, async () => {
      const h = make()
      expect(await runGate(h.deps)).toBe(1)
      const out = h.output()
      // The exact command, with this branch and this PR filled in.
      expect(out).toContain(redeemCommand({ branch: BRANCH, prNumber: pr ?? PR }))
      expect(out).toContain(BRANCH)
      // The route that is wholly inside this repository comes FIRST, and the
      // recording template is printed with it — that is the bar the gate reads.
      expect(out).toContain('1. THE BRANCH HAS BEEN REVIEWED')
      expect(out).toContain('```review-evidence')
      expect(out).toContain('2. HAND THE BRANCH TO A REVIEW LANE')
      // And the failure mode is NAMED rather than promised away. This assertion is
      // the round-2 blocker in test form: the previous output claimed the lane
      // "REUSES this PR" and "will not open a duplicate", which is false on the
      // typed-start path, so following it opened a second branch and a duplicate
      // PR. Re-adding either promise reds this.
      expect(out).toContain('has not redeemed this one')
      expect(out).not.toContain('will not open a duplicate')
      expect(out).not.toContain('REUSES this')
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
    // THE SET ITSELF IS PINNED, because it is the other half of the filter and it was
    // the unguarded half. A subset check alone is satisfied by WIDENING the set: add
    // `branch` and `prNumber` to it, re-add the two flags to the command, and the
    // round-2 duplicate-PR defect is back with the suite still green — measured
    // exactly that way. The set is a claim about a dispatcher that lives outside this
    // repository, so growing it is a claim about that grammar and has to be a
    // deliberate edit here, next to the reason.
    expect([...DISPATCHER_PARSED_FLAGS].sort()).toEqual(['mode', 'repo', 'rounds'])
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
    // An ADOPT instruction, spelled as an imperative. The command is the payload
    // read by the planner and the builder, so what it ASKS FOR is the mechanism;
    // there is no harness behaviour it can rely on to supply this for it.
    expect(cmd).toContain('ADOPT that branch and that PR')
    expect(cmd).toContain(`check out ${BRANCH} without creating it`)
    expect(cmd).toContain('reuse PR #7')
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

  test('OWNER and COLLABORATOR count, case-insensitively, and nothing else does', () => {
    for (const ok of ['OWNER', 'COLLABORATOR', 'owner', ' Collaborator ']) {
      expect(isTrustedAuthor(ok)).toBe(true)
    }
    for (const no of ['CONTRIBUTOR', 'NONE', '', undefined, 'OWNER_OF_SOMETHING']) {
      expect(isTrustedAuthor(no)).toBe(false)
    }
  })

  test('MEMBER is NOT write access — it is org membership, and it does not count', async () => {
    // Two reviewers confirmed the docblock's claim that OWNER/MEMBER/COLLABORATOR
    // "mean write access" was false. MEMBER means "belongs to the org that owns the
    // repository", which on an org-owned repository is satisfied by a read-only or
    // triage-only member — so trusting it hands a required check to an account with
    // no write access at all. On this user-owned repository the value cannot occur,
    // which made the hole latent rather than live and is exactly why it survived two
    // rounds. This test is the thing that dies if MEMBER is put back.
    expect(isTrustedAuthor('MEMBER')).toBe(false)
    const h = harness({ comments: [{ body: verdictBlock(HEAD), author_association: 'MEMBER' }] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('none of them is a verdict')
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
// ROUND 3 — the six mutants that survived the round-2 suite
//
// Every case below was found by RUNNING the battery, not by reading the code, and
// each one is a fail-OPEN direction: the mutant returned exit 0 PASS on input the
// gate exists to refuse. The previous as-built entry claimed "16 applied, 16
// caught, 0 survived"; the honest number was 10 of 16, which is why the table now
// lives in a script whose output is pasted rather than in a sentence.
// --------------------------------------------------------------------------- //

describe('a blocking count of exactly ONE is a failure, not a rounding error', () => {
  // `verdict.codexBlocking > 0` → `> 1` survived the whole suite, because every
  // case used either 0 or 2. One unresolved P0 is the single most likely real
  // value, and the mutant passed it.
  test('one unresolved codex finding fails', async () => {
    const h = harness({ comments: [verdictBlock(HEAD, { 'codex.blocking': '1' })] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('1 unresolved codex P0/P1')
  })

  test('one unresolved adversarial finding fails', async () => {
    const h = harness({ comments: [verdictBlock(HEAD, { 'adversarial.blocking': '1' })] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('1 unresolved adversarial P0/P1')
  })

  test('the boundary is not off by one in the other direction either — 0 still passes', async () => {
    const h = harness({ comments: [verdictBlock(HEAD, { 'codex.blocking': '0' })] })
    expect(await runGate(h.deps)).toBe(0)
  })
})

describe('an EMPTY count is not a zero', () => {
  // `/^-?\d+$/` → `/^-?\d*$/` survived: the empty string matched, `Number('')` is
  // 0, and `codex.blocking:` with nothing after it read as "no blocking findings".
  // A producer that emits a key with an unset value is a realistic regression, and
  // its silent reading is the worst possible one.
  test('a blocking key with no value is malformed, never zero', async () => {
    for (const key of ['codex.blocking', 'adversarial.blocking']) {
      const h = harness({ comments: [verdictBlock(HEAD, { [key]: '' })] })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('must be an integer count')
    }
    expect(() => parseVerdict(verdictBlock(HEAD, { 'codex.blocking': '   ' }))).toThrow(/integer count/)
  })
})

describe('a bypass reason has to contain a readable word', () => {
  // `/[a-z]{3}/i` → `/[a-z]{1}/i` survived: the existing cases were `1` and `-`,
  // which carry no letters at all, so shortening the run length changed nothing
  // they could see. A two-letter reason is the discriminating input.
  test('a reason too short to say anything is refused', () => {
    for (const reason of ['ok', 'no', 'x2', 'P0']) {
      expect(readBypass(`x\n\nTRIDENT_BYPASS=${reason}\n`).kind).toBe('invalid')
    }
  })

  test('a three-letter word is enough, so this is a floor and not a style rule', () => {
    expect(readBypass('x\n\nTRIDENT_BYPASS=key rotation, outage\n').kind).toBe('bypass')
  })

  test('a real reason that opens and closes with angle brackets is NOT a placeholder', () => {
    // The greedy `^<[\s\S]*>$` matched from the first `<` to the last `>`, so this
    // legitimate reason was refused as an unfilled template.
    const outcome = readBypass('x\n\nTRIDENT_BYPASS=<incident 42> superseded by <p0 fix>\n')
    expect(outcome).toEqual({ kind: 'bypass', reason: '<incident 42> superseded by <p0 fix>' })
    // …and a genuine single-span placeholder is still refused.
    expect(readBypass('x\n\nTRIDENT_BYPASS=<why this one cannot wait>\n').kind).toBe('invalid')
  })
})

describe('a file list short by even ONE file is not a list', () => {
  // `files.length < changedFiles` → `files.length + 1 < changedFiles` survived,
  // because the only truncation case in the suite was 1 file against 3,200. The
  // off-by-one is the realistic API hiccup, and it is exactly what the check is
  // for: one missing file can be the only executable file in the PR.
  test('one file missing from the list is unreadable, not prose-only', async () => {
    const h = harness({
      comments: [verdictBlock(HEAD, {}, false)],
      files: ['docs/a.md'],
      changedFiles: 2,
    })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('could not READ this PR')
    expect(h.output()).toContain('returned 1 of 2 changed files')
  })

  test('an exact match is accepted, so the check is not simply always-red', async () => {
    const h = harness({ comments: [verdictBlock(HEAD)], files: ['open/a.ts'], changedFiles: 1 })
    expect(await runGate(h.deps)).toBe(0)
  })
})

describe('a list that never ends is refused rather than silently truncated', () => {
  // The `MAX_PAGES` terminator had code and no test: every existing case reached a
  // short page. A paginator that walks forever against a misbehaving endpoint would
  // hang the job; one that stops without saying so classifies a PR from a partial
  // view. The refusal is what makes the difference visible.
  test('an endpoint that always returns a full page is reported as unreadable', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      body: `noise ${i}`,
      author_association: 'OWNER',
    }))
    let calls = 0
    const lines: string[] = []
    const deps: GateDeps = {
      env: {
        GITHUB_REPOSITORY: 'example-org/example-repo',
        PR_NUMBER: PR,
        PR_HEAD_SHA: HEAD,
        PR_HEAD_REF: BRANCH,
      },
      log: (line) => {
        lines.push(line)
      },
      control: () => ({ ok: true, detail: 'stubbed' }),
      fetchJson: async (path) => {
        if (path.startsWith('repos/example-org/example-repo/commits/')) {
          return { commit: { message: 'fix: something\n' } }
        }
        if (/\/pulls\/\d+\/files\?/.test(path)) return [{ filename: 'docs/a.md' }]
        if (/\/pulls\/\d+$/.test(path)) return { changed_files: 1, author_association: 'OWNER' }
        if (path.includes('/comments')) {
          calls++
          return fullPage
        }
        throw new Error(`unexpected path ${path}`)
      },
    }
    expect(await runGate(deps)).toBe(1)
    const out = lines.join('\n')
    expect(out).toContain('could not READ this PR')
    expect(out).toContain('refusing a truncated view')
    // Bounded, and bounded at the documented ceiling rather than "eventually".
    expect(calls).toBe(100)
  })
})

// --------------------------------------------------------------------------- //
// The escape hatch is held to the SAME author bar as the verdict
// --------------------------------------------------------------------------- //

describe('TRIDENT_BYPASS needs write access, not just a commit message', () => {
  const REASON = 'ops: signing key expired mid-outage, the review lane is slower than the incident'

  test('a bypass on a PR from an account without write access is not honoured', async () => {
    // THE ABUSE THIS CLOSES. The verdict path has filtered on write access from the
    // start, because this repository is public. The hatch beside it trusted nothing
    // but a string in a commit message — and the author of a fork PR writes their
    // own commit messages, so one line greened a required check on an unreviewed
    // change. Deleting the check makes every case below pass with exit 0.
    for (const assoc of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', undefined]) {
      const h = harness({
        comments: [],
        prAuthorAssociation: assoc,
        commitMessage: `fix: thing\n\nTRIDENT_BYPASS=${REASON}\n`,
      })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('without write access to this repository')
      expect(h.output()).not.toContain('BYPASSED')
    }
  })

  test('and the same marker from an account WITH write access still works', async () => {
    for (const assoc of ['OWNER', 'COLLABORATOR']) {
      const h = harness({
        comments: [],
        prAuthorAssociation: assoc,
        commitMessage: `fix: thing\n\nTRIDENT_BYPASS=${REASON}\n`,
      })
      expect(await runGate(h.deps)).toBe(0)
      expect(h.output()).toContain('BYPASSED')
    }
  })

  test('an untrusted author is told to review, and gets the redeeming routes', async () => {
    const h = harness({
      comments: [],
      prAuthorAssociation: 'NONE',
      commitMessage: `fix: thing\n\nTRIDENT_BYPASS=${REASON}\n`,
    })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain(redeemCommand({ branch: BRANCH, prNumber: PR }))
  })

  test('an untrusted author with a MALFORMED marker is refused on authorship first', async () => {
    // Order matters for the message: "you may not use this" is the actionable
    // fact, and "your reason was empty" would invite a second attempt at a hatch
    // that was never available.
    const h = harness({ comments: [], prAuthorAssociation: 'NONE', commitMessage: 'x\n\nTRIDENT_BYPASS=\n' })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('without write access')
  })

  test('a bypass on a FORK head is refused even from a trusted PR author', async () => {
    // THE HOLE A CROSS-MODEL LANE FOUND, and the reasoning that produced it: the
    // gate read the PR author's association and the comment beside it argued that
    // "pushing a commit onto a PR head requires write access to the head branch, so
    // the PR's author is who is accountable". That is true of a branch HERE and false
    // of a fork, where write access to the head branch belongs to the fork's owner. An
    // OWNER may open a PR from any fork branch — including one an outsider controls —
    // and the outsider can then push a commit carrying the marker, while the
    // association read here still says OWNER.
    for (const headRepo of ['someone-else/example-repo', 'example-org/other-repo']) {
      const h = harness({
        comments: [],
        prAuthorAssociation: 'OWNER',
        headRepo,
        commitMessage: `fix: thing\n\nTRIDENT_BYPASS=${REASON}\n`,
      })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('whose HEAD lives in')
      expect(h.output()).not.toContain('BYPASSED')
      // And it still hands the branch back rather than just refusing.
      expect(h.output()).toContain(redeemCommand({ branch: BRANCH, prNumber: PR }))
    }
  })

  test('an UNREADABLE head repo is resolved against the bypass, not in its favour', async () => {
    // A deleted fork reports `head.repo: null`. A privilege is the one place an
    // unknown must fail closed — `undefined === repo` is false, which is the answer
    // this needs, and the test is here so a later "tolerate a missing field" cannot
    // quietly invert it.
    const h = harness({
      comments: [],
      prAuthorAssociation: 'OWNER',
      headRepo: null,
      commitMessage: `fix: thing\n\nTRIDENT_BYPASS=${REASON}\n`,
    })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('(not reported)')
  })

  test('the case of the repository name does not decide it', async () => {
    // GitHub treats owner/name case-insensitively, so a differently-cased spelling of
    // THIS repository is this repository and must not read as a fork.
    const h = harness({
      comments: [],
      prAuthorAssociation: 'OWNER',
      headRepo: 'Example-Org/Example-Repo',
      commitMessage: `fix: thing\n\nTRIDENT_BYPASS=${REASON}\n`,
    })
    expect(await runGate(h.deps)).toBe(0)
    expect(h.output()).toContain('BYPASSED')
  })

  test('a fork PR with no marker is NOT dragged into the bypass path', async () => {
    // The refusal is about the hatch, not about forks. An ordinary outside
    // contribution must still get the ordinary "no verdict" answer.
    const h = harness({ comments: [], prAuthorAssociation: 'NONE', headRepo: 'someone-else/example-repo' })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('no trident verdict recorded')
    expect(h.output()).not.toContain('whose HEAD lives in')
  })

  test('a fork PR can still be greened by a recorded VERDICT — only the hatch is closed', async () => {
    const h = harness({ comments: [verdictBlock(HEAD)], headRepo: 'someone-else/example-repo' })
    expect(await runGate(h.deps)).toBe(0)
  })

  test('no marker at all is untouched by the author check', async () => {
    // The authorship rule must not turn every outside contribution into a bypass
    // complaint — with no marker there is nothing to refuse, and the ordinary
    // "no verdict" path is what a contributor should see.
    const h = harness({ comments: [], prAuthorAssociation: 'NONE' })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('no trident verdict recorded')
    expect(h.output()).not.toContain('TRIDENT_BYPASS marker')
  })
})

// --------------------------------------------------------------------------- //
// A verdict is a PUBLIC comment, and it cannot be un-published
// --------------------------------------------------------------------------- //

describe('a verdict may not carry a home-directory absolute path', () => {
  const HOME_PATHS = [
    '/Users/someone/repos/neutron-open/open/composer.ts:11',
    '/home/someone/src/thing.ts',
    'C:\\Users\\someone\\repos\\thing.ts',
  ]

  test('a mutation field citing an absolute home path is refused', async () => {
    for (const p of HOME_PATHS) {
      const body = verdictBlock(HEAD).replace('  red: gate accepted a stale verdict', `  red: broke ${p}`)
      expect(() => parseVerdict(body)).toThrow(/absolute path under a home directory/)
      const h = harness({ comments: [body] })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('malformed verdict block')
    }
  })

  test('the refusal does NOT echo the path — this check log is public too', async () => {
    const body = verdictBlock(HEAD).replace(
      '  control: 12/12 green',
      `  control: ${HOME_PATHS[0]!} stayed green`,
    )
    const h = harness({ comments: [body] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('not quoted here')
    // Republishing it in the failure message would defeat the entire rule.
    expect(h.output()).not.toContain('/Users/someone')
  })

  test('a repo-relative citation — the form a verdict should use — passes', async () => {
    const body = verdictBlock(HEAD).replace(
      '  red: gate accepted a stale verdict',
      '  red: scripts/ci/trident-verdict.test.ts:171 went red as expected',
    )
    const h = harness({ comments: [body] })
    expect(await runGate(h.deps)).toBe(0)
  })

  test('a path-shaped word that is not a home directory is not caught', () => {
    // The rule is narrow on purpose: it targets the two-segment home-directory
    // shape whose second segment is an account name, not absolute paths generally.
    for (const ok of ['/usr/bin/bun', 'open/composer.ts', 'a/home/b.ts', '/homework/notes.md']) {
      expect(() =>
        parseVerdict(verdictBlock(HEAD).replace('  control: 12/12 green', `  control: ${ok} unchanged`)),
      ).not.toThrow()
    }
  })

  test('a SYNTAX error on a line carrying a home path is quoted REDACTED, not verbatim', async () => {
    // The leak the home-path rule could not reach. `rejectHomePath` runs after the
    // line has parsed, and an unparseable line is quoted back before that — it has
    // to be, or the author cannot find the line to fix. So the quoting path was the
    // one place a public check log could publish an account name, and it is the
    // ordering that made it invisible rather than any missing check.
    for (const p of HOME_PATHS) {
      const body = verdictBlock(HEAD).replace('  red: gate accepted a stale verdict', `  red ${p} no colon here`)
      const h = harness({ comments: [body] })
      expect(await runGate(h.deps)).toBe(1)
      expect(h.output()).toContain('unparseable verdict line')
      // The diagnostic survives — the reader still sees which line — and the account
      // name does not.
      expect(h.output()).toContain('<redacted>')
      expect(h.output()).not.toContain('someone')
    }
  })

  test('and a non-integer count carrying a home path is redacted too, not just the syntax path', async () => {
    // Same class, different message: every refusal that echoes a value is on this
    // hook now, so a future one does not have to rediscover the ordering.
    const body = verdictBlock(HEAD, { 'codex.blocking': '/Users/someone/notes.md' })
    const h = harness({ comments: [body] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).not.toContain('someone')
  })
})

// --------------------------------------------------------------------------- //
// Mutation evidence has to name three DIFFERENT observations
// --------------------------------------------------------------------------- //

describe('one sentence in all three mutation fields is not evidence', () => {
  const same = 'I ran the mutation testing and it was fine'

  test('mutant, red and control repeating the same text is refused', async () => {
    const body = [
      '```review-evidence',
      `commit: ${HEAD}`,
      'codex.ran: true',
      'codex.blocking: 0',
      'adversarial.ran: true',
      'adversarial.blocking: 0',
      `- mutant: ${same}`,
      `  red: ${same}`,
      `  control: ${same}`,
      '```',
    ].join('\n')
    expect(() => parseVerdict(body)).toThrow(/three different observations/)
    const h = harness({ comments: [body] })
    expect(await runGate(h.deps)).toBe(1)
    expect(h.output()).toContain('malformed verdict block')
  })

  test('and TWO of the three matching is refused as well — case and padding do not rescue it', () => {
    const body = verdictBlock(HEAD).replace('  control: 12/12 green', '  control:  Gate Accepted A Stale Verdict ')
    expect(() => parseVerdict(body)).toThrow(/three different observations/)
  })

  test('three genuinely different observations pass — this is a floor, not a style rule', async () => {
    const h = harness({ comments: [verdictBlock(HEAD)] })
    expect(await runGate(h.deps)).toBe(0)
  })

  test("the gate's own control fixture clears this bar too", async () => {
    // A control fixture that could not pass the gate's own guards would report BROKEN
    // LOOKUP on every PR, so the guard and the fixture have to be checked together.
    const control = await selfTest()
    expect(control.ok).toBe(true)
  })
})

// --------------------------------------------------------------------------- //
// Wiring — a gate nothing runs is not a gate
// --------------------------------------------------------------------------- //

const REPO_ROOT = new URL('../..', import.meta.url)
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, REPO_ROOT)), 'utf8')

/**
 * A workflow's COMMENTS are not its behaviour, and asserting against raw file text
 * let the comments satisfy the assertion. This is the exact hole a mutation pass
 * measured: the header comment above the job names `scripts/ci/trident-verdict.ts`
 * and the permissions block's comment quotes `issues: read` and
 * `pull-requests: read` while explaining why both are needed. So gutting the job —
 * `run: echo skipped`, permissions deleted — left the wiring tests GREEN, and the
 * aggregator read the gutted job as a success. The prose that documents a guard
 * cannot be allowed to stand in for the guard.
 *
 * Line structure is preserved (a comment is truncated, never removed) so slicing
 * the file by `indexOf` still lands where it did. A `#` opens a comment only at the
 * start of a line or after whitespace, and never inside a quoted scalar — which is
 * load-bearing for one real line, `echo "PR #$PR head: …"` in the re-run workflow.
 */
const stripYamlComments = (yaml: string): string =>
  yaml
    .split('\n')
    .map((line) => {
      let quote: string | null = null
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!
        if (quote) {
          if (ch === quote) quote = null
          continue
        }
        if (ch === '"' || ch === "'") {
          quote = ch
          continue
        }
        if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i)
      }
      return line
    })
    .join('\n')

describe('the gate is actually wired into CI and into the pre-push hook', () => {
  // Every assertion below reads the CODE, never the commentary around it.
  const ci = stripYamlComments(read('.github/workflows/ci.yml'))

  test('the comment stripper strips comments and nothing else — the control for every assertion here', () => {
    // Without this, a stripper that silently returned its input would restore the
    // hole these tests exist to close, and every one of them would still pass. So
    // the removal is proven POSITIVELY (a sentence that exists only in a comment is
    // gone) and the non-removal is proven too (a `#` inside a quoted scalar stays).
    const raw = read('.github/workflows/ci.yml')
    expect(raw).toContain('does not need a third wording')
    expect(ci).not.toContain('does not need a third wording')
    expect(raw).toContain('is NOT redundant with')
    expect(ci).not.toContain('is NOT redundant with')
    const rerunRaw = read('.github/workflows/trident-verdict-rerun.yml')
    expect(stripYamlComments(rerunRaw)).toContain('echo "PR #$PR head:')
    // And the stripper truncates lines rather than dropping them, which is what
    // keeps `indexOf`-based slicing of the file honest.
    expect(ci.split('\n').length).toBe(raw.split('\n').length)
  })

  test('ci.yml defines a trident-verdict job that RUNS the gate script', () => {
    expect(ci).toMatch(/^ {2}trident-verdict:\s*$/m)
    // The invocation itself, not a mention of the path: replacing the step's body
    // with `echo skipped` leaves a job that succeeds without running the gate,
    // which the aggregator then reads as a satisfied verdict.
    //
    // And the WHOLE LINE, anchored, because a substring check is satisfied by
    // `bun scripts/ci/trident-verdict.ts || true` — a cross-model lane found exactly
    // that hole in the first version of this assertion. The gate's exit code is the
    // only thing the job reports; anything appended to this line discards it.
    expect(ci).toMatch(/^ +run: bun scripts\/ci\/trident-verdict\.ts[ \t]*$/m)
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

  test('the comments fetch has the scope it needs, not the scope it looks like it needs', () => {
    // The verdict is read from `.../issues/{n}/comments`; a PR's conversation
    // comments ARE issue comments, and that endpoint is governed by `issues`, not
    // by `pull-requests`. The only live run of this job took the bypass branch and
    // returned before the fetch, so the happy path's scope was never exercised.
    const job = ci.slice(ci.indexOf('  trident-verdict:'), ci.indexOf('\n  test:'))
    expect(job).toContain('issues: read')
    expect(job).toContain('pull-requests: read')
  })

  test('posting a verdict re-runs the ci run — the gate is not a one-shot read', () => {
    // Without this the gate is self-defeating on every reviewed PR: it reads the
    // comments at the moment it runs, the review lane posts the verdict after that,
    // and no `pull_request` workflow re-triggers on a comment. The check would stay
    // red on a correct branch and every merge would need a hand re-run.
    const rerun = stripYamlComments(read('.github/workflows/trident-verdict-rerun.yml'))
    expect(rerun).toContain('issue_comment')
    expect(rerun).toContain('actions: write')
    // A verdict is EDITABLE and DELETABLE after it is posted, so `created` alone
    // makes "newest verdict wins" false the moment the check goes green: the
    // comment that greened it could be edited into blocking evidence, or deleted,
    // and nothing would look again.
    expect(rerun).toMatch(/types:\s*\[created,\s*edited,\s*deleted\]/)
    // And an edit is matched against the body BEFORE the change as well, because
    // editing a verdict INTO prose leaves no fence in the new body at all.
    expect(rerun).toContain('github.event.changes.body.from')
    // Only a PR comment, only a verdict-shaped one, only from write access — the
    // same author bar the gate itself applies, so a stranger cannot spend runner
    // minutes by pasting the fence.
    expect(rerun).toContain('github.event.issue.pull_request != null')
    expect(rerun).toContain('review-evidence')
    for (const assoc of ['OWNER', 'COLLABORATOR']) {
      expect(rerun).toContain(`author_association == '${assoc}'`)
    }
    // AND THE PREDICATE IS NOT DEAD. Every assertion here is about a SUBSTRING of that
    // one `if:` expression, so prepending `false &&` to it satisfies all of them while
    // the workflow can never fire again — a green check would then stand over a verdict
    // that had been edited away. A cross-model lane found that hole. A literal `false`
    // has no legitimate place in this condition; `!= null` is how the absent case is
    // written here.
    const predicate = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(rerun)
    expect(predicate).not.toBeNull()
    expect(predicate![1]).not.toMatch(/\bfalse\b/)
    // Value for value with the gate's own set, MEMBER included in the exclusion:
    // a trigger list that is WIDER than the gate's is an account that can spend
    // runner minutes on a check it can never satisfy.
    expect(rerun).not.toContain("author_association == 'MEMBER'")
    // Keyed to the head SHA, like everything else here.
    expect(rerun).toContain('head_sha=$head_sha')
    // It must never be able to satisfy the required check itself: it is not a
    // dependency of the `test` aggregator, so it cannot contribute a result to it.
    // Asserted against the `needs:` list rather than the whole file, because
    // ci.yml's prose legitimately names the workflow.
    const needs = /needs:\s*\[([^\]]*)\]/.exec(ci.slice(ci.indexOf('\n  test:')))
    expect(needs).not.toBeNull()
    expect(needs![1]).toContain('trident-verdict')
    expect(needs![1]).not.toContain('rerun')
  })

  test('the CLI turns a failed gate into a NON-ZERO exit — the only thing the job reports', () => {
    // `runGate` returns a code and every test above reads that RETURN VALUE. The
    // entry point's `process.exit(code)` is what makes the code a red check, and
    // nothing reached it: `process.exit(0)` there would have greened every failure
    // in this file with the suite still passing. Found by a cross-model lane.
    //
    // The failing input is a misconfiguration, chosen because it returns before any
    // network call: GITHUB_REPOSITORY empty is refused outright rather than guessed.
    // GitHub Actions always sets that variable, so it is overridden explicitly here.
    const script = 'scripts/ci/trident-verdict.ts'
    const cwd = fileURLToPath(REPO_ROOT)
    const red = Bun.spawnSync(['bun', script], {
      cwd,
      env: { ...process.env, GITHUB_REPOSITORY: '', PR_NUMBER: '', PR_HEAD_SHA: '', PR_HEAD_REF: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(red.exitCode).toBe(1)
    // The redemption reaches the real process's stdout too, not just the injected log.
    expect(new TextDecoder().decode(red.stdout)).toContain('/trident v2 ')
    // AND THE POSITIVE CONTROL, so an unconditional `process.exit(1)` cannot pass this
    // test: the self-test path must still exit 0.
    const green = Bun.spawnSync(['bun', script, '--self-test'], { cwd, stdout: 'pipe', stderr: 'pipe' })
    expect(green.exitCode).toBe(0)
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
// The re-run workflow's SCRIPT is executed, not read
// --------------------------------------------------------------------------- //

/**
 * A text assertion cannot see a one-way door.
 *
 * The previous version of this file checked that the workflow contained the string
 * `gh run rerun --failed`, and that assertion was green over two real defects: the
 * script returned early on a run whose conclusion was `success`, and `--failed`
 * cannot select a verdict job that previously PASSED. Both mean the same thing — once
 * the check was green, no later verdict could ever turn it red, so "the newest
 * verdict wins" was true only while the branch was failing. Reading the file proved
 * a command was mentioned; it could not prove which run reaches it.
 *
 * So the step's script is extracted and RUN, with `gh` replaced by a stub that
 * records its arguments and answers from a fixture. What the workflow does to a
 * green run, to a run still in progress, and to a PR with no run at all is then
 * observable.
 */
describe('the re-run workflow re-reads the comments for a run that already passed', () => {
  const workflow = read('.github/workflows/trident-verdict-rerun.yml')

  // The step body, dedented out of the YAML block scalar. `run: |` is the last
  // block in the file, so everything after it is the script.
  const script = (() => {
    const at = workflow.indexOf('run: |\n')
    expect(at).toBeGreaterThan(0)
    const lines = workflow.slice(at + 'run: |\n'.length).split('\n')
    const indent = /^(\s*)\S/.exec(lines.find((l) => l.trim()) ?? '')![1]!.length
    return lines.map((l) => l.slice(indent)).join('\n')
  })()

  type Run = {
    id: number
    status: string
    conclusion: string | null
    head_branch: string
    /** What the run itself records about which PR it was for. Empty on `push` runs. */
    pull_requests?: { number: number }[]
  }

  /** Run the real script with a stub `gh`, and report what it asked `gh` to do. */
  const exec = (runsPerCall: Run[][], opts: { waitSeconds?: string } = {}) => {
    const head_branch = 'trident/some-work'
    const dir = mkdtempSync(join(tmpdir(), 'trident-rerun-'))
    writeFileSync(join(dir, 'script.sh'), script)
    writeFileSync(
      join(dir, 'pr.json'),
      JSON.stringify({ head: { sha: 'a'.repeat(40), ref: head_branch } }),
    )
    runsPerCall.forEach((runs, i) => {
      writeFileSync(join(dir, `runs-${i}.json`), JSON.stringify({ workflow_runs: runs }))
    })
    // The stub answers the two `gh api` reads from fixtures — advancing one fixture
    // per poll, so a run can be in progress on the first look and finished on the
    // next — and records `gh run rerun` instead of performing it.
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/bin/sh',
        `echo "$*" >> "${join(dir, 'calls')}"`,
        'if [ "$1" = "api" ]; then',
        '  case "$2" in',
        `    */pulls/*) cat "${join(dir, 'pr.json')}" ;;`,
        '    *actions/workflows*)',
        `      n=$(cat "${join(dir, 'poll')}" 2>/dev/null || echo 0)`,
        `      echo $((n + 1)) > "${join(dir, 'poll')}"`,
        `      f="${join(dir, 'runs-')}$n.json"`,
        `      [ -f "$f" ] || f="${join(dir, `runs-${runsPerCall.length - 1}.json`)}"`,
        '      cat "$f" ;;',
        '  esac',
        'fi',
        'exit 0',
      ].join('\n'),
    )
    chmodSync(join(dir, 'gh'), 0o755)
    const p = Bun.spawnSync(['bash', join(dir, 'script.sh')], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        REPO: 'owner/neutron',
        PR: '42',
        WAIT_SECONDS: opts.waitSeconds ?? '60',
        POLL_SECONDS: '0',
      },
    })
    const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : ''
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
      reruns: calls.split('\n').filter((l) => l.startsWith('run rerun')),
    }
  }

  const completed = (conclusion: string): Run[] => [
    { id: 555, status: 'completed', conclusion, head_branch: 'trident/some-work' },
  ]

  test('a run that SUCCEEDED is re-run — a newer blocking verdict can still turn it red', () => {
    // THE round-2 blocker, in executable form. The old script read the conclusion
    // and exited 0 on `success`, so a green check was permanent no matter what the
    // newest verdict said.
    const { code, out, reruns } = exec([completed('success')])
    expect(code).toBe(0)
    expect(reruns).toEqual(['run rerun 555 --repo owner/neutron'])
    expect(out).toContain('Re-running run 555 whole')
  })

  test('the whole run is re-run, never only its failed jobs', () => {
    // `--failed` omits a verdict job that PASSED, which is exactly the job that has
    // to run again when a verdict is edited, deleted, or superseded by a blocking
    // one. Selecting the failed set is the same one-way door as exiting on success.
    for (const conclusion of ['failure', 'cancelled', 'success', 'timed_out']) {
      const { reruns } = exec([completed(conclusion)])
      expect(reruns).toEqual(['run rerun 555 --repo owner/neutron'])
      expect(reruns.join('')).not.toContain('--failed')
    }
  })

  test('an in-progress run is WAITED for, then re-run — not abandoned', () => {
    // The verdict job is short and the rest of the suite is not, so a run still
    // going has very likely already failed the gate against a comment that did not
    // exist yet. The old script exited 0 here and left a correct branch red until
    // somebody re-ran it by hand.
    const inProgress: Run[] = [
      { id: 555, status: 'in_progress', conclusion: null, head_branch: 'trident/some-work' },
    ]
    const { code, out, reruns } = exec([inProgress, inProgress, completed('failure')])
    expect(code).toBe(0)
    expect(out).toContain('status=in_progress')
    expect(reruns).toEqual(['run rerun 555 --repo owner/neutron'])
  })

  test('a wait that times out says how to finish it by hand rather than looping forever', () => {
    // Bounded: an unbounded wait is a hung job. `WAIT_SECONDS=0` puts the deadline
    // in the past on the first look, so the give-up path is the one exercised — and
    // it must hand over the exact command rather than leaving a red check unexplained.
    const queued: Run[] = [{ id: 555, status: 'queued', conclusion: null, head_branch: 'trident/some-work' }]
    const { code, out, reruns } = exec([queued], { waitSeconds: '0' })
    expect(code).toBe(0)
    expect(reruns).toEqual([])
    expect(out).toContain('gh run rerun 555 --repo owner/neutron')
  })

  test('no ci run for the head commit yet is a no-op, not a re-run of something else', () => {
    const { code, reruns, out } = exec([[]])
    expect(code).toBe(0)
    expect(reruns).toEqual([])
    expect(out).toContain('No ci run recorded')
  })

  test("the run that RECORDS this PR number wins, even over a run on this PR's branch name", () => {
    // A branch name is not a PR identity, and selecting on it was the whole tie-break
    // before this tier existed. Both of these runs are for the head commit; the one
    // whose own `pull_requests` names PR 42 is the one whose check this comment is
    // about, and it is deliberately NOT the branch-name match here so that a
    // branch-only selector picks the wrong run and reds this test.
    const branchMatchButOtherPr: Run = {
      id: 999,
      status: 'completed',
      conclusion: 'failure',
      head_branch: 'trident/some-work',
      pull_requests: [{ number: 7 }],
    }
    const mine: Run = {
      id: 555,
      status: 'completed',
      conclusion: 'failure',
      head_branch: 'a-fork-branch-with-another-name',
      pull_requests: [{ number: 42 }],
    }
    const { reruns } = exec([[branchMatchButOtherPr, mine]])
    expect(reruns).toEqual(['run rerun 555 --repo owner/neutron'])
  })

  test('a run that records no PR at all falls through to the branch tier, not to nothing', () => {
    // `pull_requests` is empty on a run triggered by `push`, so the PR tier can
    // legitimately match nothing. It must degrade to the branch signal rather than
    // becoming a filter that stops re-running anything.
    const pushRun: Run = {
      id: 555,
      status: 'completed',
      conclusion: 'failure',
      head_branch: 'trident/some-work',
      pull_requests: [],
    }
    const { reruns } = exec([[pushRun]])
    expect(reruns).toEqual(['run rerun 555 --repo owner/neutron'])
  })

  test("the run belonging to THIS PR's branch is preferred over another PR sharing the head commit", () => {
    // Two open PRs can share a head commit (a branch reopened against a second
    // base). Keyed on the sha alone, the newest run wins even when it belongs to the
    // other PR, and this comment's check is then never re-read.
    const other: Run = { id: 999, status: 'completed', conclusion: 'failure', head_branch: 'someone-else' }
    const mine: Run = { id: 555, status: 'completed', conclusion: 'failure', head_branch: 'trident/some-work' }
    const { reruns } = exec([[other, mine]])
    expect(reruns).toEqual(['run rerun 555 --repo owner/neutron'])
  })

  test('…and with no branch match at all it still re-runs the newest for the commit', () => {
    // The tie-break must not become a filter: a fork PR, or a renamed branch, would
    // otherwise silently stop re-running anything.
    const other: Run = { id: 999, status: 'completed', conclusion: 'failure', head_branch: 'someone-else' }
    const { reruns } = exec([[other]])
    expect(reruns).toEqual(['run rerun 999 --repo owner/neutron'])
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
    // The branch this test actually runs on must not appear AS THE SUBJECT of a
    // redemption command. Asserting on the bare name was brittle in a way CI could
    // never show: the advisory legitimately prints the words `repo=`, `review`,
    // `branch` and `PR #`, so a branch literally named `review` or `branch` would
    // have false-failed — and CI checks out a detached HEAD, where the name is
    // `HEAD` and the assertion is vacuous. Anchoring to the subject phrase makes
    // the check say what it means on any branch name.
    const checkedOut = new TextDecoder()
      .decode(Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: fileURLToPath(REPO_ROOT) }).stdout)
      .trim()
    if (checkedOut && checkedOut !== 'some-other-branch') {
      expect(err).not.toContain(`EXISTING branch ${checkedOut} `)
    }
    // …and the pushed branch IS the subject.
    expect(err).toContain('EXISTING branch some-other-branch ')
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
