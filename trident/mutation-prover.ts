/**
 * @neutronai/trident — the POST-APPROVE MUTATION PROVER.
 *
 * The phase that stands between an Argus APPROVE and the irreversible merge.
 * It is DETERMINISTIC TypeScript: no agent runs here, and — the whole point —
 * no agent composes its output.
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────
 * Given a MUTATION CLAIM (which production line the PR's behaviour rests on,
 * how to break it, which command guards it, which command must be unaffected),
 * it PERFORMS the mutation in a throwaway worktree at the branch head and
 * OBSERVES what happens:
 *
 *   1. apply the mutation      → the file's sha256 MUST change (proof it applied)
 *   2. run the guard  (mutated)→ MUST be RED   (non-zero exit)
 *   3. run the control(mutated)→ MUST be GREEN (zero exit — the mutation is
 *                                specific, not a syntax error that reddens
 *                                everything)
 *   4. restore                 → the file's sha256 MUST equal the original
 *   5. run the guard (restored)→ MUST be GREEN (the red-then-green cycle)
 *
 * Then it emits the evidence block FROM THOSE OBSERVATIONS. Nothing else can.
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────
 * An agent can write a completely convincing "mutation-verified" paragraph
 * without having run a mutation, and a gate that reads text accepts it. On
 * PR #477 a HAND-WRITTEN evidence block carrying INVENTED keys reached the
 * parser; it was rejected for its shape, but a well-formed fake would have
 * armed the gate. Prose is not evidence of execution. So:
 *
 *   • `proved` is derived ONLY from observations this module made itself. A
 *     mutation that was reasoned about, described, or promised is `claimed`,
 *     and the schema keeps the two in SEPARATE fields that never merge.
 *   • Every evidence block carries a `proof_token` — an HMAC over its own
 *     canonical bytes keyed by a secret minted in memory, per prover, that is
 *     never written to disk, never sent to a model, and never leaves the
 *     process. An agent-authored block cannot carry a valid one, so a
 *     fabricated block fails `verify` no matter how well-formed it is.
 *   • `verify` ALSO rejects placeholder-shaped observations (`"<sha256>"`,
 *     `"TODO"`, a "RED" run that exited 0, a red and a green run with byte-
 *     identical output) BEFORE it checks the token, so a fake is rejected
 *     with a reason that names what was wrong rather than an opaque
 *     signature mismatch.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────
 * The CLAIM is untrusted input. A build agent nominates WHICH mutation to
 * run — that is a proposal, echoed verbatim into `claimed` and never
 * consulted when computing `proved`. This module makes "the mutation ran and
 * the guard really moved" un-fakeable; it does not make "the nominated
 * mutation was the interesting one" un-fakeable. That residual is a review
 * question, and Argus still owns it.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HostCommandResult } from './git-mode.ts'
import type { RunHostCommand } from './merge.ts'
import type { TridentRun } from './store.ts'

/** The evidence schema id. Bumped whenever the OBSERVED shape changes. */
export const MUTATION_PROOF_SCHEMA = 'trident.mutation-proof/1'

/** Prover implementation version, recorded in (and signed into) the evidence. */
export const MUTATION_PROVER_VERSION = 1

/** Default wall-clock ceiling for ONE guard/control command. */
export const DEFAULT_PROOF_COMMAND_TIMEOUT_MS = 15 * 60_000

/**
 * The programs a claim may nominate as its guard/control. An allowlist, not a
 * denylist: the claim is agent-authored input that this module EXECUTES, so
 * an unrecognised program is refused rather than run.
 */
const ALLOWED_PROGRAMS: ReadonlySet<string> = new Set([
  'bun',
  'node',
  'npm',
  'pnpm',
  'yarn',
  'bash',
  'sh',
  'make',
  'python3',
  'go',
  'cargo',
])

/**
 * The UNTRUSTED nomination: which production behaviour to break, and which
 * commands prove it. Echoed verbatim into `MutationEvidence.claimed`; never
 * read when deciding `proved`.
 */
export interface MutationClaim {
  /** Repo-relative path of the PRODUCTION file to mutate. */
  file: string
  /** EXACT substring to remove. Must occur exactly once (see `apply`). */
  find: string
  /** What replaces it — the break. Must differ from `find`. */
  replace: string
  /** argv that MUST go RED under the mutation and GREEN once restored. */
  guard: string[]
  /** argv that MUST stay GREEN under the mutation. */
  control: string[]
  /** Free prose from the nominator. Recorded, never parsed. */
  rationale?: string
}

