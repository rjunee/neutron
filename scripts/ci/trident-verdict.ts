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
 * branch is already written, tested and pushed. So every failure path prints the
 * exact command that feeds THIS branch into a review lane — `redeemCommand()`
 * below — because the trident harness re-enters an existing branch WITHOUT
 * `-c` and REUSES its PR rather than opening a duplicate. Rejecting is cheap;
 * redeeming is the part that makes the gate survivable, and therefore the part
 * that makes it stay switched on.
 *
 * NOT A FILE IN THE PR'S OWN DIFF. The record deliberately lives OUTSIDE the
 * branch. A committed `verdict.json` would be self-certifying — the author of
 * the change would also be the author of its approval.
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
/** A value the FAIL template printed and nobody filled in. Rejected everywhere. */
const PLACEHOLDER = /^<[\s\S]*>$/
/** `commit` must be the full SHA — never a truncation, never prose. */
const FULL_SHA = /^[0-9a-f]{40}$/i

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
  const value = Number(trimmed)
  if (value < 0) throw new VerdictError(`${key} must be >= 0, got ${value}`)
  return value
}

function rejectPlaceholder(key: string, value: string): void {
  if (PLACEHOLDER.test(value.trim())) {
    throw new VerdictError(
      `${key} is an unfilled template placeholder (${JSON.stringify(value.trim())}) — ` +
        "the gate's own FAIL template is not a verdict",
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
  for (const [key, value] of scalars) rejectPlaceholder(key, value)

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
  'eslint.config.mjs',
  '.dependency-cruiser.cjs',
])

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
  return EXEC_SUFFIXES.some((suffix) => base.endsWith(suffix))
}

// --------------------------------------------------------------------------- //
// The redeeming command — the reason this gate is survivable
// --------------------------------------------------------------------------- //

/**
 * The command that feeds an ALREADY-WRITTEN branch into a review lane.
 *
 * This is the whole point of the gate's failure output, so it is a function with
 * ONE definition: the CI gate prints it, and `.githooks/pre-push` prints it by
 * calling this file with `--redeem-command`. A second hand-copied spelling would
 * drift, and a drifted redemption path is a gate that only rejects.
 *
 * The spelling is the harness's real one, not an invented shorthand: the review
 * loop takes `branch` and `prNumber`, re-enters that branch WITHOUT `git switch
 * -c`, and reuses the existing PR instead of opening a duplicate. `repo=` is
 * omitted-able (the harness infers it), and is shown as a placeholder rather
 * than a real path because a filesystem path is not portable between machines.
 */
