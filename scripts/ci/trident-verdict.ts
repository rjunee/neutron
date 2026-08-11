/**
 * scripts/ci/trident-verdict.ts — the `trident-verdict` CI gate.
 *
 * WHY THIS EXISTS AS CODE. Code in this repo is required to go through the
 * trident build-and-review loop. That requirement was written down, and
 * hand-rolled PRs went around it anyway — twice. A rule that has already failed
 * twice does not need a third, sterner wording; it needs a mechanism that
 * refuses. This is the mechanism.
 *
 * WHAT IT CHECKS. That a trident verdict was RECORDED for the pull request's
 * HEAD COMMIT — the `review-evidence` block the review loop posts as a PR
 * comment. It does not read the findings and judge them; that is the reviewer's
 * job. It checks that a review happened, against THIS commit, and reported
 * clean.
 *
 * KEYED TO THE SHA, NEVER THE BRANCH OR THE PR NUMBER. A verdict names the
 * 40-hex commit it examined, so pushing a fix commit invalidates it and this
 * gate goes red again — a fresh review round is forced rather than inherited.
 * Keying on the branch or the PR would let a clean review of an early revision
 * silently bless whatever landed after it.
 *
 * THE FAILURE IS THE POINT. A gate that only rejects throws away work: the
 * branch is already written, tested and pushed. So every failure path prints two
 * routes that both KEEP it — record a verdict for the head SHA (entirely inside
 * this repository, and the thing this file reads), or hand the branch to a review
 * lane as an explicit instruction to adopt this branch and this PR
 * (`redeemCommand()`). Rejecting is cheap; redeeming is the part that makes the
 * gate survivable, and therefore the part that makes it stay switched on.
 *
 * AND IT PROMISES ONLY WHAT IT CAN KEEP. An earlier version of this output stated
 * that the review harness would re-enter the branch and reuse the PR by itself.
 * It does that when it is HANDED a branch and a PR number, which its crash-resume
 * path does and its typed-start path does not — so the message described a mode
 * nothing entered, and following it produced a second branch and a duplicate PR:
 * the exact waste the redemption exists to prevent. The output now says what the
 * reader must ask for, and names the failure to watch for, instead.
 *
 * NOT A FILE IN THE PR'S OWN DIFF. The record deliberately lives OUTSIDE the
 * branch. A committed `verdict.json` would be self-certifying — the author of
 * the change would also be the author of its approval.
 *
 * AND NOT FROM JUST ANYBODY. This repository is public, so "a comment containing
 * the block" is not a sufficient definition of a verdict: it would let any account
 * on the internet green a required check, or force it red with a malformed one.
 * The comment's author must hold write access — see `TRUSTED_ASSOCIATIONS`.
 *
 * POSITIVE CONTROL. A lookup that cannot read the format returns a negative
 * that looks exactly like an answer ("no verdict found"). Before this gate
 * believes any absence, it parses a known-good fixture through the SAME parser
 * and asserts it passes. If the control fails, the gate reports a BROKEN LOOKUP
 * — a distinct outcome from "no verdict", and still red.
 *
 * Pure functions + injected seams (`fetchJson`, `env`, `log`) so the real entry
 * point `runGate` is unit-testable without a live PR. See
 * `scripts/ci/trident-verdict.test.ts` and `docs/trident-verdict-gate.md`.
 */

import { execFileSync } from 'node:child_process'

/**
 * The fence that opens a verdict block, anchored to column 0 on BOTH lines.
 *
 * Anchoring is load-bearing. A comment that merely QUOTES an older block —
 * indented, or `> `-prefixed, the shape a sloppy reply produces — must not
 * compete for "newest verdict", or a discussion post can displace the real one.
 * `\r` is tolerated so CRLF bodies still parse.
 */
export const VERDICT_FENCE = /^```review-evidence[ \t\r]*\n([\s\S]*?)\n```[ \t\r]*$/m

/** Same pattern, global — used to COUNT blocks in one comment. */
function fenceMatches(body: string): string[] {
  const re = new RegExp(VERDICT_FENCE.source, 'gm')
  const out: string[] = []
  for (const m of body.matchAll(re)) out.push(m[1] ?? '')
  return out
}

const SCALAR = /^([a-z_.]+):[ \t]*(.*?)[ \t]*$/
/**
 * A value the FAIL template printed and nobody filled in. Rejected everywhere.
 *
 * `[^<>]*`, not `[\s\S]*`. The greedy form matched from the FIRST `<` to the LAST
 * `>`, so a filled-in value that merely happens to open and close with angle
 * brackets was refused as unfilled: `TRIDENT_BYPASS=<incident 42> superseded by
 * <p0 fix>` is a real reason, and the greedy regex read it as a template. An
 * unfilled placeholder is by construction ONE bracketed span with no brackets
 * inside it, which is exactly what this matches — every placeholder the templates
 * print still fails it.
 */
const PLACEHOLDER = /^<[^<>]*>$/
/**
 * A filled-in value that still says nothing — the shapes a writer reaches for
 * when there is nothing to report.
 *
 * The PRODUCING side already refuses these: `isUnusableEvidence` in the review
 * harness rejects empty, `<...>`-shaped, and `tbd|n/a|none|unknown` before it
 * posts. This gate applied only the first two, so a HAND-WRITTEN verdict was held
 * to a LOWER bar than a generated one — `- mutant: n/a` satisfied the mutation
 * clause that exists precisely to stop "no mutation was run" passing for one.
 */
const UNUSABLE_VALUE = /^(tbd|t\.b\.d\.?|n\/a|n\.a\.?|na|none|nil|null|unknown|unproven|todo|-+)$/i
/** `commit` must be the full SHA — never a truncation, never prose. */
const FULL_SHA = /^[0-9a-f]{40}$/i
/**
 * A home-directory absolute path, in any of the three shapes a checkout produces.
 *
 * WHY A VERDICT IS SCREENED FOR THIS. The verdict is free text posted publicly on
 * a public repository, and the second segment of `/Users/<name>/…` is a real
 * account name. The leak gate covers FILES and COMMIT MESSAGES; a PR comment is
 * outside its reach entirely, and a comment cannot be un-published — GitHub
 * mirrors it. A live verdict already carried a home-directory worktree path into
 * a public thread, which is what put this rule here.
 *
 * A verdict has no need for one: every path it cites is repo-relative, because
 * the reader is reading it against this repository. So the absolute form is
 * rejected outright rather than redacted, and the message never echoes the value
 * — quoting it in the check log would republish exactly what the rule exists to
 * keep out of public output.
 */