/** One command this module actually ran, and what it saw. */
export interface CommandObservation {
  argv: string[]
  exit_code: number
  /** sha256 of stdout+stderr — a red and a green run cannot share one. */
  output_sha256: string
  timed_out: boolean
}

/** What the prover OBSERVED. Absent (`null`) when it never got to run. */
export interface MutationObservations {
  /** Branch head the proof ran against — a proof is bound to one commit. */
  head_sha: string
  file: string
  file_sha256_before: string
  file_sha256_mutated: string
  file_sha256_restored: string
  guard_mutated: CommandObservation
  control_mutated: CommandObservation
  guard_restored: CommandObservation
}

/**
 * The machine-emitted evidence block. `claimed` (what an agent asserted) and
 * `observed` (what this module saw) are separate by construction, and
 * `proved` is a function of `observed` alone.
 */
export interface MutationEvidence {
  schema: typeof MUTATION_PROOF_SCHEMA
  prover_version: number
  run_id: string
  /** UNTRUSTED echo of the nomination. Never consulted for `proved`. */
  claimed: MutationClaim
  /** Null when the mutation never ran (a bad claim, a git failure, …). */
  observed: MutationObservations | null
  /** True ONLY if the mutation applied AND red-then-green was observed. */
  proved: boolean
  /** Why `proved` is what it is, in one line. */
  reason: string
  /** HMAC over this block's canonical bytes. Unforgeable outside the prover. */
  proof_token: string
}

export interface VerifyResult {
  ok: boolean
  reason: string
}

/** Filesystem seam (tests inject an in-memory pair). */
export interface ProverFs {
  read(path: string): Promise<string>
  write(path: string, contents: string): Promise<void>
}

export interface MutationProverDeps {
  run_host: RunHostCommand
  fs?: ProverFs
  /** Per-command wall-clock ceiling. Default 15 min. */
  command_timeout_ms?: number
  /** Timer seam (tests). Defaults to `setTimeout`. */
  set_timer?: (fn: () => void, ms: number) => unknown
  clear_timer?: (handle: unknown) => void
}

export interface ProveInput {
  run: Pick<TridentRun, 'id' | 'slug' | 'repo_path' | 'branch'>
  claim: MutationClaim
}

/**
 * A prover instance. `prove` is the ONLY producer of a `MutationEvidence`, and
 * `verify` accepts only blocks this SAME instance produced — the signing key
 * lives in this closure and nowhere else, so evidence pasted in by an agent
 * (or replayed from another process) can never verify.
 */
