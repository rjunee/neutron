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
 * ── WHAT MAKES IT ABOUT *THIS* PR ─────────────────────────────────────
 * A red-then-green cycle is only evidence if it is evidence about the merge:
 *
 *   • The nominated file must appear in the branch's own diff. A mutation of
 *     stable, well-guarded code the PR never touches proves the cycle perfectly
 *     and certifies NOTHING — and being diff-independent, one boilerplate
 *     nomination would satisfy this phase forever.
 *   • The guard and the control must be TEST INVOCATIONS, not merely programs
 *     on an allowlist. `bash -c 'grep …'` goes red under any edit of the line
 *     and `sh -c 'echo ok'` is green by construction: that pair walks the whole
 *     cycle without a test process ever starting. A general shell is off the
 *     list entirely (see `TEST_COMMAND_SHAPES`).
 *   • The block is BOUND to a run and a commit, and `verify` checks both — the
 *     branch head is re-read after the proof, so a branch that moved mid-proof
 *     blocks rather than merging a commit nothing ever proved.
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
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import type { HostCommandResult } from './git-mode.ts'
import type { RunHostCommand } from './merge.ts'
import type { TridentRun } from './store.ts'

/** The evidence schema id. Bumped whenever the OBSERVED shape changes. */
export const MUTATION_PROOF_SCHEMA = 'trident.mutation-proof/1'

/** Prover implementation version, recorded in (and signed into) the evidence. */
export const MUTATION_PROVER_VERSION = 1

/**
 * Wall-clock ceiling for the WHOLE proof — guard, control and the restored
 * guard together, not each. The tick loop is single-flight (`tick.ts`), so a
 * per-command ceiling of N is really a 3N stall for every other run on the box.
 */
export const DEFAULT_PROOF_BUDGET_MS = 15 * 60_000

/** Bounded grace to reap a killed command before its worktree is deleted. */
const KILL_GRACE_MS = 5_000

/**
 * The guard/control commands a claim may nominate: an allowlist of TEST-RUNNER
 * INVOCATIONS, not of programs.
 *
 * WHY THE SHAPE AND NOT JUST THE PROGRAM. This is agent-authored input that the
 * module EXECUTES, and the whole gate rests on the guard being a TEST — a thing
 * that can only go red because the behaviour broke. A program allowlist does not
 * give that: `bash -c 'grep -q LIMIT src/limit.ts'` is a "guard" that goes red
 * under any mutation of that line, and `sh -c 'echo ok'` is a "control" that is
 * green by construction. That pair satisfies red-then-green while proving
 * NOTHING, and it is exactly what a boilerplate nomination would converge on. So
 * a general shell is off the list entirely and every remaining program must be
 * invoked in its test form (`bun test …`, `go test …`, `python3 -m pytest …`).
 *
 * Fails closed: an unrecognised program, or a recognised one in a shape that is
 * not its test subcommand, is REFUSED rather than run.
 */
const TEST_COMMAND_SHAPES: ReadonlyArray<{
  program: string
  /** Human-readable form, quoted back in the refusal. */
  shape: string
  ok: (argv: readonly string[]) => boolean
}> = [
  { program: 'bun', shape: 'bun test …', ok: (a) => a[1] === 'test' },
  { program: 'node', shape: 'node --test …', ok: (a) => a.includes('--test') },
  { program: 'npm', shape: 'npm test … / npm run test… ', ok: isPackageScriptTest },
  { program: 'pnpm', shape: 'pnpm test … / pnpm run test…', ok: isPackageScriptTest },
  { program: 'yarn', shape: 'yarn test … / yarn run test…', ok: isPackageScriptTest },
  { program: 'make', shape: 'make test…', ok: (a) => typeof a[1] === 'string' && a[1].startsWith('test') },
  {
    program: 'python3',
    shape: 'python3 -m pytest|unittest …',
    ok: (a) => a[1] === '-m' && (a[2] === 'pytest' || a[2] === 'unittest'),
  },
  { program: 'go', shape: 'go test …', ok: (a) => a[1] === 'test' },
  { program: 'cargo', shape: 'cargo test …', ok: (a) => a[1] === 'test' },
]

function isPackageScriptTest(argv: readonly string[]): boolean {
  if (argv[1] === 'test') return true
  return argv[1] === 'run' && typeof argv[2] === 'string' && argv[2].startsWith('test')
}

/** A source file whose name says it is a test — never a valid mutation target. */
const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$/

/**
 * WHERE A BUILD COMMITS ITS NOMINATION — `.trident/mutation-claims/<branch>.json`.
 *
 * Declared HERE, in the gate, and re-exported by the reader that owns the
 * channel (`mutation-claim-artifact.ts`), because the two rules that keep the
 * channel honest are both enforced in THIS file and neither may drift from the
 * path: a nomination may never nominate ITSELF (`validateClaim`), and a
 * nomination written onto an otherwise-documentation diff may not destroy that
 * diff's prose exemption (`isProseOnlyChange`).
 */
export const MUTATION_CLAIM_ARTIFACT_DIR = '.trident/mutation-claims'

/**
 * THE ONE REFUSAL the committed-nomination reader's note explains: no claim
 * arrived, by either channel. Exported so the orchestrator can append that note
 * to THIS refusal and to no other — a branch-name rejection or a moved tip is
 * not a missing nomination, and suffixing those with "no committed nomination"
 * points the reader at the wrong failure.
 */
export const NO_NOMINATION_REFUSAL = 'mutation proof required but the build nominated no mutation to run'

/**
 * Is this path a committed nomination — the gate's own INPUT rather than code?
 *
 * Compared SEGMENT BY SEGMENT with `.` segments dropped, so `./.trident/…` is
 * the same path as `.trident/…`; a `startsWith` prefix test reads those two as
 * different files and the difference is exactly what a nomination would exploit.
 * The `.json` suffix is required too: only the nomination itself gets these two
 * dispensations, not anything a branch chooses to park in that directory.
 */