const HOMEDIR_PATH = /(?:^|[^A-Za-z0-9_])(?:\/(?:Users|home)\/|[A-Za-z]:\\Users\\)[^\s/\\]/

export class VerdictError extends Error {}

export interface Mutation {
  mutant: string
  red: string
  control: string
}

export interface Verdict {
  commit: string
  codexRan: boolean
  codexBlocking: number
  adversarialRan: boolean
  adversarialBlocking: number
  mutations: Mutation[]
}

/**
 * Strict: only the literal `true` is true, case-sensitively.
 *
 * A permissive parser lets `ran: probably` or `ran: yes (backgrounded)` read as
 * a completed pass. That is not a hypothetical — a hedge read as clean is how
 * an unfinished review has been mistaken for a finished one before.
 */
function truthy(raw: string): boolean {
  return raw.trim() === 'true'
}

function count(raw: string, key: string): number {
  const trimmed = raw.trim()
  if (!/^-?\d+$/.test(trimmed)) {
    throw new VerdictError(`${key} must be an integer count, got ${JSON.stringify(trimmed)}`)
  }
  // Reject the MINUS SIGN, not the resulting number. `Number('-0')` is `-0`, and
  // `-0 < 0` is false — so a value-based guard lets `-0` through, and a regressed
  // producer emitting `-1` or `-0` would read as "zero blocking findings". A count
  // is never written with a sign, so the sign itself is the defect.
  if (trimmed.startsWith('-')) {
    throw new VerdictError(`${key} must be a non-negative integer count, got ${JSON.stringify(trimmed)}`)
  }
  return Number(trimmed)
}

function rejectPlaceholder(key: string, value: string): void {
  if (PLACEHOLDER.test(value.trim())) {
    throw new VerdictError(
      `${key} is an unfilled template placeholder (${JSON.stringify(value.trim())}) — ` +
        "the gate's own FAIL template is not a verdict",
    )
  }
}

/**
 * Refuse a value carrying a home-directory absolute path. The VALUE IS NEVER
 * ECHOED — the check log is public, so quoting it would republish it.
 */
function rejectHomePath(key: string, value: string): void {
  if (HOMEDIR_PATH.test(value)) {
    throw new VerdictError(
      `${key} contains a home-directory absolute path (not quoted here — this log is public). ` +
        'A verdict is a public comment on a public repository and cannot be un-published, so ' +
        'cite paths repo-relative (`open/composer.ts:11`) and re-post the verdict',
    )
  }
}

function finishMutation(pending: Record<string, string>): Mutation {
  const missing = ['mutant', 'red', 'control'].filter((k) => !(k in pending))
  if (missing.length > 0) {
    throw new VerdictError(`mutation entry missing: ${missing.join(', ')}`)
  }
  for (const [key, value] of Object.entries(pending)) {
    if (!value.trim()) throw new VerdictError(`mutation entry has an empty ${key}`)
    rejectPlaceholder(key, value)
    rejectHomePath(`mutation ${key}`, value)
    if (UNUSABLE_VALUE.test(value.trim())) {
      throw new VerdictError(
        `mutation entry has an unusable ${key} (${JSON.stringify(value.trim())}) — ` +
          'the producing side refuses these values before it posts, and a hand-written ' +
          'verdict is not held to a lower bar than a generated one',
      )
    }
  }
  return { mutant: pending.mutant!, red: pending.red!, control: pending.control! }
}

/**
 * Extract exactly one verdict block from a comment body, or throw.
 *
 * Two blocks in one comment is an error rather than a pick, because choosing one
 * silently is how a stale verdict outlives the commit it described.
 */
export function parseVerdict(commentBody: string): Verdict {
  const blocks = fenceMatches(commentBody)
  if (blocks.length === 0) throw new VerdictError('no ```review-evidence block found')
  if (blocks.length > 1) {
    throw new VerdictError(`${blocks.length} verdict blocks in one comment; expected exactly 1`)
  }

  const scalars = new Map<string, string>()
  const mutations: Mutation[] = []
  let pending: Record<string, string> | null = null

  for (const rawLine of blocks[0]!.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('- mutant:')) {
      if (pending) mutations.push(finishMutation(pending))
      pending = { mutant: line.slice('- mutant:'.length).trim() }
      continue
    }
    const m = SCALAR.exec(line)
    if (!m) throw new VerdictError(`unparseable verdict line: ${JSON.stringify(rawLine)}`)
    const key = m[1]!
    const value = m[2]!
    if (pending && (key === 'red' || key === 'control')) {
      if (key in pending) throw new VerdictError(`duplicate ${key} in one mutation entry`)
      pending[key] = value
      continue
    }
    if (scalars.has(key)) {
      // A contradiction, not an update. Last-line-wins is how a 2 becomes a 0.
      throw new VerdictError(
        `duplicate key ${JSON.stringify(key)} — the later line would silently overwrite ` +
          `${JSON.stringify(scalars.get(key))}, which is how a 2 becomes a 0`,
      )
    }
    scalars.set(key, value)
  }
  if (pending) mutations.push(finishMutation(pending))

  const required = ['commit', 'codex.ran', 'codex.blocking', 'adversarial.ran', 'adversarial.blocking']
  const missing = required.filter((k) => !scalars.has(k))
  if (missing.length > 0) {
    throw new VerdictError(`verdict block missing required keys: ${missing.join(', ')}`)
  }
  for (const [key, value] of scalars) {
    rejectPlaceholder(key, value)
    rejectHomePath(key, value)
  }

  const commit = scalars.get('commit')!.trim()
  if (!FULL_SHA.test(commit)) {
    throw new VerdictError(
      `commit must be the full 40-hex SHA the review examined, got ${JSON.stringify(commit)}`,
    )
  }

  return {
    commit,
    codexRan: truthy(scalars.get('codex.ran')!),
    codexBlocking: count(scalars.get('codex.blocking')!, 'codex.blocking'),
    adversarialRan: truthy(scalars.get('adversarial.ran')!),
    adversarialBlocking: count(scalars.get('adversarial.blocking')!, 'adversarial.blocking'),
    mutations,
  }
}