export interface MutationProver {
  prove(input: ProveInput): Promise<MutationEvidence>
  verify(evidence: unknown): VerifyResult
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/**
 * The exact bytes the token signs: every field that carries meaning, in a
 * FIXED order (never `JSON.stringify` of the whole object — key order there is
 * an insertion-order accident, and a token that depends on it would break on a
 * round-trip through the DB).
 */
function canonicalPayload(e: Omit<MutationEvidence, 'proof_token'>): string {
  const o = e.observed
  return JSON.stringify([
    e.schema,
    e.prover_version,
    e.run_id,
    e.proved,
    e.reason,
    [e.claimed.file, e.claimed.find, e.claimed.replace, e.claimed.guard, e.claimed.control],
    o === null
      ? null
      : [
          o.head_sha,
          o.file,
          o.file_sha256_before,
          o.file_sha256_mutated,
          o.file_sha256_restored,
          [o.guard_mutated.argv, o.guard_mutated.exit_code, o.guard_mutated.output_sha256, o.guard_mutated.timed_out],
          [
            o.control_mutated.argv,
            o.control_mutated.exit_code,
            o.control_mutated.output_sha256,
            o.control_mutated.timed_out,
          ],
          [
            o.guard_restored.argv,
            o.guard_restored.exit_code,
            o.guard_restored.output_sha256,
            o.guard_restored.timed_out,
          ],
        ],
  ])
}

/**
 * Reject a claim BEFORE anything is executed. Every branch here is a refusal
 * to run agent-authored input we cannot vouch for — a path that escapes the
 * worktree, a program not on the allowlist, a "mutation" that changes nothing.
 */
function validateClaim(claim: MutationClaim | null | undefined): string | null {
  if (claim === null || claim === undefined || typeof claim !== 'object') {
    return 'no mutation claim was supplied'
  }
  if (typeof claim.file !== 'string' || claim.file.trim().length === 0) return 'claim.file is missing'
  if (claim.file.startsWith('/') || claim.file.split('/').includes('..')) {
    return `claim.file must be a repo-relative path inside the worktree (got ${claim.file})`
  }
  if (typeof claim.find !== 'string' || claim.find.length === 0) return 'claim.find is missing'
  if (typeof claim.replace !== 'string') return 'claim.replace is missing'
  if (claim.find === claim.replace) return 'claim.replace equals claim.find — that mutation changes nothing'
  const guard = validateArgv(claim.guard, 'guard')
  if (guard !== null) return guard
  const control = validateArgv(claim.control, 'control')
  if (control !== null) return control
  return null
}

function validateArgv(argv: unknown, which: string): string | null {
  if (!Array.isArray(argv) || argv.length === 0) return `claim.${which} must be a non-empty argv array`
  if (!argv.every((a) => typeof a === 'string' && a.length > 0)) {
    return `claim.${which} must be an array of non-empty strings`
  }
  const program = argv[0] as string
  if (!ALLOWED_PROGRAMS.has(program)) {
    return `claim.${which} program ${program} is not on the prover allowlist`
  }
  return null
}

/**
 * Decode a NOMINATION off the inner workflow's typed result. Shape only — this
 * is untrusted input, and every semantic check (does the string occur, does the
 * guard actually move) is made by RUNNING it, not by reading it. Anything
 * malformed decodes to null, which the gate treats as "no mutation nominated"
 * and therefore refuses.
 */
export function parseMutationClaim(value: unknown): MutationClaim | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const strings = (x: unknown): string[] | null =>
    Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === 'string' && s.length > 0) ? (x as string[]) : null
  const guard = strings(v.guard)
  const control = strings(v.control)
  if (
    typeof v.file !== 'string' ||
    typeof v.find !== 'string' ||
    typeof v.replace !== 'string' ||
    guard === null ||
    control === null
  ) {
    return null
  }
  return {
    file: v.file,
    find: v.find,
    replace: v.replace,
    guard,
    control,
    ...(typeof v.rationale === 'string' ? { rationale: v.rationale } : {}),
  }
}

/**
 * Where a run's throwaway PROOF worktree lives. Sibling of the merge worktree
 * convention (`merge.ts:runWorktreePath`), and INSIDE the repo for a second
 * reason beyond that one: a guard command has to be runnable there. Because the
 * worktree sits under `<repo>/.trident-worktrees/`, the runtime's upward module
 * resolution finds the base checkout's `node_modules`, so `bun test …` works in
 * a tree that was never installed into.
 *
 * The residual, and which way it fails: a guard that reaches the mutated file
 * through a WORKSPACE ALIAS (`@neutronai/x/…`) resolves to the base checkout,
 * not to this worktree, so it would not see the mutation — and would stay GREEN,
 * which reads as "the guard does not guard this" and BLOCKS the merge. Wrong for
 * the right reason: a proof we could not make is never a proof we made.
 */
export function proofWorktreePath(repo_path: string, run: Pick<TridentRun, 'id' | 'slug'>): string {
  const id8 = run.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'run'
  const slug = run.slug.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'build'
  return join(repo_path, '.trident-worktrees', `proof-${slug}-${id8}`)
}