function isMutationClaimArtifact(path: string): boolean {
  const segments = path
    .trim()
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
  const dir = MUTATION_CLAIM_ARTIFACT_DIR.split('/')
  if (segments.length <= dir.length || !dir.every((d, i) => segments[i] === d)) return false
  return (segments[segments.length - 1] ?? '').endsWith('.json')
}

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
  /**
   * Resolve a path with every symlink followed, for the containment check in
   * `proveInWorktree`. Optional: an in-memory `fs` has no symlinks, so tests that
   * inject one omit it and the check resolves to the path itself.
   */
  realpath?(path: string): Promise<string>
}

/**
 * How a guard/control command is run. Separate from `RunHostCommand` for two
 * reasons, both of which the git/gh runner cannot serve:
 *
 *  • KILLABILITY. `RunHostCommand` has no abort seam, so a command that outran
 *    the ceiling used to be merely stopped being waited on — it kept running,
 *    kept writing, and the worktree was force-removed out from under it. The
 *    signal here is how the proof actually ends a process it gave up on.
 *  • BLAST RADIUS. This argv is agent-nominated. The production `run_host` is
 *    credentialed (`makeCredentialedHostRunner`) so that `git push` works;
 *    handing that environment to a nominated command is not something this
 *    module should do. `spawnGuardCommand` inherits the plain environment.
 */
export type RunGuardCommand = (argv: string[], cwd: string, signal: AbortSignal) => Promise<HostCommandResult>

export interface MutationProverDeps {
  run_host: RunHostCommand
  /** Runner for the nominated guard/control argv. Defaults to `run_host`. */
  run_guard?: RunGuardCommand
  fs?: ProverFs
  /** Wall-clock ceiling for the WHOLE proof (all three runs). Default 15 min. */
  proof_budget_ms?: number
  /** Timer seam (tests). Defaults to `setTimeout`. */
  set_timer?: (fn: () => void, ms: number) => unknown
  clear_timer?: (handle: unknown) => void
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number
}

export interface ProveInput {
  run: Pick<TridentRun, 'id' | 'slug' | 'repo_path' | 'branch'>
  claim: MutationClaim
  /**
   * The commit to prove, PINNED by the caller. A branch is a mutable ref: when
   * the gate resolved `base...branch` for the diff-binding and `prove` then
   * resolved the branch NAME again, the two could land on different commits, and
   * the file list that bound the proof to this PR belonged to a commit that was
   * no longer being proved. Passing the sha makes both halves read one immutable
   * commit. Omitted (direct callers/tests) → resolve the branch, as before.
   */
  head_sha?: string
}

/**
 * A prover instance. `prove` is the ONLY producer of a `MutationEvidence`, and
 * `verify` accepts only blocks this SAME instance produced — the signing key
 * lives in this closure and nowhere else, so evidence pasted in by an agent
 * (or replayed from another process) can never verify.
 */
export interface MutationProver {
  prove(input: ProveInput): Promise<MutationEvidence>
  verify(evidence: unknown, expect?: VerifyExpectation): VerifyResult
}

/**
 * What the caller believes this block must be BOUND to. The schema documents
 * that a proof belongs to one run and one commit; this is where that stops being
 * documentation. The gate passes the run it is gating and the branch head as it
 * stands AFTER the proof, so a block from another run — or one proved against a
 * commit the branch has since moved off — is refused rather than merged.
 */