/**
 * Reasons this verdict does NOT clear the bar. Empty means clear.
 *
 * Each reason is reported separately so a red gate says which leg is missing
 * rather than "review incomplete".
 */
export function verdictFailures(
  verdict: Verdict,
  headSha: string,
  opts: { touchesSource: boolean },
): string[] {
  const failures: string[] = []
  if (verdict.commit.toLowerCase() !== headSha.toLowerCase()) {
    failures.push(
      `the verdict reviewed ${verdict.commit.slice(0, 12)}, HEAD is ${headSha.slice(0, 12)} — ` +
        'the reviewed tree is not the tree being merged, so a fresh review round is owed',
    )
  }
  if (!verdict.codexRan) {
    failures.push('codex.ran is not the literal `true` — a cross-model pass that did not run is not a clean one')
  }
  if (verdict.codexBlocking > 0) failures.push(`${verdict.codexBlocking} unresolved codex P0/P1`)
  if (!verdict.adversarialRan) {
    failures.push('adversarial.ran is not the literal `true` — the independent pass did not run')
  }
  if (verdict.adversarialBlocking > 0) {
    failures.push(`${verdict.adversarialBlocking} unresolved adversarial P0/P1`)
  }
  if (opts.touchesSource && verdict.mutations.length === 0) {
    failures.push(
      'no mutation evidence, and this PR changes executable surface — a guard that only ' +
        'passes is unproven, so the verdict must name a mutant, its RED and a green control',
    )
  }
  return failures
}

// --------------------------------------------------------------------------- //
// Which changed files make mutation evidence mandatory
// --------------------------------------------------------------------------- //

const EXEC_SUFFIXES = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.sh',
  '.py',
  '.sql',
  '.awk',
]
/** Path segments whose subtree is prose or test scaffolding, not product surface. */
const EXEMPT_SEGMENTS = new Set(['__tests__', 'docs', 'node_modules'])
/**
 * Repo-root files that can select or deselect what CI runs. An edit here can
 * deselect a suite, so the file's POWER is what gates it, not its typical diff
 * (the common edit really is a harmless dependency bump).
 */
const ROOT_TEST_SELECTION = new Set([
  'package.json',
  'bunfig.toml',
  'tsconfig.json',
  // The base config every other tsconfig EXTENDS, so it sets `strict`, `paths`
  // and the type surface for the whole tree. Omitting it while listing
  // `tsconfig.json` was a real hole: a PR that only relaxes the base config
  // changes what typecheck accepts everywhere and owed no evidence.
  'tsconfig.base.json',
  'eslint.config.mjs',
  '.dependency-cruiser.cjs',
])
/**
 * Directories whose files are executables regardless of extension.
 *
 * Suffix matching alone classified `bin/neutron` — the CLI entry point — as prose.
 * A shebang script has no extension by convention, so the DIRECTORY is the only
 * signal available, and these two are the ones this tree uses for them.
 */
const EXECUTABLE_DIRS = new Set(['bin', 'scripts'])

/**
 * True when a changed file is on the surface that owes mutation evidence.
 *
 * Gated: `.github/workflows/**` and `.githooks/**` (an edit there can disable
 * gating outright); repo-root test-selection config; and any executable-suffix
 * file that is not a `*.test.*` file and not inside a `__tests__/` or `docs/`
 * subtree.
 *
 * NOT gated, deliberately rather than silently: prose (`**\/*.md`, including
 * normative documents — their overclaims are review's to catch), lockfiles (they
 * pin versions, they cannot select tests), assets, and the `__tests__/`
 * subtrees themselves — so a tests-only PR, INCLUDING one that weakens a guard
 * test, owes no mutation evidence under this clause. That one stays a review
 * duty, and it is named here so nobody rediscovers it as a surprise.
 */