export function createMutationProver(deps: MutationProverDeps): MutationProver {
  // The signing key. Minted here, held ONLY in this closure: no disk, no DB, no
  // prompt, no env. That is the entire reason an agent cannot mint evidence —
  // it is not a secret it is trusted to keep, it is a secret it never sees.
  const key = randomBytes(32)
  const timeoutMs = deps.command_timeout_ms ?? DEFAULT_PROOF_COMMAND_TIMEOUT_MS
  const setTimer = deps.set_timer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clear_timer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const fs: ProverFs = deps.fs ?? {
    read: (p) => readFile(p, 'utf8'),
    write: (p, c) => writeFile(p, c, 'utf8'),
  }

  function sign(e: Omit<MutationEvidence, 'proof_token'>): MutationEvidence {
    return { ...e, proof_token: createHmac('sha256', key).update(canonicalPayload(e)).digest('hex') }
  }

  function refuse(run_id: string, claim: MutationClaim, reason: string): MutationEvidence {
    return sign({
      schema: MUTATION_PROOF_SCHEMA,
      prover_version: MUTATION_PROVER_VERSION,
      run_id,
      claimed: claim,
      observed: null,
      proved: false,
      reason,
    })
  }

  /**
   * Run one guard/control command, bounded. A command that outlives the
   * ceiling is recorded as `timed_out` with a sentinel exit code: an
   * observation we could not complete is NOT an observation of success, and
   * `evaluate` treats it as such.
   */
  async function observe(argv: string[], cwd: string): Promise<CommandObservation> {
    let handle: unknown = null
    const timeout = new Promise<'timeout'>((resolve) => {
      handle = setTimer(() => resolve('timeout'), timeoutMs)
    })
    let res: HostCommandResult | 'timeout'
    try {
      res = await Promise.race([deps.run_host(argv, cwd), timeout])
    } catch (err) {
      res = { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err), exit_code: -1 }
    } finally {
      clearTimer(handle)
    }
    if (res === 'timeout') {
      return { argv, exit_code: -1, output_sha256: sha256(`timeout:${argv.join(' ')}`), timed_out: true }
    }
    return {
      argv,
      exit_code: res.exit_code,
      output_sha256: sha256(`${res.stdout}\n${res.stderr}`),
      timed_out: false,
    }
  }

  async function prove(input: ProveInput): Promise<MutationEvidence> {
    const { run, claim } = input
    const claimError = validateClaim(claim)
    if (claimError !== null) return refuse(run.id, claim, claimError)
    if (run.branch === null || run.branch.trim().length === 0) {
      return refuse(run.id, claim, 'the run has no branch to prove against')
    }

    const repo = run.repo_path
    const head = await deps.run_host(['git', '-C', repo, 'rev-parse', run.branch], repo)
    const headSha = head.stdout.trim().toLowerCase()
    if (!head.ok || !HEX40.test(headSha)) {
      return refuse(run.id, claim, `could not resolve the head of ${run.branch}`)
    }

    // DETACHED at the head sha, never at the branch name: the branch may still
    // be checked out in the build worktree, and `worktree add <branch>` would
    // fail "already checked out". Detached also means nothing this phase does
    // can move a ref.
    const wt = proofWorktreePath(repo, run)
    await deps.run_host(['git', '-C', repo, 'worktree', 'remove', '--force', wt], repo)
    const add = await deps.run_host(['git', '-C', repo, 'worktree', 'add', '--detach', '--force', wt, headSha], repo)
    if (!add.ok) return refuse(run.id, claim, 'could not provision the proof worktree')

    try {
      return await proveInWorktree(run.id, claim, wt, headSha)
    } finally {
      await deps.run_host(['git', '-C', repo, 'worktree', 'remove', '--force', wt], repo)
      await deps.run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
    }
  }

  async function proveInWorktree(
    run_id: string,
    claim: MutationClaim,
    wt: string,
    headSha: string,
  ): Promise<MutationEvidence> {
    const target = join(wt, claim.file)
    let before: string
    try {
      before = await fs.read(target)
    } catch {
      return refuse(run_id, claim, `${claim.file} does not exist at ${headSha.slice(0, 8)} — the mutation cannot apply`)
    }

    // PROVE THE MUTATION APPLIED, twice over: exactly-one occurrence (two
    // matches means we do not know WHICH line we broke, which is not a proof),
    // and then a changed digest. A mutation that silently no-ops is the exact
    // way a "mutation test" comes back green without having tested anything.
    const occurrences = before.split(claim.find).length - 1
    if (occurrences === 0) {
      return refuse(run_id, claim, `claim.find does not occur in ${claim.file} — the mutation did not apply`)
    }
    if (occurrences > 1) {
      return refuse(run_id, claim, `claim.find occurs ${occurrences}x in ${claim.file} — the mutation is ambiguous`)
    }

    const mutated = before.replace(claim.find, claim.replace)
    const beforeSha = sha256(before)
    const mutatedSha = sha256(mutated)
    if (mutatedSha === beforeSha) {
      return refuse(run_id, claim, `mutating ${claim.file} did not change its bytes — the mutation did not apply`)
    }

    try {
      await fs.write(target, mutated)
    } catch (err) {
      return refuse(run_id, claim, `could not write the mutation: ${err instanceof Error ? err.message : String(err)}`)
    }

    let guardMutated: CommandObservation
    let controlMutated: CommandObservation
    try {
      guardMutated = await observe(claim.guard, wt)
      controlMutated = await observe(claim.control, wt)
    } finally {
      // ALWAYS restore, even if a command threw. The worktree is thrown away
      // either way, but the restored-digest check below is a real observation
      // and it must be made against a real restore.
      await fs.write(target, before).catch(() => undefined)
    }

    let restored: string
    try {
      restored = await fs.read(target)
    } catch {
      return refuse(run_id, claim, `could not re-read ${claim.file} after restoring it`)
    }
    const restoredSha = sha256(restored)
    const guardRestored = await observe(claim.guard, wt)

    const observed: MutationObservations = {
      head_sha: headSha,
      file: claim.file,
      file_sha256_before: beforeSha,
      file_sha256_mutated: mutatedSha,
      file_sha256_restored: restoredSha,
      guard_mutated: guardMutated,
      control_mutated: controlMutated,
      guard_restored: guardRestored,
    }
    const verdict = evaluate(observed)
    return sign({
      schema: MUTATION_PROOF_SCHEMA,
      prover_version: MUTATION_PROVER_VERSION,
      run_id,
      claimed: claim,
      observed,
      proved: verdict.proved,
      reason: verdict.reason,
    })
  }

  function verify(evidence: unknown): VerifyResult {
    const shape = checkShape(evidence)
    if (!shape.ok) return shape
    const e = evidence as MutationEvidence
    const expected = createHmac('sha256', key).update(canonicalPayload(stripToken(e))).digest('hex')
    const got = Buffer.from(e.proof_token, 'hex')
    const want = Buffer.from(expected, 'hex')
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return {
        ok: false,
        reason:
          'evidence proof_token does not verify — this block was not emitted by the prover ' +
          'that is gating this merge (hand-written, replayed, or edited after the fact)',
      }
    }
    return { ok: true, reason: e.reason }
  }

  return { prove, verify }
}