export interface VerifyExpectation {
  run_id?: string
  head_sha?: string
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
 *
 * EXPORTED for the test that walks a fully-populated block and asserts every
 * leaf value appears here. A field quietly dropped from this list is a field the
 * token stops protecting, and nothing else in the suite would notice.
 */
export function canonicalPayload(e: Omit<MutationEvidence, 'proof_token'>): string {
  const o = e.observed
  return JSON.stringify([
    e.schema,
    e.prover_version,
    e.run_id,
    e.proved,
    e.reason,
    // `rationale` is signed too, with an explicit null for "absent". It is the
    // human-facing sentence saying WHY this mutation proves the change, so a
    // block whose rationale can be rewritten after the fact while its token
    // still verifies is exactly the "edited after the fact" case this promises
    // to catch. An unsigned optional field is an unprotected one.
    [
      e.claimed.file,
      e.claimed.find,
      e.claimed.replace,
      e.claimed.guard,
      e.claimed.control,
      e.claimed.rationale ?? null,
    ],
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
  // Breaking a test and watching that test fail is a tautology, not a proof:
  // the schema says a PRODUCTION file and this is where that is enforced.
  if (TEST_FILE.test(claim.file)) {
    return `claim.file ${claim.file} is a test file — the mutation must break PRODUCTION behaviour`
  }
  // NOR MAY A NOMINATION NOMINATE ITSELF. The committed nomination is the gate's
  // own input, and on every branch that nominates it is in the diff BY
  // CONSTRUCTION — so the diff-binding check below cannot catch it. Without this
  // line one boilerplate self-nomination plus a test that reads that JSON proves
  // red-then-green while the production change it was supposed to guard ships
  // unproved.
  if (isMutationClaimArtifact(claim.file)) {
    return `claim.file ${claim.file} is a committed nomination — a nomination cannot nominate itself`
  }
  // Nor does mutating documentation prove anything: nothing executes it, so a
  // guard that reddens on it is reading bytes rather than exercising behaviour.
  if (isProseOnlyChange([claim.file])) {
    return `claim.file ${claim.file} is documentation — mutating prose proves nothing about behaviour`
  }
  if (typeof claim.find !== 'string' || claim.find.length === 0) return 'claim.find is missing'
  if (typeof claim.replace !== 'string') return 'claim.replace is missing'
  if (claim.find === claim.replace) return 'claim.replace equals claim.find — that mutation changes nothing'
  const guard = validateArgv(claim.guard, 'guard')
  if (guard !== null) return guard
  const control = validateArgv(claim.control, 'control')
  if (control !== null) return control
  if (JSON.stringify(claim.guard) === JSON.stringify(claim.control)) {
    return 'claim.control is the same command as claim.guard — one command cannot be both the RED and the GREEN'
  }
  return null
}

function validateArgv(argv: unknown, which: string): string | null {
  if (!Array.isArray(argv) || argv.length === 0) return `claim.${which} must be a non-empty argv array`
  if (!argv.every((a) => typeof a === 'string' && a.length > 0)) {
    return `claim.${which} must be an array of non-empty strings`
  }
  const program = argv[0] as string
  const shape = TEST_COMMAND_SHAPES.find((s) => s.program === program)
  if (shape === undefined) {
    return `claim.${which} program ${program} is not a test runner on the prover allowlist`
  }
  if (!shape.ok(argv as string[])) {
    return `claim.${which} must be a test invocation (${shape.shape}), not ${argv.join(' ')}`
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
  const budgetMs = deps.proof_budget_ms ?? DEFAULT_PROOF_BUDGET_MS
  const setTimer = deps.set_timer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clear_timer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const now = deps.now ?? (() => Date.now())
  const runGuard: RunGuardCommand = deps.run_guard ?? ((argv, cwd) => deps.run_host(argv, cwd))
  const fs: ProverFs = deps.fs ?? {
    read: (p) => readFile(p, 'utf8'),
    write: (p, c) => writeFile(p, c, 'utf8'),
    realpath: (p) => realpath(p),
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

  /** Resolve after `ms`, via the injectable timer. */
  function after(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
    let handle: unknown = null
    const promise = new Promise<'timeout'>((resolve) => {
      handle = setTimer(() => resolve('timeout'), ms)
    })
    return { promise, cancel: () => clearTimer(handle) }
  }

  /**
   * Run one guard/control command against the SHARED proof budget.
   *
   * Two properties, both of which the first cut of this got wrong:
   *
   *  • A command that outlives the budget is KILLED (`AbortSignal`), and we then
   *    wait a bounded grace for it to actually die. It used to be merely
   *    abandoned by `Promise.race` — still running, still writing, while the
   *    `finally` in `prove` force-removed the worktree underneath it.
   *  • The ceiling is the budget REMAINING, not a fresh one per command, so the
   *    whole phase is bounded by `proof_budget_ms` rather than 3× it. `tick.ts`
   *    is single-flight: that difference is how long every other run waits.
   *
   * A command we could not complete is recorded `timed_out`, which is NOT an
   * observation of success — `evaluate` refuses on it.
   */
  async function observe(argv: string[], cwd: string, deadline: number): Promise<CommandObservation> {
    const remaining = deadline - now()
    if (remaining <= 0) {
      // The budget is already gone; spawning here could only be killed at once.
      return { argv, exit_code: -1, output_sha256: sha256(`budget-exhausted:${argv.join(' ')}`), timed_out: true }
    }
    const controller = new AbortController()
    const running = runGuard(argv, cwd, controller.signal).catch(
      (err): HostCommandResult => ({
        ok: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exit_code: -1,
      }),
    )
    const ceiling = after(remaining)
    let res: HostCommandResult | 'timeout'
    try {
      res = await Promise.race([running, ceiling.promise])
    } finally {
      ceiling.cancel()
    }
    if (res === 'timeout') {
      controller.abort()
      // Bounded reap: give the killed process a moment to exit before the
      // caller deletes the tree it is running in. A runner that ignores the
      // signal costs us the grace, never the wall clock.
      const grace = after(Math.min(KILL_GRACE_MS, Math.max(1, remaining)))
      try {
        await Promise.race([running, grace.promise])
      } finally {
        grace.cancel()
      }
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
    // The PINNED commit when the caller supplied one — never a second resolution
    // of the branch name. Re-resolving here is what let the diff-binding and the
    // proof describe two different commits (see `ProveInput.head_sha`).
    let headSha: string
    if (input.head_sha !== undefined) {
      headSha = input.head_sha.trim().toLowerCase()
      if (!HEX40.test(headSha)) return refuse(run.id, claim, 'the pinned head sha is not a commit sha')
    } else {
      // THE SAME RESOLVER THE GATE USES — not a second, bare-name `rev-parse`.
      // The primitive that lived here read `run.branch` unqualified and without
      // `--end-of-options`, so a tag or a leading-`-` name answered for the
      // branch. Unreachable from the sole production caller (it always pins
      // `head_sha`), which is exactly why it had to go: an unreachable copy of a
      // fixed bug is the copy that comes back.
      const resolved = await resolveMergeHeadSha(deps.run_host, repo, run.branch, undefined)
      if (resolved === null) return refuse(run.id, claim, `could not resolve the head of ${run.branch}`)
      headSha = resolved
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
      // ONE deadline for the whole proof, started once the worktree exists.
      return await proveInWorktree(run.id, claim, wt, headSha, now() + budgetMs)
    } finally {
      await deps.run_host(['git', '-C', repo, 'worktree', 'remove', '--force', wt], repo)
      await deps.run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
    }
  }

  /**
   * Does `target` still sit under `wt` once every symlink is followed?
   *
   * Both sides are resolved: the worktree root itself can legitimately live
   * under a symlinked prefix (`/tmp` → `/private/tmp`), and comparing a resolved
   * target against an unresolved root would refuse every honest claim there.
   * A target that does not exist yet resolves to itself, so the ordinary
   * "file is missing" refusal below still reports the missing file.
   */
  async function withinWorktree(target: string, wt: string): Promise<boolean> {
    const rp = fs.realpath ?? (async (p: string) => p)
    let root: string
    let leaf: string
    try {
      root = resolve(await rp(wt))
    } catch {
      return false
    }
    try {
      leaf = resolve(await rp(target))
    } catch {
      // Not resolvable (most often: it does not exist). Fall back to the lexical
      // path so a missing file is reported as missing, not as an escape.
      leaf = resolve(target)
    }
    return leaf === root || leaf.startsWith(root.endsWith(sep) ? root : root + sep)
  }

  async function proveInWorktree(
    run_id: string,
    claim: MutationClaim,
    wt: string,
    headSha: string,
    deadline: number,
  ): Promise<MutationEvidence> {
    const target = join(wt, claim.file)

    // CONTAINMENT, resolved rather than assumed. `validateClaim` rejects an
    // absolute path and a `..` segment, but neither says anything about a
    // SYMLINK: the branch under proof is agent-authored, a committed symlink
    // materialises in the proof worktree as a symlink, and `readFile`/`writeFile`
    // follow it. Without this the prover would write the mutation THROUGH the
    // link to a path outside the throwaway tree — a file it does not own, on the
    // host, while running agent-nominated commands. Refuse instead.
    const contained = await withinWorktree(target, wt)
    if (!contained) {
      return refuse(run_id, claim, `${claim.file} resolves outside the proof worktree (a symlink) — refusing to mutate it`)
    }

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

    // REPLACER FUNCTION, never the raw string: `String.prototype.replace` expands
    // `$&`, `$\``, `$'`, `$$` and `$n` in a string replacement, so a claim whose
    // `replace` contains one would write bytes that differ from the `replace` the
    // block goes on to sign. The signed nomination must be what actually hit disk.
    const mutated = before.replace(claim.find, () => claim.replace)
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
      guardMutated = await observe(claim.guard, wt, deadline)
      controlMutated = await observe(claim.control, wt, deadline)
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
    const guardRestored = await observe(claim.guard, wt, deadline)

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

  function verify(evidence: unknown, expect?: VerifyExpectation): VerifyResult {
    const shape = checkShape(evidence)
    if (!shape.ok) return shape
    const e = evidence as MutationEvidence
    // THE BINDING, enforced rather than merely documented. Both of these are
    // signed into the payload, so a mismatch is not forgeable — but without
    // these two lines nothing would ever COMPARE them, and a block proved
    // against another run (or against a commit this branch has since moved off)
    // would sail through on a perfectly valid signature.
    if (expect?.run_id !== undefined && e.run_id !== expect.run_id) {
      return { ok: false, reason: `evidence was proved for run ${e.run_id}, not for this run` }
    }
    if (expect?.head_sha !== undefined && e.observed?.head_sha !== expect.head_sha) {
      return {
        ok: false,
        reason:
          `evidence proves ${String(e.observed?.head_sha).slice(0, 8)} but the branch head is now ` +
          `${expect.head_sha.slice(0, 8)} — the commit that would merge is not the commit that was proved`,
      }
    }
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
      // Two ways to arrive here and the operator has to be able to tell them
      // apart: the guard really does not cover this line, OR the guard reached
      // the code through a workspace alias (`@neutronai/x/…`) that resolves to
      // the base checkout rather than to the proof worktree, so it never saw the
      // mutation at all. Both block the merge — a proof we could not make is not
      // a proof — but only one of them is a bad guard.
      reason:
        `the guard [${argvOf(o.guard_mutated)}] PASSED under the mutation of ${o.file} — either it does not ` +
        'guard this behaviour, or it does not load that file from the proof worktree (a workspace alias)',
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
    // THE AUDIT LINE. The orchestrator writes this onto the run row, and it is
    // signed into the payload, so it names WHICH commands were run: without the
    // argv here a nomination whose "guard" never tests anything reads exactly
    // like a real one on the row that outlives the process.
    reason:
      `mutation applied to ${o.file} @ ${o.head_sha.slice(0, 8)}: guard [${argvOf(o.guard_mutated)}] RED ` +
      `(exit ${o.guard_mutated.exit_code}), control [${argvOf(o.control_mutated)}] GREEN, restored, guard GREEN`,
  }
}

function argvOf(c: CommandObservation): string {
  return Array.isArray(c.argv) ? c.argv.join(' ') : ''
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
  if (typeof e.run_id !== 'string' || e.run_id.length === 0) {
    return { ok: false, reason: 'evidence run_id is missing — a proof belongs to exactly one run' }
  }
  if (typeof e.reason !== 'string') return { ok: false, reason: 'evidence reason is missing' }
  if (e.proved !== true) return { ok: false, reason: 'evidence does not claim `proved`' }
  // `claimed` is signed into the payload, so a block that omits it cannot be
  // canonicalised. Checked HERE, structurally: without this, `canonicalPayload`
  // dereferences `e.claimed.file` and `verify` THROWS on a hand-written block
  // that left the field out — and a crash is not the rejection this promises.
  const claimed = e.claimed
  if (claimed === null || typeof claimed !== 'object') {
    return { ok: false, reason: 'evidence carries no `claimed` nomination' }
  }
  const c = claimed as Record<string, unknown>
  for (const field of ['file', 'find', 'replace'] as const) {
    if (typeof c[field] !== 'string') return { ok: false, reason: `claimed.${field} is missing or not a string` }
  }
  for (const field of ['guard', 'control'] as const) {
    const v = c[field]
    if (!Array.isArray(v) || v.length === 0 || !v.every((a) => typeof a === 'string')) {
      return { ok: false, reason: `claimed.${field} is not a command` }
    }
  }
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
 *
 * MATCHED ON EVERY PATH SEGMENT, not on a repo-root prefix. `skills/x/S.md` and
 * `onboarding/interview/skills/_envelope.md` are the same kind of file, and a
 * root-anchored prefix let the second one through as documentation.
 */
const PROSE_DIR_DENYLIST = ['skills', 'prompts', '.claude', 'agent-dispatch', '.github']

/**
 * `.txt` IS NOT PROSE in this repo, and that is not a nitpick: `scripts/ci/
 * leak-gate-allowlist.txt` decides which secret-leak findings are suppressed and
 * `migrations/expected-schema.txt` is the schema snapshot the migration gate
 * compares against. Both are load-bearing configuration that happens to be
 * plain text, and both merged unproved while `.txt` sat on this list.
 */
const PROSE_SUFFIXES = ['.md', '.mdx']

/** Inert by content, wherever they sit. NOT `CODEOWNERS` — that routes review. */
const PROSE_EXACT = ['LICENSE', 'NOTICE']

/**
 * Markdown that DRIVES the harness, matched by basename anywhere in the tree.
 * `SPEC.md` flips the repo into Ralph mode (`git-mode.ts:defaultRalphModeProbe`)
 * and `IMPLEMENTATION_PLAN.md` is the task list Ralph builds from — editing
 * either changes what the next run DOES, so neither is documentation.
 */
const EXECUTABLE_PROSE_FILES = ['SPEC.md', 'IMPLEMENTATION_PLAN.md', 'CLAUDE.md', 'AGENTS.md', 'SKILL.md']

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
    // THE BUILD'S OWN NOMINATION IS INERT. `.json` is not a prose suffix, so a
    // documentation-only branch that also wrote `.trident/mutation-claims/<b>.json`
    // destroyed its own exemption and became unmergeable — it owed a proof and
    // had no legal target to nominate. The file is the gate's bookkeeping, not
    // code the harness runs, so it neither earns nor forfeits an exemption.
    if (isMutationClaimArtifact(path)) return true
    const segments = path.split('/')
    if (segments.some((segment) => PROSE_DIR_DENYLIST.includes(segment))) return false
    const base = segments[segments.length - 1] ?? ''
    if (EXECUTABLE_PROSE_FILES.includes(base)) return false
    if (PROSE_EXACT.includes(base)) return true
    return PROSE_SUFFIXES.some((suffix) => base.endsWith(suffix))
  })
}

/**
 * The files this branch changes against `base`, per git — NEVER per an agent's
 * account of them. Returns null when the diff could not be read, which
 * `isProseOnlyChange` treats as "require the proof".
 *
 * `ref` should be a PINNED commit sha wherever the answer is going to be used to
 * decide something (the gate passes one): given a branch NAME this re-resolves
 * the ref, and a branch that moves between two such resolutions yields a file
 * list for a commit nobody is proving.
 */
export async function changedFilesOnBranch(
  run_host: RunHostCommand,
  repo_path: string,
  base_branch: string,
  ref: string | null,
): Promise<string[] | null> {
  if (ref === null || ref.trim().length === 0) return null
  const res = await run_host(['git', '-C', repo_path, 'diff', '--name-only', `${base_branch}...${ref}`], repo_path)
  if (!res.ok) return null
  const files = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return files.length === 0 ? null : files
}

/**
 * The production guard/control runner: spawns the nominated argv and — the part
 * `RunHostCommand` cannot do — KILLS it when the proof gives up on it.
 *
 * `SIGKILL` reaches the direct child. A guard that forks its own daemon can
 * still leave a grandchild behind; the bounded reap in `observe` means we do not
 * WAIT on that, and the proof worktree removal is `--force`. That residual is
 * accepted here because the alternative (a process group per guard) is not
 * exposed by `Bun.spawn`.
 */
export async function spawnGuardCommand(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<HostCommandResult> {
  try {
    const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
    const kill = (): void => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // Already gone — nothing to kill.
      }
    }
    if (signal.aborted) kill()
    else signal.addEventListener('abort', kill, { once: true })
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exit_code = await proc.exited
      return { ok: exit_code === 0, stdout: stdout.trim(), stderr: stderr.trim(), exit_code }
    } finally {
      signal.removeEventListener('abort', kill)
    }
  } catch (err) {
    return { ok: false, stdout: '', stderr: String(err), exit_code: -1 }
  }
}

// ── The gate the merge path calls ────────────────────────────────────────────

export interface MutationGateOutcome {
  /** May this APPROVE proceed to merge? */
  ok: boolean
  /**
   * One line for the run note / `failure_reason` — and THE AUDIT TRAIL, because
   * it is the only part of this outcome that outlives the process. The block
   * below cannot be one: its signing key is minted per gate call and dies with
   * it, so a stored block could never be re-verified by anything. `reason`
   * therefore carries the load-bearing facts itself — which file, at which
   * commit, and the guard/control argv that actually ran, which is exactly what
   * a later reader needs in order to spot a "guard" that tested nothing.
   */
  reason: string
  /** True when the prose-only predicate exempted the diff (no proof run). */
  exempt: boolean
  /** The machine-emitted block, for the caller to inspect. Null when exempt. */
  evidence: MutationEvidence | null
}

export interface MutationGateInput {
  run: Pick<TridentRun, 'id' | 'slug' | 'repo_path' | 'branch'>
  /** The UNTRUSTED nomination harvested off the inner result. */
  claim: MutationClaim | null
  base_branch: string
  run_host: RunHostCommand
  /**
   * The commit the MERGE will take, when the caller pins one of its own. This
   * gate pins the branch TIP; `mergePr` pins `reviewedHead` (#545) — the OID the
   * reviewers judged, which is not always the tip. Two independent pins that
   * nobody compares is "proved B, merged A" with both halves looking correct in
   * isolation, so the mismatch is refused here rather than discovered never.
   * Null/absent → the caller has no second pin (local mode, a legacy row); the
   * tip is then the only commit in play, exactly as before.
   *
   * It ALSO serves as the LAST-RESORT head resolution when neither the local nor
   * the remote-tracking ref exists — object-verified in this repo, never trusted
   * as a name. A tip that DOES resolve from a ref and disagrees with this value
   * still refuses, so the fallback can never bypass the mismatch check.
   */
  expected_head?: string | null
  /** Runner for the nominated argv. Defaults to the real, killable spawner. */
  run_guard?: RunGuardCommand
  /** Prover override (tests). Production mints a fresh one per gate call. */
  prover?: MutationProver
  fs?: ProverFs
  proof_budget_ms?: number
}

/**
 * EXPLICIT REJECTIONS FIRST (review round 3): a leading "-" is git reading the
 * name as an OPTION (`--upload-pack=…` runs a local program), and a ":" is git
 * reading it as a REFSPEC (`feat-x:refs/heads/injected-by-branch` writes a
 * LOCAL branch — the wrong-base-guard trap this card exists not to spring).
 * Those two are named checks by review order; the allowlist below subsumes them
 * and the rest of the reviewer's enumerated set (`?*[`, whitespace, control
 * characters, `..`, a trailing `.lock`). This check is PURE on purpose — the
 * resolver must be able to reject a name without handing it to any process.
 * The gate ADDITIONALLY delegates git's full rule set to
 * `check-ref-format --branch` (see branchNameRejection); this is the fast
 * pre-filter, not the authority.
 */
export function isPlainBranchName(branch: string): boolean {
  if (branch.startsWith('-')) return false // explicit: an option, never a name
  if (branch.includes(':')) return false // explicit: a refspec, never a name
  // `_` is legal ANYWHERE in a ref name, first character included — verified:
  // `git check-ref-format --branch _feature` exits 0 and echoes the name. The
  // allowlist excluded it, so the gate refused an otherwise-valid build before
  // git could judge it (review round 3). `_` is inert to a shell we never use
  // and to git's own option parsing, so admitting it widens nothing else.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch)) return false
  return (
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.endsWith('.lock')
  )
}

/**
 * The gate's branch-name check: the pure pre-filter above, then git's OWN rule
 * set via `check-ref-format --branch` — delegated rather than hand-rolled
 * (review round 3) so names the allowlist cannot judge (`a/.hidden`, a
 * mid-path `.lock` component, …) are judged by the interpreter that would
 * receive them. Only a name the pure filter already passed reaches the
 * delegation, so its operand can never begin with "-" or carry a ":". Returns
 * a human-readable rejection, or null when the name is safe. A failing
 * delegation RUN rejects — fail closed: "git could not vouch for it" is not a
 * pass.
 */
export async function branchNameRejection(
  run_host: RunHostCommand,
  repo_path: string,
  branch: string,
): Promise<string | null> {
  if (!isPlainBranchName(branch)) {
    return (
      'it is not a plain branch name (a leading "-" reads as an option, ":" reads as a refspec, and ' +
      '"?*[", whitespace, control characters, "..", and a trailing ".lock" are all ref syntax)'
    )
  }
  const check = await run_host(['git', '-C', repo_path, 'check-ref-format', '--branch', branch], repo_path)
  if (check.ok) return null
  const detail = check.stderr.trim().slice(0, 120)
  // WHY THE TWO REASONS ARE NOT ONE. `reason` is the durable audit trail an
  // operator reads months later, and "git rejects this name" sends them to fix
  // the name while "git never ran" sends them to fix the host. A spawn failure
  // (`spawnCapture` reports exit_code -1 when the child never started) and our
  // own watchdog kill are the second thing, not the first — git never judged
  // the name at all. Both still REFUSE: unverified is not verified.
  if (check.timed_out === true || check.exit_code < 0) {
    return `git check-ref-format --branch could not be RUN, so the name is unverified${detail.length > 0 ? `: ${detail}` : ''}`
  }
  return `git check-ref-format --branch rejects it${detail.length > 0 ? `: ${detail}` : ''}`
}

/**
 * Resolve the head the MERGE would take, without requiring the run's LOCAL
 * branch ref to still exist. A run's worktree — which is what holds the local
 * branch — is routinely cleaned up before this gate runs (#482 refused an
 * APPROVED build exactly this way); the commit itself is still in the object
 * store and reachable through the remote-tracking ref. Resolution order:
 *   1. `refs/heads/<branch>` — fully qualified, never the bare name, so a tag
 *      or a sha-shaped name cannot answer for the branch the merge will take;
 *   2. `refs/remotes/origin/<branch>`, and ONLY when that ref is not SYMBOLIC
 *      (a fetch writes through one, creating a local branch) and ONLY after a
 *      fetch that SUCCEEDED with an explicit forced refspec (see below);
 *   3. the caller's `expected_head` — accepted ONLY as a 40-hex sha, never as
 *      a name, and ONLY when `cat-file -e <sha>^{commit}` proves the object
 *      exists in this repo.
 * Creating the local branch instead is NOT an option: a local branch carrying
 * commits not on origin/main trips the wrong-base guard on the next dispatch.
 * Returns the lowercased sha, or null when nothing resolves — unresolvable
 * stays a refusal at every call site; only the RESOLUTION is widened here.
 *
 * DRIFT, on the `expected_head` path: when no ref resolves there is no ref to
 * observe moving, so the callers' did-the-branch-move re-reads can only return
 * the pin again. That is the honest answer — the branch is gone — and it is
 * fail-safe rather than fail-open: `merge.ts` re-pins the reviewed head and
 * passes `--match-head-commit`, so a head that moved is refused by GitHub.
 */
export async function resolveMergeHeadSha(
  run_host: RunHostCommand,
  repo_path: string,
  branch: string | null,
  expected_head: string | null | undefined,
): Promise<string | null> {
  // A REJECTED NAME RESOLVES NOTHING (review round 3): it does not reach git —
  // not even rev-parse — and it does not fall back to `expected_head`. The gate
  // refuses such a name with its own reason before ever calling this; returning
  // null here keeps every other caller on the same rule. `null` (a legacy row
  // with no branch) is NOT a rejected name: it takes the HEAD path exactly as
  // it always has. No trimming: a whitespace-carrying name is rejected raw,
  // never tidied into a usable one.
  if (branch !== null && !isPlainBranchName(branch)) return null

  // FULLY QUALIFIED, never the bare name. `git rev-parse <name>` walks its
  // disambiguation order, and a TAG beats a branch: with refs/heads/release=A
  // and refs/tags/release=B, `rev-parse --verify release` returns B — and a
  // branch NAMED a 40-hex sha loses to the raw object outright. The merge takes
  // refs/heads/<branch>, so that is the ref the proof must bind to. `null` (a
  // legacy row with no branch) keeps the HEAD path it always had.
  //
  // `--verify --quiet` is not cosmetic: PLAIN `rev-parse` echoes
  // `--end-of-options` itself as the first output line and, on a name it cannot
  // resolve, echoes the name too. `--verify` prints one sha or nothing.
  const local = await run_host(
    [
      'git',
      '-C',
      repo_path,
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      branch === null ? 'HEAD' : `refs/heads/${branch}`,
    ],
    repo_path,
  )
  const localSha = local.stdout.trim().toLowerCase()
  // `local.ok` is load-bearing: a failing `git rev-parse <name>` can still print
  // to stdout, and on a 40-hex-shaped branch name that print is hex — the exit
  // code is the only thing that says git actually resolved it.
  if (local.ok && HEX40.test(localSha)) return localSha

  if (branch !== null) {
    // THE DESTINATION MUST BE A REAL REF, NOT A POINTER TO ONE. `git fetch`
    // writes THROUGH a symbolic ref: with
    // `refs/remotes/origin/<b> -> refs/heads/injected` already planted,
    // `fetch … +refs/heads/<b>:refs/remotes/origin/<b>` creates
    // refs/heads/injected at the remote tip (reproduced on git 2.43.0). That
    // creates a LOCAL branch — the one thing this resolver exists to avoid,
    // because a local branch carrying commits not on origin/main trips the
    // wrong-base guard on the next dispatch — and it makes the ref we then read
    // a ref we did not write. So a symbolic destination DISQUALIFIES the
    // remote-tracking step: no fetch, no read. That is not a refusal, it is one
    // resolution path declining; `expected_head` below is object-verified and a
    // strictly better answer than a ref that points somewhere else.
    const symbolic = await run_host(
      ['git', '-C', repo_path, 'symbolic-ref', '--quiet', '--end-of-options', `refs/remotes/origin/${branch}`],
      repo_path,
    )
    if (!symbolic.ok) {
      // EXPLICIT, FORCED REFSPEC — never `git fetch origin <branch>`. That short
      // form's contract is FETCH_HEAD; whether it also advances
      // `refs/remotes/origin/<branch>` depends on the remote's configured fetch
      // refspec, so on a --no-tags/mirror/partial clone — or a remote with no
      // fetch refspec at all — a STALE tracking ref survives a "successful" fetch
      // and this resolver would pin a commit the review never saw, refusing an
      // approved build forever on the caller-pin check. `merge.ts` documents the
      // same trap for the same reason. `+` forces the update so a force-pushed
      // branch does not fail the fetch and thereby hold forever; `--no-tags`
      // matches every other fetch in trident — this runs in the SHARED repo and
      // tag auto-following would drag tags into it.
      const fetched = await run_host(
        [
          'git',
          '-C',
          repo_path,
          'fetch',
          '--no-tags',
          '--end-of-options',
          'origin',
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ],
        repo_path,
      )
      // A FAILED fetch leaves the tracking ref at whatever it happened to be, so
      // "fetch succeeded" has to MEAN "that ref is current" or reading it is a
      // guess. Skipping it is not a refusal: `expected_head` below is the head the
      // review actually looked at, and it is object-verified — a strictly better
      // answer than an unrefreshed ref.
      if (fetched.ok) {
        const remote = await run_host(
          [
            'git',
            '-C',
            repo_path,
            'rev-parse',
            '--verify',
            '--quiet',
            '--end-of-options',
            `refs/remotes/origin/${branch}`,
          ],
          repo_path,
        )
        const remoteSha = remote.stdout.trim().toLowerCase()
        if (remote.ok && HEX40.test(remoteSha)) return remoteSha
      }
    }
  }

  const expected = expected_head?.trim().toLowerCase() ?? ''
  if (HEX40.test(expected)) {
    // `^{commit}` is the whole check: without the peel, `cat-file -e <sha>` says
    // yes to a tree or a blob, and the gate would pin a sha that can never merge.
    const present = await run_host(['git', '-C', repo_path, 'cat-file', '-e', `${expected}^{commit}`], repo_path)
    if (present.ok) return expected
  }
  return null
}

/** Is the branch still on the commit the gate pinned? */
async function headStillAt(input: MutationGateInput, pinnedSha: string): Promise<boolean> {
  const head = await resolveMergeHeadSha(
    input.run_host,
    input.run.repo_path,
    input.run.branch ?? null,
    input.expected_head,
  )
  return head === pinnedSha
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
  // REJECT THE NAME BEFORE ANY GIT INVOCATION (review round 3). `run.branch` is
  // the inner loop's own UNTRUSTED nomination — nothing upstream checks its
  // shape — and as a git operand it is a live primitive: `--upload-pack=…` runs
  // a local program, `x:refs/heads/y` writes a LOCAL branch. A rejected name is
  // a REFUSAL with its own reason, never a silent fallback: `expected_head`
  // being perfectly valid does not rescue a run whose branch field is trying to
  // be an argument.
  const nominatedBranch = input.run.branch ?? null
  if (nominatedBranch !== null) {
    const rejection = await branchNameRejection(input.run_host, input.run.repo_path, nominatedBranch)
    if (rejection !== null) {
      return {
        ok: false,
        reason:
          `mutation proof refused: the run's branch name ${JSON.stringify(nominatedBranch).slice(0, 80)} ` +
          `is rejected — ${rejection}. It was not passed to git, and no proof can be bound through it.`,
        exempt: false,
        evidence: null,
      }
    }
  }

  // PIN THE COMMIT FIRST, and read everything else off the PIN. A branch is a
  // mutable ref, and this phase used to resolve it three separate times: once
  // for the diff that binds the proof to this PR, once inside `prove`, and once
  // for the final head check. A branch that moved between the first two made the
  // binding describe a commit that was no longer the one being proved — and on
  // the prose-only path, which returned before any sha was resolved at all, a
  // branch that was docs-only when the diff was read could pick up code
  // afterwards and merge with no proof ever run.
  // The RESOLUTION of that one pin is widened (local ref → remote-tracking ref →
  // object-verified `expected_head`) because worktree cleanup deletes the local
  // branch and was refusing APPROVED builds over ref bookkeeping (#482); a head
  // that resolves nowhere is still a refusal.
  const pinnedSha = await resolveMergeHeadSha(
    input.run_host,
    input.run.repo_path,
    input.run.branch ?? null,
    input.expected_head,
  )
  if (pinnedSha === null) {
    return {
      ok: false,
      reason: 'mutation proof required but the branch head could not be resolved — a proof cannot be bound to it',
      exempt: false,
      evidence: null,
    }
  }

  // THE CALLER'S OWN PIN, checked BEFORE the exemption and before the proof: if
  // the commit that would merge is not the commit at the tip, then neither the
  // diff read below nor the proof run against it is about the merge, and the
  // prose-only path would exempt on a diff that is not the one shipping.
  const expected = input.expected_head?.trim().toLowerCase() ?? ''
  if (expected.length > 0 && expected !== pinnedSha) {
    return {
      ok: false,
      reason:
        `mutation proof rejected: the merge would take ${expected.slice(0, 8)} but the branch tip is ` +
        `${pinnedSha.slice(0, 8)} — a proof of the tip says nothing about the commit that would merge`,
      exempt: false,
      evidence: null,
    }
  }

  const files = await changedFilesOnBranch(input.run_host, input.run.repo_path, input.base_branch, pinnedSha)
  if (isProseOnlyChange(files)) {
    // The exemption is bound to the pinned commit like any other outcome: if the
    // branch moved since the pin, THIS is no longer the diff that would merge.
    const stillThere = await headStillAt(input, pinnedSha)
    if (!stillThere) {
      return {
        ok: false,
        reason: 'mutation proof rejected: the branch moved while the prose-only exemption was being decided',
        exempt: false,
        evidence: null,
      }
    }
    return { ok: true, reason: 'prose-only diff — mutation proof not required', exempt: true, evidence: null }
  }

  if (input.claim === null || input.claim === undefined) {
    return { ok: false, reason: NO_NOMINATION_REFUSAL, exempt: false, evidence: null }
  }

  // BIND THE PROOF TO THIS PR. Without this the gate certifies nothing about the
  // merge: a nomination pointing at a stable, well-tested file the PR never
  // touches proves red-then-green perfectly and says NOTHING about the diff — and
  // being diff-independent, one boilerplate nomination would satisfy the phase
  // forever. The proof must break a line THIS branch changed.
  if (files === null) {
    return {
      ok: false,
      reason: 'mutation proof required but the branch diff could not be read — a proof cannot be bound to it',
      exempt: false,
      evidence: null,
    }
  }
  if (!files.includes(input.claim.file)) {
    return {
      ok: false,
      reason:
        `mutation proof rejected: the nominated file ${input.claim.file} is not in this branch's diff — ` +
        'a mutation of a file the PR does not change certifies nothing about this merge',
      exempt: false,
      evidence: null,
    }
  }

  const prover =
    input.prover ??
    createMutationProver({
      run_host: input.run_host,
      run_guard: input.run_guard ?? spawnGuardCommand,
      ...(input.fs !== undefined ? { fs: input.fs } : {}),
      ...(input.proof_budget_ms !== undefined ? { proof_budget_ms: input.proof_budget_ms } : {}),
    })
  // PROVE THE PINNED COMMIT — the same one the file list above came from.
  const evidence = await prover.prove({ run: input.run, claim: input.claim, head_sha: pinnedSha })

  // THE HEAD THE MERGE WILL TAKE, re-read AFTER the proof. A proof is bound to
  // one commit; if the branch moved while it ran, the commit that would merge is
  // not the commit that was proved, and this refuses rather than merges it.
  const headSha = await resolveMergeHeadSha(
    input.run_host,
    input.run.repo_path,
    input.run.branch ?? null,
    input.expected_head,
  )
  if (headSha === null) {
    return {
      ok: false,
      reason: 'mutation proof rejected: could not re-read the branch head to bind the proof to it',
      exempt: false,
      evidence,
    }
  }

  // `head_sha: pinnedSha` and the equality below are the same guarantee read from
  // both ends: the block must prove the commit we pinned, and the branch must
  // still be on it. Comparing only against the RE-READ head would accept a proof
  // of whatever the branch had drifted to.
  if (headSha !== pinnedSha) {
    return {
      ok: false,
      reason:
        `mutation proof rejected: the branch moved from ${pinnedSha.slice(0, 8)} to ${headSha.slice(0, 8)} ` +
        'while the proof ran — the commit that would merge is not the commit that was proved',
      exempt: false,
      evidence,
    }
  }

  const verified = prover.verify(evidence, { run_id: input.run.id, head_sha: pinnedSha })
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