export function touchesGatedSurface(path: string): boolean {
  const parts = path.split('/')
  if (parts.length === 1 && ROOT_TEST_SELECTION.has(parts[0]!)) return true
  if (parts[0] === '.github' && parts[1] === 'workflows') return true
  if (parts[0] === '.githooks') return true
  const base = parts[parts.length - 1]!
  if (/\.test\.[a-z]+$/.test(base)) return false
  if (parts.slice(0, -1).some((seg) => EXEMPT_SEGMENTS.has(seg))) return false
  if (EXEC_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true
  // Extensionless file in an executable directory: a shebang script or the CLI
  // entry point. `.`-less is the test, so `bin/neutron` gates and `bin/logo.svg`
  // still falls through to the suffix rule above.
  return parts.length > 1 && EXECUTABLE_DIRS.has(parts[0]!) && !base.includes('.')
}

/**
 * True when ANY file in the PR's list is on the gated surface.
 *
 * `previous_filename` is consulted, not only `filename`. GitHub reports a rename
 * under its DESTINATION path, so classifying the destination alone lets a rename
 * hide the surface it moved off: `git mv .github/workflows/ci.yml docs/ci.yml`, or
 * a production module renamed to `*.test.ts`, both read as prose-only while
 * changing exactly the behaviour the evidence requirement exists for.
 */
export function filesTouchGatedSurface(files: { filename?: string; previous_filename?: string }[]): boolean {
  return files.some(
    (f) => touchesGatedSurface(f.filename ?? '') || touchesGatedSurface(f.previous_filename ?? ''),
  )
}

// --------------------------------------------------------------------------- //
// The redeeming command — the reason this gate is survivable
// --------------------------------------------------------------------------- //

/**
 * Flag spellings the review-loop dispatcher actually PARSES on a start command.
 *
 * Its parse step recognises the task text plus `repo=`, `rounds=`, `mode=` and a
 * bare `ralph` token. Everything else that LOOKS like a flag is swallowed into
 * the task text — and the task text is what gets slugified into a branch name.
 *
 * That is not a style point, it is the difference between redeeming a branch and
 * duplicating it. The first version of this gate printed `branch=<b>
 * prNumber=<n>`, borrowed from the INNER workflow's argument names, which are
 * real there but are not reachable from the typed command. Pasted verbatim, the
 * two unparsed pairs became part of the task, the dispatcher minted a fresh
 * `trident/<slug-of-that-sentence>` branch, and the redemption opened a SECOND
 * branch and PR — the exact waste the redeeming message exists to prevent.
 *
 * So: the branch and the PR ride in the TASK TEXT, where they are read by the
 * planner and the builder, and nothing in the printed command is flag-shaped
 * unless it is in this set. `assertOnlyParsedFlags` in the test enforces it.
 */
export const DISPATCHER_PARSED_FLAGS = new Set(['repo', 'rounds', 'mode'])

/**
 * The command that hands an ALREADY-WRITTEN branch to a review lane.
 *
 * This is the whole point of the gate's failure output, so it is a function with
 * ONE definition: the CI gate prints it, and `.githooks/pre-push` prints it by
 * calling this file with `--redeem-command`. A second hand-copied spelling would
 * drift, and a drifted redemption path is a gate that only rejects.
 *
 * WHAT THIS COMMAND IS, PRECISELY. It is an INSTRUCTION to adopt this branch and
 * this PR, carried in the task text where the planner and the builder read it.
 * It is NOT a claim that the review harness adopts them by itself, and the
 * previous round of this file made exactly that claim. Verified against the
 * harness rather than assumed:
 *
 *   • its inner build/review workflow DOES re-enter an existing branch without
 *     `git switch -c` and reuse its PR — but only when it is HANDED a branch and
 *     a PR number, and only its crash-resume path hands them over;
 *   • its merge step DOES read an adopted branch name out of the run's state, and
 *     the comment there records why (a batch of hand-dispatched PRs on
 *     non-trident branches that trident could review but then refused to merge) —
 *     but nothing on the typed-start path WRITES that field;
 *   • a typed start therefore begins with no branch and no PR, and mints both
 *     from a slug of the task text.
 *
 * So the branch is redeemed when the LANE IS POINTED AT IT, which is what the
 * sentence in the task text asks for and what `printRedemption` tells the reader
 * to confirm. A lane that answers by opening a fresh branch has not redeemed
 * anything, and the output says so in those words rather than promising it cannot
 * happen. (`repo=` is the one flag here; it is a placeholder because a filesystem
 * path is not portable between machines.)
 */
export function redeemCommand(opts: {
  branch?: string | null | undefined
  prNumber?: number | string | null | undefined
}): string {
  const rawBranch = (opts.branch ?? '').toString().trim()
  const branch = rawBranch || '<this branch>'
  const rawPr = (opts.prNumber ?? '').toString().trim()
  const pr = rawPr ? `PR #${rawPr}` : 'the open PR'
  return (
    `/trident v2 repo=<path-to-your-checkout> review ${pr} on the EXISTING branch ${branch} — ` +
    `ADOPT that branch and that PR: check out ${branch} without creating it, reuse ${pr}, ` +
    'do not restart from scratch and do not open a new PR'
  )
}

// --------------------------------------------------------------------------- //
// The bypass — allowed, but never silent
// --------------------------------------------------------------------------- //

/**
 * Anchored to column 0, like the verdict fence and for the same reason: CI output
 * gets pasted into threads and messages, and the gate's own hint prints the
 * marker indented. An indented copy must never arm the hatch.
 */
const BYPASS_LINE = /^TRIDENT_BYPASS=(.*)$/gm

export type BypassOutcome =
  | { kind: 'none' }
  | { kind: 'bypass'; reason: string }
  | { kind: 'invalid'; detail: string }

/**
 * Read the bypass marker out of the HEAD COMMIT MESSAGE.
 *
 * The commit message is the paper trail on purpose. It is bound to the SHA for
 * free (a new commit needs a new marker, exactly like the verdict), it survives
 * into the merged history, and unlike a PR body or a workflow input it cannot be
 * edited after the fact. A CI environment variable would satisfy the gate while
 * leaving no record at all, which is the failure mode an escape hatch has to
 * avoid.
 *
 * An EMPTY reason can never satisfy it, and neither can an unfilled `<...>`
 * template. Two markers is an error rather than a pick — the same reasoning as a
 * duplicate verdict key.
 */
export function readBypass(commitMessage: string): BypassOutcome {
  const found = [...commitMessage.matchAll(BYPASS_LINE)].map((m) => (m[1] ?? '').trim())
  if (found.length === 0) return { kind: 'none' }
  if (found.length > 1) {
    return {
      kind: 'invalid',
      detail: `${found.length} TRIDENT_BYPASS markers in one commit message — that is a contradiction, not an update`,
    }
  }
  const reason = found[0]!
  if (!reason) {
    return { kind: 'invalid', detail: 'TRIDENT_BYPASS= carries no reason — an empty bypass records nothing' }
  }
  if (PLACEHOLDER.test(reason)) {
    return {
      kind: 'invalid',
      detail: `TRIDENT_BYPASS reason is an unfilled placeholder (${JSON.stringify(reason)})`,
    }
  }
  if (!/[a-z]{3}/i.test(reason)) {
    return {
      kind: 'invalid',
      detail: `TRIDENT_BYPASS reason ${JSON.stringify(reason)} says nothing a reader could act on`,
    }
  }
  return { kind: 'bypass', reason }
}

// --------------------------------------------------------------------------- //
// Positive control — prove the lookup can return a POSITIVE before believing a
// negative
// --------------------------------------------------------------------------- //

/** A verdict that MUST parse and MUST clear the bar. Not a real review. */
export const CONTROL_HEAD_SHA = 'a'.repeat(40)
export const CONTROL_COMMENT = [
  'noise above the block',
  '```review-evidence',
  `commit: ${CONTROL_HEAD_SHA}`,
  'codex.ran: true',
  'codex.blocking: 0',
  'adversarial.ran: true',
  'adversarial.blocking: 0',
  '- mutant: control fixture, not a real review',
  '  red: control fixture, not a real review',
  '  control: control fixture, not a real review',
  '```',
].join('\n')

export interface ControlResult {
  ok: boolean
  detail: string
}

/** The association GitHub reports for the account the review loop posts as. */
const CONTROL_ASSOCIATION = 'OWNER'

/**
 * A fake GitHub for the control: one PR, one executable file, one comment.
 *
 * `comments` is what each case varies. Everything else is the shape the real
 * endpoints return, including the `author_association` the candidate filter
 * reads and the `changed_files` count the truncation check compares against.
 */
function controlApi(comments: { body: string; author_association?: string }[]) {
  return async (path: string): Promise<unknown> => {
    if (path.startsWith('repos/control/control/commits/')) {
      return { commit: { message: 'control: a commit with no bypass marker\n' } }
    }
    if (/\/pulls\/1\/files\?/.test(path)) {
      return /[?&]page=1(&|$)/.test(path) ? [{ filename: 'open/composer.ts' }] : []
    }
    // `author_association` is what the bypass hatch is checked against, so the
    // control models it: a control that omitted it would exercise the gate with an
    // untrusted PR author and stop proving anything about the happy path.
    if (/\/pulls\/1$/.test(path)) return { changed_files: 1, author_association: CONTROL_ASSOCIATION }
    if (/\/comments\?/.test(path)) {
      return /[?&]page=1(&|$)/.test(path) ? comments : []
    }
    throw new Error(`control: the gate asked for an endpoint the control does not model: ${path}`)
  }
}

function controlEnv(): Record<string, string | undefined> {
  return {
    GITHUB_REPOSITORY: 'control/control',
    PR_NUMBER: '1',
    PR_HEAD_SHA: CONTROL_HEAD_SHA,
    PR_HEAD_REF: 'control/branch',
  }
}

/**
 * Run the WHOLE lookup against known-good and known-bad inputs.
 *
 * A tool that cannot read the format reports "no verdict found", which is
 * indistinguishable from the real thing and reads as a finished answer. This turns
 * that class of failure into its own loud outcome.
 *
 * It drives `gate` itself — pagination, API-shape handling, the trusted-author
 * filter, the candidate selection and the comparison — not `parseVerdict` alone.
 * The earlier version called the parser directly, and a mutant that emptied the
 * CANDIDATE FILTER passed that control while reporting "no verdict recorded" for
 * every PR on the repository: a control that does not cover the step that broke
 * proves the gate can read a string, not that it can find a verdict.
 *
 * Three cases, because a control that only proves a POSITIVE cannot detect a
 * lookup stuck at "yes": a good verdict must pass, no verdict must fail, and a
 * verdict for a DIFFERENT sha must fail.
 */
export async function selfTest(): Promise<ControlResult> {
  const quietDeps = (comments: { body: string; author_association?: string }[]): GateDeps => ({
    env: controlEnv(),
    fetchJson: controlApi(comments),
    log: () => {},
    // The control must not recurse into itself.
    control: () => ({ ok: true, detail: 'inner control short-circuited' }),
  })

  const cases: { name: string; comments: { body: string; author_association?: string }[]; want: number }[] = [
    {
      name: 'a known-good verdict for the head sha PASSES',
      comments: [{ body: CONTROL_COMMENT, author_association: CONTROL_ASSOCIATION }],
      want: 0,
    },
    { name: 'no verdict at all FAILS', comments: [{ body: 'control: idle chatter' }], want: 1 },
    {
      name: 'a verdict for a different sha FAILS',
      comments: [
        {
          body: CONTROL_COMMENT.replace(CONTROL_HEAD_SHA, 'f'.repeat(40)),
          author_association: CONTROL_ASSOCIATION,
        },
      ],
      want: 1,
    },
  ]

  try {
    for (const c of cases) {
      const got = await gate(quietDeps(c.comments))
      if (got !== c.want) {
        return { ok: false, detail: `control: ${c.name} — the gate returned ${got}, expected ${c.want}` }
      }
    }
    if (!touchesGatedSurface('open/composer.ts')) {
      return { ok: false, detail: 'control: an executable source path did not classify as gated surface' }
    }
    if (touchesGatedSurface('docs/AS_BUILT.md')) {
      return { ok: false, detail: 'control: a prose path classified as gated surface' }
    }
    return { ok: true, detail: 'control: the full lookup found a good verdict, and rejected an absent and a stale one' }
  } catch (e) {
    return { ok: false, detail: `control: the lookup threw — ${e instanceof Error ? e.message : String(e)}` }
  }
}

// --------------------------------------------------------------------------- //
// The gate
// --------------------------------------------------------------------------- //

const PER_PAGE = 100
const MAX_PAGES = 100

export interface GateDeps {
  env: Record<string, string | undefined>
  /** Fetch ONE page / one object from the GitHub API. Faked in tests. */
  fetchJson: (path: string) => Promise<unknown>
  log: (line: string) => void
  /** Injectable so a broken lookup can be exercised in a test. */
  control?: (() => ControlResult | Promise<ControlResult>) | undefined
}

/**
 * Comment authors whose verdict counts.
 *
 * THIS REPOSITORY IS PUBLIC. Without an author check the gate selected a verdict
 * by BODY alone, so any GitHub account on the internet could post a
 * `review-evidence` block and turn a required check green on a pull request they
 * did not review — and, by posting a deliberately malformed one, could equally
 * force it red, because a malformed newest candidate is fatal by design.
 * "Anyone may comment" is the correct policy for a comment and the wrong one for
 * an approval.
 *
 * `author_association` is what the issue-comments endpoint reports, and these
 * three are the values that mean write access to this repository. CONTRIBUTOR,
 * FIRST_TIME_CONTRIBUTOR, MEMBER-of-some-other-org and NONE are all outside.
 */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

export function isTrustedAuthor(association: string | undefined): boolean {
  return TRUSTED_ASSOCIATIONS.has((association ?? '').trim().toUpperCase())
}

async function allPages(deps: GateDeps, path: string): Promise<unknown[]> {
  const items: unknown[] = []
  const sep = path.includes('?') ? '&' : '?'
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await deps.fetchJson(`${path}${sep}per_page=${PER_PAGE}&page=${page}`)
    if (!Array.isArray(batch)) {
      throw new Error(`trident-verdict: expected a JSON array from ${path}, got ${typeof batch}`)
    }
    items.push(...batch)
    if (batch.length < PER_PAGE) return items
  }
  // A truncated view would classify a >100-file PR as prose-only and would make
  // "newest verdict wins" false past one page of comments. Refuse instead.
  throw new Error(`trident-verdict: ${path} exceeded ${MAX_PAGES * PER_PAGE} items; refusing a truncated view`)
}