function stripToken(e: MutationEvidence): Omit<MutationEvidence, 'proof_token'> {
  const { proof_token: _token, ...rest } = e
  return rest
}

/**
 * `proved` from observations ALONE. Every clause is something this module
 * WATCHED happen; none of them can be satisfied by describing it.
 */
export function evaluate(o: MutationObservations): { proved: boolean; reason: string } {
  if (o.file_sha256_before === o.file_sha256_mutated) {
    return { proved: false, reason: 'the mutation did not change the file' }
  }
  if (o.guard_mutated.timed_out) {
    return { proved: false, reason: 'the guard timed out under the mutation — no RED was observed' }
  }
  if (o.guard_mutated.exit_code === 0) {
    return {
      proved: false,
      reason: 'the guard PASSED under the mutation — it does not actually guard this behaviour',
    }
  }
  if (o.control_mutated.timed_out || o.control_mutated.exit_code !== 0) {
    return {
      proved: false,
      reason: 'the control did not stay GREEN under the mutation — the mutation broke more than the behaviour under proof',
    }
  }
  if (o.file_sha256_restored !== o.file_sha256_before) {
    return { proved: false, reason: 'the file was not restored to its original bytes' }
  }
  if (o.guard_restored.timed_out || o.guard_restored.exit_code !== 0) {
    return { proved: false, reason: 'the guard did not return to GREEN after the restore' }
  }
  if (o.guard_mutated.output_sha256 === o.guard_restored.output_sha256) {
    return {
      proved: false,
      reason: 'the guard produced byte-identical output RED and GREEN — those cannot be two different runs',
    }
  }
  return {
    proved: true,
    reason: `mutation applied to ${o.file}: guard RED (exit ${o.guard_mutated.exit_code}), control GREEN, restored, guard GREEN`,
  }
}