export function redeemCommand(opts: {
  branch?: string | null | undefined
  prNumber?: number | string | null | undefined
}): string {
  const rawBranch = (opts.branch ?? '').toString().trim()
  const branch = rawBranch || '<this branch>'
  const rawPr = (opts.prNumber ?? '').toString().trim()
  const pr = rawPr || '<the PR number>'
  return (
    `/trident v2 repo=<path-to-your-checkout> branch=${branch} prNumber=${pr} ` +
    'review and fix the existing branch, reuse its PR, do not restart from scratch'
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

/**
 * Run the lookup against a known-good input.
 *
 * A tool that cannot read the format reports "no verdict found", which is
 * indistinguishable from the real thing and reads as a finished answer. This
 * turns that class of failure into its own loud outcome.
 */
export function selfTest(): ControlResult {
  try {
    const parsed = parseVerdict(CONTROL_COMMENT)
    const failures = verdictFailures(parsed, CONTROL_HEAD_SHA, { touchesSource: true })
    if (failures.length > 0) {
      return { ok: false, detail: `control verdict did not clear the bar: ${failures.join('; ')}` }
    }
    if (!touchesGatedSurface('open/composer.ts')) {
      return { ok: false, detail: 'control: an executable source path did not classify as gated surface' }
    }
    if (touchesGatedSurface('docs/AS_BUILT.md')) {
      return { ok: false, detail: 'control: a prose path classified as gated surface' }
    }
    return { ok: true, detail: 'control verdict parsed and cleared the bar' }
  } catch (e) {
    return { ok: false, detail: `control verdict failed to parse: ${e instanceof Error ? e.message : String(e)}` }
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
  control?: (() => ControlResult) | undefined
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

function printRedemption(deps: GateDeps, branch: string | undefined, pr: string | undefined): void {
  deps.log('')
  deps.log('NOTHING HERE IS WASTED. The branch is written, pushed and testable — it just has')
  deps.log('no review. Feed IT into a review lane rather than rewriting it:')
  deps.log('')
  deps.log(`    ${redeemCommand({ branch, prNumber: pr })}`)
  deps.log('')
  deps.log('The review loop re-enters an existing branch (no `git switch -c`) and REUSES this')
  deps.log('PR — it will not open a duplicate. When the review reports clean it posts the')
  deps.log('verdict comment for the head SHA and this gate goes green.')
  deps.log('')
  deps.log('If you are recording a review that already happened, comment on this PR with:')
  deps.log('')
  for (const line of evidenceTemplate().split('\n')) deps.log(`    ${line}`)
  deps.log('')
  deps.log('A verdict posted AFTER this run finished cannot retro-green it — nothing')
  deps.log('re-triggers on a comment. Re-run this workflow so the gate re-reads:')
  deps.log('')
  deps.log(`    ${rerunHint(deps)}`)
  deps.log('')
  deps.log('Genuinely need to go around it? Put a NON-EMPTY reason on the head commit:')
  deps.log('')
  // Placeholder-shaped AND indented, so this hint can never arm the hatch if the
  // output is pasted somewhere it becomes a commit message.
  deps.log('    TRIDENT_BYPASS=<why this one cannot wait for a review lane>')
  deps.log('')
  deps.log('at column 0 on its own line in the commit message. It merges, and the reason is')
  deps.log('in the permanent history for whoever asks later. See docs/trident-verdict-gate.md.')
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
    return 1
  }
  if (!headSha || !FULL_SHA.test(headSha)) {
    deps.log(
      `trident-verdict: FAIL — PR_HEAD_SHA is absent or not a full 40-hex SHA (${JSON.stringify(headSha ?? null)}).\n` +
        'A verdict is bound to a commit; without the commit there is nothing to bind it to.',
    )
    return 1
  }

  // POSITIVE CONTROL, before any negative is believed.
  const control = (deps.control ?? selfTest)()
  if (!control.ok) {
    deps.log('trident-verdict: FAIL — THE LOOKUP IS BROKEN, which is not the same as "no verdict".')
    deps.log(`  ${control.detail}`)
    deps.log('')
    deps.log('The verdict parser could not read a known-good fixture, so any "no verdict found"')
    deps.log('result from this run would be a property of the reader, not of the PR. Fix')
    deps.log('scripts/ci/trident-verdict.ts before drawing any conclusion about this branch.')
    return 1
  }

  // The bypass is read FIRST: it is an explicit, recorded decision, and making
  // it wait behind the lookup would only add noise to a merge someone has
  // already chosen to own.
  const commit = (await deps.fetchJson(`repos/${repo}/commits/${headSha}`)) as
    | { commit?: { message?: string } }
    | undefined
  const message = commit?.commit?.message ?? ''
  const bypass = readBypass(message)
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
    deps.log('  recorded in the head commit message, which merges into permanent history.')
    return 0
  }

  const files = (await allPages(deps, `repos/${repo}/pulls/${pr}/files`)) as { filename?: string }[]
  const touchesSource = files.some((f) => touchesGatedSurface(f.filename ?? ''))

  const comments = (await allPages(deps, `repos/${repo}/issues/${pr}/comments`)) as { body?: string }[]
  // Newest first: a re-review supersedes an earlier one. Candidacy uses the SAME
  // anchored fence as the parser, so a comment merely quoting an old block does
  // not displace the newest real verdict.
  const candidates = [...comments].reverse().filter((c) => VERDICT_FENCE.test(c.body ?? ''))

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
    const result = selfTest()
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