function evidenceTemplate(): string {
  // This template must NEVER parse as a valid verdict: CI output gets pasted
  // back into PR threads, and a parseable template would arm the gate by
  // accident. `commit:` stays unfilled (the head SHA is printed only OUTSIDE the
  // fence) and every fill-in value is `<...>`-shaped, which parseVerdict rejects.
  return [
    '```review-evidence',
    'commit: <the full 40-hex head SHA the review examined>',
    'codex.ran: true',
    'codex.blocking: 0',
    'adversarial.ran: true',
    'adversarial.blocking: 0',
    '- mutant: <what production behaviour you broke>',
    '  red: <the test that went RED, with its observed failure>',
    '  control: <the test that stayed GREEN unmutated>',
    '```',
  ].join('\n')
}

/**
 * The exact re-run command for THIS run, not a generic gesture at one.
 *
 * The gate reads the PR's comments at the moment it runs, so a verdict posted 30
 * seconds later is correct and invisible: the check is red, the review is clean,
 * and nothing re-triggers on a comment. That is a known way for a correct branch
 * to sit blocked, so the run id — which the gate already has in its environment —
 * goes straight into the output.
 */
function rerunHint(deps: GateDeps): string {
  const runId = deps.env.GITHUB_RUN_ID
  return runId
    ? `gh run rerun --failed ${runId}`
    : 'gh run rerun --failed <the run id of this ci run on this branch>'
}