/**
 * Structural + PLACEHOLDER rejection, run BEFORE the token check so a fake is
 * refused with a reason that names what was wrong. Everything here is a shape
 * a hand-written block gets wrong: a digest that is not 64 hex characters
 * (`"<sha256>"`, `"TODO"`, `""`), a "RED" run that exited 0, a red and a green
 * run whose outputs are byte-identical.
 */
function checkShape(value: unknown): VerifyResult {
  if (value === null || typeof value !== 'object') return { ok: false, reason: 'evidence is not an object' }
  const e = value as Record<string, unknown>
  if (e.schema !== MUTATION_PROOF_SCHEMA) return { ok: false, reason: `evidence schema is not ${MUTATION_PROOF_SCHEMA}` }
  if (e.prover_version !== MUTATION_PROVER_VERSION) {
    return { ok: false, reason: 'evidence prover_version does not match this prover' }
  }
  if (typeof e.proof_token !== 'string' || !HEX64.test(e.proof_token)) {
    return { ok: false, reason: 'evidence proof_token is missing or not a sha256 hex digest' }
  }
  if (e.proved !== true) return { ok: false, reason: 'evidence does not claim `proved`' }
  const o = e.observed
  if (o === null || typeof o !== 'object') {
    return { ok: false, reason: 'evidence is marked proved but carries no observations' }
  }
  const obs = o as Record<string, unknown>
  if (typeof obs.head_sha !== 'string' || !HEX40.test(obs.head_sha)) {
    return { ok: false, reason: 'observed.head_sha is not a commit sha' }
  }
  for (const field of ['file_sha256_before', 'file_sha256_mutated', 'file_sha256_restored'] as const) {
    const v = obs[field]
    if (typeof v !== 'string' || !HEX64.test(v)) {
      return { ok: false, reason: `observed.${field} is not a sha256 digest (placeholder or hand-written)` }
    }
  }
  for (const field of ['guard_mutated', 'control_mutated', 'guard_restored'] as const) {
    const bad = checkObservation(obs[field], field)
    if (bad !== null) return { ok: false, reason: bad }
  }
  const typed = obs as unknown as MutationObservations
  const verdict = evaluate(typed)
  if (!verdict.proved) return { ok: false, reason: `evidence claims proved but its observations do not: ${verdict.reason}` }
  return { ok: true, reason: verdict.reason }
}

function checkObservation(value: unknown, field: string): string | null {
  if (value === null || typeof value !== 'object') return `observed.${field} is missing`
  const c = value as Record<string, unknown>
  if (!Array.isArray(c.argv) || c.argv.length === 0 || !c.argv.every((a) => typeof a === 'string')) {
    return `observed.${field}.argv is not a command`
  }
  if (typeof c.exit_code !== 'number' || !Number.isInteger(c.exit_code)) {
    return `observed.${field}.exit_code is not an integer (placeholder or hand-written)`
  }
  if (typeof c.output_sha256 !== 'string' || !HEX64.test(c.output_sha256)) {
    return `observed.${field}.output_sha256 is not a sha256 digest (placeholder or hand-written)`
  }
  if (typeof c.timed_out !== 'boolean') return `observed.${field}.timed_out is not a boolean`
  return null
}

// ── The prose-only exemption ──────────────────────────────────────────────────

/**
 * Paths whose content cannot change behaviour: documentation and licences.
 *
 * DELIBERATELY NOT "every .md". In THIS repo a markdown file under `skills/`,
 * `prompts/`, `.claude/` or `agent-dispatch/` is EXECUTABLE PROSE — it is an
 * agent's operating contract, and editing it changes what the harness does at
 * runtime as surely as editing a .ts file does. Those are excluded below, so
 * they take the proof path like any other behaviour change.
 */
const PROSE_DIR_DENYLIST = ['skills/', 'prompts/', '.claude/', 'agent-dispatch/', '.github/']
const PROSE_SUFFIXES = ['.md', '.mdx', '.txt']
const PROSE_EXACT = ['LICENSE', 'NOTICE', 'CODEOWNERS']

/**
 * Is this diff PURE PROSE, and therefore exempt from the proof?
 *
 * FAILS CLOSED, at every step. An empty list, a null (the diff could not be
 * read), an unrecognised path, one executable-prose path — every one of them
 * returns false, i.e. REQUIRE THE PROOF. The only `true` is "I read a non-empty
 * list of paths and every single one of them is inert documentation". "I could
 * not tell" is never an exemption; that is how a gate gets talked past.
 */
export function isProseOnlyChange(files: readonly string[] | null | undefined): boolean {
  if (!Array.isArray(files) || files.length === 0) return false
  return files.every((raw) => {
    if (typeof raw !== 'string') return false
    const path = raw.trim()
    if (path.length === 0) return false
    if (PROSE_DIR_DENYLIST.some((dir) => path === dir.slice(0, -1) || path.startsWith(dir))) return false
    if (PROSE_EXACT.includes(path)) return true
    const base = path.slice(path.lastIndexOf('/') + 1)
    if (PROSE_EXACT.includes(base)) return true
    return PROSE_SUFFIXES.some((suffix) => path.endsWith(suffix))
  })
}

/**
 * The files this branch changes against `base`, per git — NEVER per an agent's
 * account of them. Returns null when the diff could not be read, which
 * `isProseOnlyChange` treats as "require the proof".
 */
export async function changedFilesOnBranch(
  run_host: RunHostCommand,
  repo_path: string,
  base_branch: string,
  branch: string | null,
): Promise<string[] | null> {
  if (branch === null || branch.trim().length === 0) return null
  const res = await run_host(['git', '-C', repo_path, 'diff', '--name-only', `${base_branch}...${branch}`], repo_path)
  if (!res.ok) return null
  const files = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return files.length === 0 ? null : files
}

// ── The gate the merge path calls ────────────────────────────────────────────

export interface MutationGateOutcome {
  /** May this APPROVE proceed to merge? */
  ok: boolean
  /** One line for the run note / `failure_reason`. */
  reason: string
  /** True when the prose-only predicate exempted the diff (no proof run). */
  exempt: boolean
  /** The machine-emitted block, for the audit trail. Null when exempt. */
  evidence: MutationEvidence | null
}

export interface MutationGateInput {
  run: Pick<TridentRun, 'id' | 'slug' | 'repo_path' | 'branch'>
  /** The UNTRUSTED nomination harvested off the inner result. */
  claim: MutationClaim | null
  base_branch: string
  run_host: RunHostCommand
  /** Prover override (tests). Production mints a fresh one per gate call. */
  prover?: MutationProver
  fs?: ProverFs
  command_timeout_ms?: number
}

/**
 * THE PHASE. Runs after a verdict reaches APPROVE and BEFORE the merge.
 *
 * Note the shape of the API: there is no way to hand this function an evidence
 * block. It MAKES one by running the mutation, and it is the same call that
 * verifies it. A caller cannot supply evidence, so no agent — however
 * convincing its prose — can put one on this path.
 */
export async function runMutationProofGate(input: MutationGateInput): Promise<MutationGateOutcome> {
  const files = await changedFilesOnBranch(input.run_host, input.run.repo_path, input.base_branch, input.run.branch)
  if (isProseOnlyChange(files)) {
    return { ok: true, reason: 'prose-only diff — mutation proof not required', exempt: true, evidence: null }
  }

  if (input.claim === null || input.claim === undefined) {
    return {
      ok: false,
      reason: 'mutation proof required but the build nominated no mutation to run',
      exempt: false,
      evidence: null,
    }
  }

  const prover =
    input.prover ??
    createMutationProver({
      run_host: input.run_host,
      ...(input.fs !== undefined ? { fs: input.fs } : {}),
      ...(input.command_timeout_ms !== undefined ? { command_timeout_ms: input.command_timeout_ms } : {}),
    })
  const evidence = await prover.prove({ run: input.run, claim: input.claim })
  const verified = prover.verify(evidence)
  if (!verified.ok) {
    // A block WE just produced that came back `proved:false` already carries the
    // specific observation that killed it ("the guard PASSED under the
    // mutation"), and that is what the operator needs on the run row. Falling
    // through to `verify`'s generic wording would replace a diagnosis with a
    // shrug. `verify` is still the authority on whether the merge proceeds.
    const reason = evidence.proved ? verified.reason : evidence.reason
    return { ok: false, reason: `mutation proof rejected: ${reason}`, exempt: false, evidence }
  }
  return { ok: true, reason: `mutation proved: ${evidence.reason}`, exempt: false, evidence }
}