/**
 * What to do next, ordered by how much of it this repository can guarantee.
 *
 * The ORDER is the correction from the previous round, which led with a slash
 * command and asserted that the review harness would re-enter this branch and
 * reuse this PR by itself. That assertion was false on the typed-start path (see
 * `redeemCommand`), and a failure message that promises a mode nothing enters is
 * worse than one that promises nothing: the reader follows it, gets a second
 * branch and a duplicate PR, and concludes the gate is the problem.
 *
 * So option 1 is the part that is entirely inside this repository and checked by
 * this very file — review the branch, then RECORD the verdict against the head
 * SHA — and option 2 hands the branch to a lane as an explicit adopt instruction
 * with the failure mode named out loud. Both keep the branch. Neither pretends.
 */
function printRedemption(deps: GateDeps, branch: string | undefined, pr: string | undefined): void {
  deps.log('')
  deps.log('NOTHING HERE IS WASTED. The branch is written, pushed and testable — it just has')
  deps.log('no recorded review. Two ways forward, and BOTH keep this branch and this PR.')
  deps.log('')
  deps.log('1. THE BRANCH HAS BEEN REVIEWED (or you are about to review it) — record the')
  deps.log('   verdict. This is what the gate reads, and it is the whole bar: a comment on')
  deps.log("   THIS PR, from an account with write access, naming this PR's head SHA:")
  deps.log('')
  for (const line of evidenceTemplate().split('\n')) deps.log(`    ${line}`)
  deps.log('')
  deps.log('   A verdict posted AFTER this run finished cannot retro-green it by itself —')
  deps.log('   the gate reads the comments at the moment it runs. Posting one re-runs this')
  deps.log('   workflow automatically (.github/workflows/trident-verdict-rerun.yml); if that')
  deps.log('   does not fire, re-run it by hand:')
  deps.log('')
  deps.log(`    ${rerunHint(deps)}`)
  deps.log('')
  deps.log('2. HAND THE BRANCH TO A REVIEW LANE — as an ADOPT instruction, not a new build:')
  deps.log('')
  deps.log(`    ${redeemCommand({ branch, prNumber: pr })}`)
  deps.log('')
  deps.log('   Check what the lane does with it. A lane that answers by opening a FRESH')
  deps.log('   branch, or a fresh PR, has not redeemed this one — that is a gap in the lane')
  deps.log('   to fix, never a reason to rewrite work that is already written. The branch and')
  deps.log('   the PR are named in the instruction above precisely because adopting them is')
  deps.log('   the thing being asked for, not something that happens on its own.')
  deps.log('')
  deps.log('Genuinely need to go around it? Put a NON-EMPTY reason on the head commit:')
  deps.log('')
  // Placeholder-shaped AND indented, so this hint can never arm the hatch if the
  // output is pasted somewhere it becomes a commit message.
  deps.log('    TRIDENT_BYPASS=<why this one cannot wait for a review lane>')
  deps.log('')
  deps.log('at column 0 on its own line in the commit message, from an account with write')
  deps.log('access. It merges, and the reason is in the permanent history for whoever asks')
  deps.log('later. See docs/trident-verdict-gate.md.')
}

/** Exit code: 0 = a verdict (or a recorded bypass) covers this head SHA, 1 = it does not. */
export async function runGate(deps: GateDeps): Promise<number> {
  try {
    return await gate(deps)
  } catch (e) {
    // An API failure is NOT a verdict result, and it must not read like one. The
    // uncaught form printed a stack trace with no redeeming command, which is the
    // one thing this gate must never do — a red check whose message the author
    // cannot act on is how a gate earns a bypass habit. Still exit 1: "I could not
    // check" must never be worth more than a failed check.
    deps.log('trident-verdict: FAIL — could not READ this PR, which is not the same as "no verdict".')
    deps.log(`  ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
    deps.log('')
    deps.log('The GitHub API call the gate makes did not return usable data (rate limit, a')
    deps.log('transient error, a missing permission). Nothing has been concluded about the')
    deps.log('branch. Re-run the workflow; if it persists, the gate is misconfigured, not the PR.')
    printRedemption(deps, deps.env.PR_HEAD_REF, deps.env.PR_NUMBER)
    return 1
  }
}

async function gate(deps: GateDeps): Promise<number> {
  const repo = deps.env.GITHUB_REPOSITORY
  const pr = deps.env.PR_NUMBER
  const headSha = deps.env.PR_HEAD_SHA
  const branch = deps.env.PR_HEAD_REF

  if (!repo) {
    deps.log('trident-verdict: FAIL — GITHUB_REPOSITORY is not set; refusing to guess the repository.')
    printRedemption(deps, branch, pr)
    return 1
  }
  if (!pr || !/^\d+$/.test(pr)) {
    // Fail CLOSED. This job runs only on `pull_request`, so an absent PR number
    // means a non-PR event reached the gate. Returning 0 here would mint a
    // green-shaped result for a commit nobody reviewed.
    deps.log(
      'trident-verdict: FAIL — PR_NUMBER is absent or not numeric. This gate runs only on\n' +
        'pull_request events; a non-PR invocation must never report green, because a green\n' +
        '(or skipped) run is what an aggregated required check reads as satisfied.',
    )
    printRedemption(deps, branch, pr)
    return 1
  }
  if (!headSha || !FULL_SHA.test(headSha)) {
    deps.log(
      `trident-verdict: FAIL — PR_HEAD_SHA is absent or not a full 40-hex SHA (${JSON.stringify(headSha ?? null)}).\n` +
        'A verdict is bound to a commit; without the commit there is nothing to bind it to.',
    )
    printRedemption(deps, branch, pr)
    return 1
  }

  // POSITIVE CONTROL, before any negative is believed.
  const control = await (deps.control ?? selfTest)()
  if (!control.ok) {
    deps.log('trident-verdict: FAIL — THE LOOKUP IS BROKEN, which is not the same as "no verdict".')
    deps.log(`  ${control.detail}`)
    deps.log('')
    deps.log('The verdict parser could not read a known-good fixture, so any "no verdict found"')
    deps.log('result from this run would be a property of the reader, not of the PR. Fix')
    deps.log('scripts/ci/trident-verdict.ts before drawing any conclusion about this branch.')
    // Still redeems. The author of the branch did nothing wrong here and has the
    // same next move either way; withholding the command only makes a red check
    // they cannot act on, which is how a gate earns a bypass habit.
    printRedemption(deps, branch, pr)
    return 1
  }

  // The PR object, read before anything is decided: it carries BOTH the author
  // association the bypass is checked against and the changed-file count the file
  // list is checked against. `changed_files` is validated later, at the point of
  // use — validating it here would let a malformed count block a legitimate
  // recorded bypass, which is the one path that must stay available.
  const prMeta = (await deps.fetchJson(`repos/${repo}/pulls/${pr}`)) as
    | { changed_files?: unknown; author_association?: unknown }
    | undefined
  const prAuthorAssociation =
    typeof prMeta?.author_association === 'string' ? prMeta.author_association : undefined

  // The bypass is read EARLY: it is an explicit, recorded decision, and making it
  // wait behind the verdict lookup would only add noise to a merge someone has
  // already chosen to own.
  const commit = (await deps.fetchJson(`repos/${repo}/commits/${headSha}`)) as
    | { commit?: { message?: string } }
    | undefined
  const message = commit?.commit?.message ?? ''
  const bypass = readBypass(message)
  // AND IT IS CHECKED FOR AUTHORSHIP, exactly like a verdict. This repository is
  // public and anyone may open a pull request, so a hatch keyed to nothing but a
  // string in a commit message is a hatch every fork author holds: they write
  // their own commit messages, and one line would turn the required check green on
  // a change nobody reviewed. The verdict path has filtered on write access from
  // the start, for this same abuse class; the hatch was the hole left beside it.
  //
  // The available signal is the PULL REQUEST's `author_association` — the commits
  // endpoint reports no association for a commit author. That is the right grain
  // anyway: pushing a commit onto a PR head requires write access to the head
  // branch, so the PR's author is who is accountable for what its head says.
  if (bypass.kind !== 'none' && !isTrustedAuthor(prAuthorAssociation)) {
    deps.log('trident-verdict: FAIL — a TRIDENT_BYPASS marker on a pull request opened by an account')
    deps.log('without write access to this repository. It is not honoured.')
    deps.log('')
    deps.log(`  head SHA          : ${headSha}`)
    deps.log(`  author association: ${prAuthorAssociation ?? '(none reported)'}`)
    deps.log('')
    deps.log('This repository is public and anyone may open a PR, so a hatch that trusts only a')
    deps.log('line in a commit message is a hatch anyone holds — the author of a fork PR writes')
    deps.log('their own commit messages. Only OWNER, MEMBER or COLLABORATOR may record one, the')
    deps.log('same bar a verdict is held to.')
    printRedemption(deps, branch, pr)
    return 1
  }
  if (bypass.kind === 'invalid') {
    deps.log(`trident-verdict: FAIL — ${bypass.detail}.`)
    deps.log('')
    deps.log('A bypass exists so an unusual merge is RECORDED rather than silent. A marker with')
    deps.log('no usable reason records nothing, so it does not count as one.')
    printRedemption(deps, branch, pr)
    return 1
  }
  if (bypass.kind === 'bypass') {
    deps.log(`::notice title=trident-verdict bypassed::${bypass.reason}`)
    deps.log(`trident-verdict: BYPASSED for ${headSha.slice(0, 12)} — no review verdict was required.`)
    deps.log(`  reason: ${bypass.reason}`)
    deps.log('  recorded in the head commit message.')
    deps.log('')
    // A squash merge composes a NEW message from the PR title and body, so the
    // head commit's own body is not guaranteed to survive into the default branch
    // — and after the branch is deleted the reason would be gone while the
    // unreviewed change stayed merged. The gate cannot write the squash message,
    // so it says what has to be carried, loudly, at the moment the hatch is used.
    deps.log('CARRY THIS REASON INTO THE MERGE COMMIT. A squash merge composes its message from')
    deps.log('the PR title and body, not from this commit, so the marker can be dropped on the')
    deps.log('way in — and once the branch is deleted the only record of an unreviewed merge')
    deps.log('goes with it. Put the same line in the PR body, at column 0:')
    deps.log('')
    deps.log(`    TRIDENT_BYPASS=${bypass.reason}`)
    return 0
  }

  // The PR's own count of changed files, read (above) BEFORE the list, so the list
  // can be checked against it. The files endpoint caps at 3,000 files and a capped
  // response is a complete-looking short page — it terminates the paginator
  // exactly like a genuine last page, and a >3,000-file PR would then classify as
  // whatever its first 3,000 files happened to be.
  const changedFiles = prMeta?.changed_files
  if (typeof changedFiles !== 'number' || !Number.isInteger(changedFiles) || changedFiles < 0) {
    throw new Error(
      `the PR endpoint did not report an integer changed_files (got ${JSON.stringify(changedFiles ?? null)}), ` +
        'so the file list cannot be checked for truncation',
    )
  }

  const files = (await allPages(deps, `repos/${repo}/pulls/${pr}/files`)) as {
    filename?: string
    previous_filename?: string
  }[]
  if (files.length < changedFiles) {
    throw new Error(
      `the files endpoint returned ${files.length} of ${changedFiles} changed files — ` +
        'refusing to classify the surface from a truncated list',
    )
  }
  const touchesSource = filesTouchGatedSurface(files)

  const comments = (await allPages(deps, `repos/${repo}/issues/${pr}/comments`)) as {
    body?: string
    author_association?: string
  }[]
  // Newest first: a re-review supersedes an earlier one. Candidacy uses the SAME
  // anchored fence as the parser, so a comment merely quoting an old block does
  // not displace the newest real verdict — AND the author must have write access,
  // because this repository is public and a verdict selected by body alone is an
  // approval anyone on the internet can write.
  const fenced = [...comments].reverse().filter((c) => VERDICT_FENCE.test(c.body ?? ''))
  const candidates = fenced.filter((c) => isTrustedAuthor(c.author_association))
  const untrusted = fenced.length - candidates.length

  if (candidates.length === 0 && untrusted > 0) {
    // Named separately, because "someone posted one and it does not count" is a
    // different fact from "nobody posted one", and the second reads as an
    // instruction to go and review while the first reads as an instruction to
    // argue with the gate.
    deps.log(
      `trident-verdict: FAIL — ${untrusted} review-evidence comment(s) on this PR, none from an account with`,
    )
    deps.log('write access to this repository, so none of them is a verdict.')
    deps.log('')
    deps.log(`  head SHA : ${headSha}`)
    deps.log('')
    deps.log('This repository is public: anyone may comment, so a verdict selected by its body')
    deps.log('alone would be an approval anyone could write. Only OWNER, MEMBER or COLLABORATOR')
    deps.log('comments count.')
    printRedemption(deps, branch, pr)
    return 1
  }

  if (candidates.length === 0) {
    deps.log('trident-verdict: FAIL — no trident verdict recorded for this PR\'s head commit.')
    deps.log('')
    deps.log(`  head SHA : ${headSha}`)
    deps.log(`  surface  : ${touchesSource ? 'executable — mutation evidence required' : 'prose only'}`)
    deps.log('')
    deps.log('Code in this repo goes through the build-and-review loop. The verdict is keyed to')
    deps.log('the head SHA, so a later fix commit invalidates an earlier approval by design.')
    printRedemption(deps, branch, pr)
    return 1
  }

  let verdict: Verdict
  try {
    verdict = parseVerdict(candidates[0]!.body ?? '')
  } catch (e) {
    deps.log(`trident-verdict: FAIL — malformed verdict block: ${e instanceof Error ? e.message : String(e)}`)
    printRedemption(deps, branch, pr)
    return 1
  }

  const failures = verdictFailures(verdict, headSha, { touchesSource })
  if (failures.length > 0) {
    deps.log('trident-verdict: FAIL')
    for (const reason of failures) deps.log(`  - ${reason}`)
    printRedemption(deps, branch, pr)
    return 1
  }

  deps.log(
    `trident-verdict: PASS — reviewed at ${verdict.commit.slice(0, 12)} (this PR's head), ` +
      `${verdict.mutations.length} mutation(s) named.`,
  )
  return 0
}

// --------------------------------------------------------------------------- //
// CLI
// --------------------------------------------------------------------------- //

function ghApi(path: string): unknown {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (!token) throw new Error('trident-verdict: GITHUB_TOKEN is not set')
  const out = execFileSync('gh', ['api', path], {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(out) as unknown
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }

  if (argv.includes('--redeem-command')) {
    // The single source of the redeeming command, for the pre-push hook.
    process.stdout.write(`${redeemCommand({ branch: flag('branch'), prNumber: flag('pr') })}\n`)
    process.exit(0)
  }

  if (argv.includes('--self-test')) {
    const result = await selfTest()
    process.stdout.write(`trident-verdict self-test: ${result.ok ? 'OK' : 'BROKEN'} — ${result.detail}\n`)
    process.exit(result.ok ? 0 : 1)
  }

  const code = await runGate({
    env: process.env,
    fetchJson: async (path) => ghApi(path),
    log: (line) => process.stdout.write(`${line}\n`),
  })
  process.exit(code)
}
