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
 *
 * NOR IS THE MOVEMENT ITSELF SELF-EXPLAINING. The guard is argv, and a branch
 * may commit a file the runner obeys without the argv naming it — a root
 * `bunfig.toml` `[test] preload`, jest `setupFiles`, `conftest.py`. Then a
 * perfectly honest-looking guard loads the mutated file and moves red-then-
 * green with nothing having asserted the mutated behaviour. A spelling that
 * puts such a load ON the argv is refused — the two-dash options of
 * `LOAD_HOOK_OPTION`, go's one-dash `GO_TOOLCHAIN_HOOK_OPTION`, and every
 * WRAPPER whose body is a file (`npm`/`pnpm`/`yarn`/`make` at
 * `forwardsPositionalsToAScript`, and `node --run`, refused at its shape) —
 * bar the short-letter residuals NAMED at `LOAD_HOOK_OPTION` (pytest's `-p`,
 * mocha's `-R`), whose letters collide with other runners' flags. The
 * committed-config half cannot be read out of argv at all and stays a review
 * question with the residual above.
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
  {
    program: 'node',
    shape: 'node --test … (--test FIRST, never --run)',
    ok: (a) => a[1] === '--test' && !a.some(isNodeRunOption),
  },
  { program: 'npm', shape: 'npm test … / npm run test… ', ok: isPackageScriptTest },
  { program: 'pnpm', shape: 'pnpm test … / pnpm run test…', ok: isPackageScriptTest },
  { program: 'yarn', shape: 'yarn test … / yarn run test…', ok: isPackageScriptTest },
  { program: 'make', shape: 'make test…', ok: (a) => typeof a[1] === 'string' && a[1].startsWith('test') },
  {
    // BOTH PYTHON SPELLINGS ARE DEAD IN A CONVENTIONAL PYTHON REPO, and that
    // aggregate is stated here because no single arm states it: the runner
    // provenance arms in `proveInWorktree` read the tree, and the standard
    // layout trips them twice over — a root `pyproject.toml` refuses `-m pytest`
    // (`pytestConfigShadow` matches its basename at any depth) and a
    // `tests/__init__.py` refuses `-m unittest` (`pythonPackageShadow`). There
    // is no third python spelling, so such a repo must nominate `go`, `cargo`,
    // `bun` or `node --test` instead, and a python-only one has no nominatable
    // guard at all. It fails CLOSED — an over-refusal, never a forged proof —
    // and it is latent here, where every runner is bun. Relieving it means
    // scoping those arms to branch-authored files the way `bunConfigCandidates`
    // is scoped — a silent widening is exactly what must not happen here, so it
    // is carried as a NAMED follow-up card rather than a comment that ages out:
    //
    //   "trident: diff-scope the python runner-provenance arms so `python3 -m`
    //    is nominatable in a conventional python repo"
    //
    // recorded under Deferred in IMPLEMENTATION_PLAN.md with the two arms it has
    // to move (`pytestConfigShadow`, `pythonPackageShadow`) and the reason the
    // bun scoping is sound. Until that card lands, the entry below is REACHABLE
    // ONLY in a repo whose root carries no pytest ini file and whose test
    // directories carry no `__init__`, which is not the conventional layout.
    //
    // AND IT IS WIDER THAN "A PYTHON REPO": the basename match runs at ANY
    // depth, so ONE nested `pyproject.toml` anywhere in a polyglot tree — a
    // vendored sample, a fixture, a sibling service — kills `-m pytest` for the
    // whole repository, python or not. Same direction (CLOSED), same follow-up
    // card; stated here so the scope is not read as narrower than it is.
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

/**
 * `node --run <script>` IS A WRAPPER WEARING NODE'S NAME, and it wore the test
 * shape too. Node executes the named `package.json` script — a command line the
 * BRANCH wrote — and hands the remaining argv to it, so `node --run test-all
 * --test tests/other.test.mjs` satisfied `includes('--test')` while node itself
 * never entered test-runner mode at all. With `"test-all": "bun test
 * --preload=./src/limit.ts tests/other.test.ts"` in the branch's own
 * `package.json` that guard loads the mutated PRODUCTION file into a process
 * running an unrelated test: byte for byte the forgery `npm run` is already
 * refused for (see `forwardsPositionalsToAScript`), reopened under node's own
 * binary. Refused at the SHAPE, which is where "a recognised program in a shape
 * that is not its test subcommand" belongs — `--run` and `--test` are two modes
 * of one binary and only the second is a test runner. BOTH SPELLINGS COUNT:
 * node parses `--run=name` as it parses every other string option, and refusing
 * only the space-separated one would leave the same wrapper one character away.
 * Costs nothing honest — the script's body is a runner invocation the
 * nomination can simply write out.
 *
 * AND `node <script> --test <unrelated>` IS THE SAME WRAPPER WITHOUT THE
 * OPTION, which is why the node shape now requires `--test` to be `argv[1]`.
 * Node only enters test-runner mode when `--test` is one of ITS OWN options,
 * i.e. before the entry script; written after one it is an ordinary argument
 * node hands straight to the script (verified on v22: the script prints
 * `argv=["--test"]`). So `node tests/wrap.mjs --test tests/other.test.mjs` ran
 * a BRANCH-AUTHORED entry script — one line of `import '../src/limit.mjs'`
 * away from reddening under any syntax break — while `includes('--test')`
 * called it a test invocation. The leading spelling is the only one that means
 * anything, and `runnerPrefixLength` already assumed exactly that
 * (`argv[1] === '--test' ? 2 : 1`); the shape check now agrees with it instead
 * of admitting shapes that prefix could not read. Fails CLOSED and costs
 * nothing honest: `node --test --experimental-strip-types tests/x.ts` says the
 * same thing with the options after the mode, which is where node documents
 * them.
 */
function isNodeRunOption(arg: string): boolean {
  return arg === '--run' || arg.startsWith('--run=')
}

/**
 * A basename that DECLARES a test. The rule this replaces was path-prefix-based
 * and over-broad: it refused any path containing a `tests/`, `test/` or
 * `__tests__/` segment, and so refused a harness LIBRARY that declares no test
 * cases at all. Mutating such a library and watching a SEPARATE `*.test.ts` go
 * red is a genuine red-then-green proof, not the tautology the rule was written
 * to ban — and the tautology itself is now stated directly, as the guard-argv
 * check in `validateClaim`, which the path rule was only ever standing in for.
 *
 * WHAT THIS COVERS: `*.test.*` / `*.spec.*` for the JS/TS runners, and
 * `*_test.go` / `*_test.py` for go and pytest — names those two runners really
 * do collect.
 *
 * `_test.rs` IS NOT ONE OF THEM, and dropping it is the one place this narrows
 * the card's literal list. Cargo has no `_test.rs` convention at all: its test
 * targets are `tests/*.rs` under ANY name, plus `#[cfg(test)]` modules inside
 * `src/`. So the arm declared `src/pricing_test.rs` — an ordinary Rust module
 * carrying production logic — a TEST, and through `classifyMutationTarget` sold
 * its diff the no-production-file exemption for a suffix the build chose. It
 * covered no cargo test target that `tests/foo.rs` did not already miss, so
 * removing it makes every `.rs` path classify the same way and strictly
 * NARROWS the exemption. No tautology opens: a real cargo test target lives
 * under `tests/`, so `aRunnerMayCollect` still calls it collectible for its
 * parent and a `cargo test` guard is still refused — the dead end already
 * written down in `whyNoSelection`.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: every LOOSER name a runner still picks
 * up — `ab-test.ts`, `thing_test.ts`, `helper_spec.ts`, `test_probe.py`,
 * `test*.py` for `unittest discover`, `test.js`/`test-*.js` for node. Those
 * live in `RUNNER_COLLECTED_BASENAME` instead, because this regex has a SECOND
 * consumer: `classifyMutationTarget`, and through it the no-production-file
 * EXEMPTION — where the file NAMES are written by the build. Every name added
 * here is a name a build could give a production file to buy itself an
 * exemption (`src/ab-test.ts` was exactly that: production logic, a test's
 * name, an exemption for free); every name added there only ever REFUSES a
 * guard. The tautology the looser names would otherwise open — classify
 * `production`, then let a directory or bare-runner guard run the mutated file
 * as its own test — is closed on the guard side, in `guardRunsTheMutatedFile`,
 * which is where the tautology actually happens.
 *
 * THE EXTENSION IS SPELLED OUT RATHER THAN COMPOSED. `[cm]?[jt]sx?` reads as
 * eight extensions and matches TWELVE: it also admits the hybrids `.cjsx`,
 * `.mjsx`, `.ctsx` and `.mtsx`, which no runner collects (verified on bun
 * 1.3.x: a lone `payments.test.cjsx` gives "Ran 1 test across 1 file" — the
 * OTHER file). A name a runner does not collect must not DECLARE a test here,
 * because a build could then park behaviour in `src/payments.test.cjsx` and buy
 * the no-production-file exemption with a file nothing would ever run. So the
 * two real families are listed: a `[cm]` prefix takes no `x` (`.cjs`, `.cts`,
 * `.mjs`, `.mts`) and the bare form takes an optional one (`.js`, `.jsx`,
 * `.ts`, `.tsx`).
 *
 * `_test.rs` IS DELIBERATELY ABSENT, and the guard side is where that lands:
 * cargo collects `#[test]` functions from any module, so `src/pricing_test.rs`
 * is production here and a legal TARGET — while its only plausible guard is
 * `cargo test`, which COMPILES the crate before it runs anything. See the
 * compile-tautology note in `guardRunsTheMutatedFile`: that guard is latent,
 * deferred, and unreachable in this bun-only repository.
 */
const TEST_BASENAME = /\.(test|spec)\.(?:[cm][jt]s|[jt]sx?)$|_test\.(go|py)$/

/** What DECLARES a file a test: its basename, or being a DIRECT child of a
 *  `__tests__/` directory. A support library under `tests/` (or nested below
 *  `__tests__/<subdir>/`) matches neither declaration and is a LEGAL mutation
 *  target — its behaviour is asserted by a separate declared test. */
export function isDeclaredTestFile(path: string): boolean {
  const segments = path.split('/')
  const base = segments[segments.length - 1] ?? ''
  if (TEST_BASENAME.test(base)) return true
  return segments.length >= 2 && segments[segments.length - 2] === '__tests__'
}

export type MutationTargetKind = 'test' | 'prose' | 'production'
/** test → rejected as a target; prose → rejected as a target; production → legal. */
export function classifyMutationTarget(path: string): MutationTargetKind {
  if (isDeclaredTestFile(path)) return 'test'
  if (isProseOnlyChange([path])) return 'prose'
  return 'production'
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
  /**
   * The paths THIS BRANCH changes, as `runMutationProofGate` already read them
   * from git for the diff-binding. Runner provenance needs them: a config file
   * the branch itself wrote decides which code a `bun test` guard loads with
   * nothing on the argv to show for it (`bunConfigCandidates`), while the same
   * file inherited from the base branch is merged, reviewed code and refusing
   * it would leave a bun-only repository with no nominatable guard at all.
   * Omitted (direct callers/tests) → no branch-authored config is known, and
   * the config arm has nothing to refuse; the gate, which is the only path a
   * merge can take, always supplies it (pinned by its own test).
   */
  changed_files?: readonly string[]
  /**
   * The BASE the branch is measured against — the same `base_branch` the gate
   * read the diff with. Runner provenance needs more than the file list: a
   * config file appearing in the diff says the branch TOUCHED it, never that the
   * branch wrote the load hook inside it, and refusing on the file alone cost a
   * routine dependency bump its only nomination. With a base, the hook key's
   * value at the merge base is compared with its value at the head
   * (`bunConfigHookSlice`) and only a branch-authored map is refused. Omitted
   * (direct callers/tests) → no base is known and the arm falls back to the
   * older, WIDER reading, which fails closed; the gate always supplies it.
   */
  base_ref?: string
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
  if (isDeclaredTestFile(claim.file)) {
    return `claim.file ${claim.file} is a test file — the mutation must break PRODUCTION behaviour`
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
  // Running the mutated file as the guard's own test argument is the tautology
  // the old path rule was defending against — stated directly, and it holds for
  // production targets too.
  const tautology = guardRunsTheMutatedFile(claim.guard, claim.file)
  if (tautology !== null) {
    return `claim.guard ${tautology} the mutated file ${claim.file} as its own test — a tautology, not a proof: the guard must be a separate test OF the behaviour`
  }
  return null
}

/**
 * THE TRAILING NON-PATH A SPECIFIER MAY CARRY: node's query/fragment suffix
 * (`./src/limit.mjs?proof`, `./src/limit.mjs#v2`) and pytest's node ID
 * (`src/limit.py::test_probe`). Both name THE SAME FILE the bare spelling names
 * — node executes the query-suffixed `--import` (verified on node v22), pytest
 * imports the file its node ID selects — while equalling no repo-relative
 * target, so the tautology check never fired and the mutated file supplied its
 * own RED and GREEN.
 *
 * THE `?` WAS WORSE THAN INVISIBLE: it also made `namesASearch` read the
 * specifier as a GLOB, so even the on-disk seam skipped the element rather than
 * resolving it. Cut the suffix off HERE, in the one canonicaliser every
 * comparison goes through, so no seam has to remember to.
 *
 * It only ever REFUSES: a shortened spelling can match the mutated file, never
 * un-match it, and a selector is resolved on disk afterwards — `x.py::case`
 * resolves as `x.py`, which is the file the runner really opens.
 */
const SPECIFIER_SUFFIX = /[?#]|::/

/** `./a/b.ts`, `a/b/` and `a/b` are ONE path. Compared as raw strings the
 *  tautology check below is defeated by two characters of punctuation.
 *
 *  `..` does NOT collapse here and does not need to: `argvEscapesTheWorktree`
 *  REFUSES any argv element carrying a `..` segment (or a leading `/`) before
 *  the comparison is ever reached. Collapsing was the weaker answer — a `..`
 *  that climbs OUT of the worktree has nothing to pop, so it survived
 *  normalisation and could never equal a repo-relative target, which is
 *  precisely how `../<worktree-dir>/tests/support/lib.ts` re-entered the
 *  worktree and ran the mutated file as its own guard. */
/**
 * THE SPELLING A LOADER DECODES AND A COMPARISON DOES NOT: percent-encoding.
 * `--import=./tests/support/clamp%2Emjs` is the SAME FILE as
 * `./tests/support/clamp.mjs` — node resolves module specifiers as URLs and
 * loads the `%2E` spelling (reproduced end-to-end on node v22) — while equalling
 * no repo-relative target, so every arm of `guardRunsTheMutatedFile` missed it
 * and `guardPathCandidates` ENOENTed on the encoded name and dropped it. The
 * mutated file supplied its own RED and GREEN and the gate recorded
 * `proved: true`.
 *
 * Decoded HERE, in the one canonicaliser, and again for the escape check — so
 * `%2F` and `%2E%2E` cannot smuggle a separator or a climb past it either. It
 * only ever REFUSES: a decoded spelling can match the mutated file or look like
 * an escape, never un-match one. A malformed `%` (`--grep=100%`) throws in
 * `decodeURIComponent` and keeps its literal spelling rather than failing the
 * nomination.
 */
function percentDecoded(arg: string): string {
  if (!arg.includes('%')) return arg
  try {
    return decodeURIComponent(arg)
  } catch {
    return arg
  }
}

function normalizeArg(arg: string): string {
  const trimmed = percentDecoded(arg.trim())
  const cut = trimmed.search(SPECIFIER_SUFFIX)
  const joined = (cut === -1 ? trimmed : trimmed.slice(0, cut))
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.')
    .join('/')
  return joined.length === 0 ? '.' : joined
}

/**
 * A name a runner on `TEST_COMMAND_SHAPES` COLLECTS, beyond what DECLARES a
 * test. Deliberately BROADER than `TEST_BASENAME`, and used ONLY here: bun and
 * jest collect `*_test.ts` and `*_spec.ts`, node --test also collects
 * `*-test.js`, `*-spec.js`, `test.js` and `test-*.js`, and `python3 -m
 * unittest` discovers `test*.py` (not just `test_*.py`).
 *
 * WHY IT IS NOT FOLDED INTO `TEST_BASENAME`: that regex also drives
 * `classifyMutationTarget`, and through it the no-production-file EXEMPTION —
 * where file NAMES are build-controlled, so every name added there is a name a
 * build could use to buy itself an exemption. The extra breadth belongs on this
 * side, where its only effect is to REFUSE a guard.
 */
const RUNNER_COLLECTED_BASENAME = /^test[^/]*\.(py|[cm]?[jt]sx?)$|[._-](test|spec)\.[cm]?[jt]sx?$/

/** True of a path a runner may pick up WHOLESALE — because its NAME is one a
 *  runner collects, or because it lives under a directory a runner collects
 *  (which is the class this branch newly made mutatable: a support library
 *  under `tests/`). Elsewhere a directory argument does not run the mutated
 *  file, and a production module keeps its right to a directory-wide guard. */
function aRunnerMayCollect(path: string): boolean {
  const segments = path.split('/')
  if (RUNNER_COLLECTED_BASENAME.test(segments[segments.length - 1] ?? '')) return true
  return segments.slice(0, -1).some((seg) => seg === 'tests' || seg === 'test' || seg === '__tests__')
}

/**
 * The path an OPTION ELEMENT CARRIES, normalized — `--preload=./tests/support/lib.ts`
 * carries `tests/support/lib.ts` — or '' for an element that carries nothing.
 *
 * WITHOUT THIS THE TAUTOLOGY CHECK IS BYPASSABLE BY AN `=`. The comparison
 * below is over WHOLE argv elements, and `--preload=./tests/support/lib.ts` is
 * one element that equals no path at all — while `bun test
 * --preload=./tests/support/lib.ts other.test.ts` loads the mutated file into
 * the very process that runs the guard. It is repo-relative, so
 * `argvEscapesTheWorktree` does not refuse it either. Splitting the value off
 * before normalising is what makes the option form compare equal to the bare
 * one.
 *
 * AN `=` IS NOT THE ONLY SEPARATOR, AND THE ABSENCE OF ONE IS THE FOURTH
 * SPELLING: a SHORT option carries its value ATTACHED, with no separator at all
 * — `-r./tests/support/lib.ts` is `--preload=./tests/support/lib.ts` in two
 * characters less, and bun honours it (verified on bun 1.3.x: the preloaded
 * side effect runs). Read as a whole element it equals no path; read by the `=`
 * rule it carries nothing. So the attached form is split at the option LETTER.
 * `--long` is excluded by the second character, and `-r=x` still splits on `=`.
 */
const SHORT_OPTION_WITH_ATTACHED_VALUE = /^-[A-Za-z][^-=]/

/**
 * AND THE SPACE IS THE FIFTH SPELLING — the one a reviewer forged a `proved:
 * true` out of. `--preload ./src` and `--preload=./src` are the SAME
 * instruction to bun and node, but `carriedValue` reads only the `=`-joined and
 * attached-short forms, so the space-separated value was invisible to
 * `carriedValueReaching` while the runtime loaded the mutated module into the
 * guard's own process. An element is an option WHOSE VALUE IS THE NEXT ELEMENT
 * when it starts with `-`, carries nothing itself, and is not the `--`
 * separator (whose "value" is every remaining positional, a class
 * `whyNoSelection` already refuses).
 *
 * WHICH OPTIONS TAKE A VALUE IS NOT KNOWABLE from argv — `--coverage` takes
 * none — so `carriedValueReaching` reads EVERY operand after a bare option as
 * one, and over-refuses `bun test --coverage src/` for a target under `src/`.
 * It fails CLOSED and it is spellable around: write the path BEFORE the option
 * (`bun test src/ --coverage`), where no option precedes it.
 */
function isBareOption(arg: string): boolean {
  return arg.startsWith('-') && arg !== '--' && !arg.includes('=') && !SHORT_OPTION_WITH_ATTACHED_VALUE.test(arg)
}

function carriedValue(arg: string): string {
  if (!arg.startsWith('-')) return ''
  const eq = arg.indexOf('=')
  const value = eq !== -1 ? arg.slice(eq + 1) : SHORT_OPTION_WITH_ATTACHED_VALUE.test(arg) ? arg.slice(2) : ''
  return value.length === 0 ? '' : normalizeArg(value)
}

/**
 * How the guard runs the mutated file as its own test, or null if it does not.
 *
 * FIVE SHAPES, because an exact argv-element match is only a fifth of it.
 * `bun test tests/support/lib.ts` names the file (as does the option form that
 * CARRIES it, `--preload=./tests/support/lib.ts`); `python3 -m unittest
 * src.limit` names the same file as a MODULE, which imports it; `bun test
 * tests` names a DIRECTORY that collects it; `bun test lib.ts` names a FILTER
 * the mutated path contains, which the runner matches as a substring; and
 * `python3 -m unittest` names NOTHING and so discovers from the repo root,
 * which reaches every collectible file there is. The last three only matter for
 * a file a runner may collect wholesale (`aRunnerMayCollect`), so `bun test
 * trident/` stays a legal guard for a production module — but the first two
 * hold for ANY target, because naming the mutated file is the tautology whether
 * or not a runner would have collected it on its own.
 *
 * The no-path arm over-refuses a whole-suite guard for a support library. That
 * is deliberate: it fails CLOSED, and a nomination can always name the separate
 * test it means instead.
 *
 * THE TWO ARMS ASK DIFFERENT QUESTIONS, so they read different sets. The
 * no-path arm asks "does this argv SELECT anything, or does it discover?" — and
 * an option's carried value never selects a test: `bun test
 * --reporter-outfile=report.xml` is a whole-suite discovery run, and counting
 * `report.xml` as "a path was named" was exactly what kept the arm from firing.
 * The directory arm asks "is the mutated file underneath something this argv
 * REACHES?" — and a carried value does reach (`--preload=tests/support/`), as
 * does an operand `pathArgs` deliberately could not recognise. So the no-path
 * arm reads `pathArgs`, and the directory and filter arms read
 * `argumentOperands` plus carried values.
 *
 * KNOWN RESIDUAL, argv-invisible: a runner's CONFIG can load the mutated file
 * with nothing in the argv saying so. A `bunfig.toml` committed at the repo
 * ROOT is read by every `bun test` in the tree, and its `[test] preload` key
 * loads whatever it names; jest's `setupFiles` and pytest's `conftest.py` are
 * the same file under other names; and a committed `tests/tsconfig.json` needs
 * no flag AT ALL — bun walks up from the test file and applies its
 * `compilerOptions.paths`, so the ALIASING that `--tsconfig-override` and
 * `--conditions` are refused for below is equally available to a branch that
 * simply commits the map where the guard already is, and a committed
 * `package.json` `imports` entry is that same map under node's own name. This
 * function reads argv, so a branch that commits such a config makes any guard
 * load the mutated file, and the guard's argv is byte-for-byte an honest one.
 * It is not closed here and could not be: the config is part of the branch
 * under proof. The class pre-dates this rule
 * for production files, and the same answer holds for both — a proof is
 * evidence for a reviewer, not a substitute for one.
 *
 * ITS ARGV-VISIBLE HALF IS NOT A RESIDUAL AND IS REFUSED — in every spelling
 * that PUTS the config on the command line. A hook written INTO the guard
 * (`--preload=./tests/setup.ts` whose body imports the target) is the same load
 * with the branch's fingerprints on the argv, and it forged a proof end to end;
 * so is `--config=./tests/bunfig.toml`, which names the config instead of the
 * hook and reached `proved: true` through the real gate on bun 1.3.13; so is
 * `--env-file=./tests/.env`, whose `NODE_OPTIONS` sets the hook a third way.
 * EVERY SPELLING MEANS EVERY SPELLING, and three of them were still open a
 * round ago: node's `--experimental-config-file=<file>`, node's valueless
 * `--experimental-default-config-file` (which reads `node.config.json` from the
 * cwd and so carries no value for a value-shaped rule to catch), and the short
 * `-c` that bun and jest accept for `--config`. See `loadHookCarrying`, which
 * refuses each shape whatever file it names — and, for a long name, whether or
 * not it names one at all.
 *
 * A WRAPPER'S BODY WAS THE SAME RESIDUAL AND IS NO LONGER ONE. A `package.json`
 * script or a `Makefile` recipe is a command line the BRANCH wrote, and the
 * argv `npm run test:unit` says nothing about it; with `"test:unit": "bun test
 * --preload=./src/limit.ts tests/unrelated.test.ts"` that guard loads the
 * mutated PRODUCTION file into a process running an unrelated test — reproduced
 * end to end on npm 10.9.8. It is NOT closable by reading argv and would not be
 * closable by parsing `package.json` and every `Makefile` dialect either, so it
 * is closed by REFUSING the shape: a wrapper is no longer a legal guard for any
 * target. A collectible one already refused every wrapper via
 * `forwardsPositionalsToAScript` (no wrapper positional counts as a selection);
 * the production half is refused at the `aRunnerMayCollect` gate below. Unlike
 * a config, this one costs nothing honest — the wrapper's body is a runner
 * invocation the nomination can simply write out.
 *
 * A WRAPPER ANSWERS TO MORE THAN FOUR NAMES, and two spellings outlived the
 * paragraph above. `node --run test-all --test tests/other.test.mjs` runs a
 * `package.json` script and never enters node's test mode at all, so it is
 * refused one step earlier, at the SHAPE (`isNodeRunOption`) — the four-program
 * predicate here reads `argv[0]` and node is a test runner under its other
 * spelling. And go carries a branch-authored body on one dash: `-exec`,
 * `-toolexec`, `-overlay` (`GO_TOOLCHAIN_HOOK_OPTION`), refused with the load
 * hooks because that is what they are.
 */
function guardRunsTheMutatedFile(guard: readonly string[], file: string): string | null {
  const target = normalizeArg(file)
  if (guard.some((a) => normalizeArg(a) === target || carriedValue(a) === target)) return 'names'
  // A DOTTED MODULE IS THE FIFTH SPELLING, and it reaches a PRODUCTION target,
  // so it is asked BEFORE the collectible gate below — see `modulePathsOf`.
  const asModule = guard.slice(runnerPrefixLength(guard)).find((a) => dottedModuleReaches(a, target))
  if (asModule !== undefined) return `names the module ${asModule}, which IMPORTS`
  // AN OPTION'S VALUE IS LOADED, NOT DISCOVERED, so it is asked BEFORE the
  // collectible gate below — see `carriedValueReaching`.
  const carriedReach = carriedValueReaching(guard, target)
  if (carriedReach !== null) return carriedReach
  // AND A HOOK THAT NAMES A THIRD FILE IS OPAQUE, whatever that file imports —
  // see `loadHookCarrying`. Asked AFTER the arms above so a hook naming the
  // mutated file itself keeps its more specific refusal, and BEFORE the
  // collectible gate because a preload is a load and not a discovery.
  const hook = loadHookCarrying(guard)
  if (hook !== null) {
    return `loads ${hook}, whose body the branch wrote and this argv does not show, and so may import`
  }
  if (!aRunnerMayCollect(target)) {
    // A WRAPPER IS OPAQUE, AND OPACITY IS NOT INNOCENCE. Everything above reads
    // argv; a wrapper's argv says `npm run test:unit` and its real command line
    // lives in a `package.json` script or a `Makefile` recipe THE BRANCH WROTE.
    // With `"test:unit": "bun test --preload=./src/limit.ts tests/other.test.ts"`
    // that guard loads the mutated PRODUCTION file into a process running an
    // unrelated test, so a syntax-shaped mutation reddens it with nothing
    // asserting the mutated behaviour — reproduced end to end on npm 10.9.8.
    // A COLLECTIBLE target already refuses every wrapper (no wrapper positional
    // counts as a selection, so the no-selection arm below fires); the
    // production side was the half still open, and it is closed the same way.
    // Over-refusal, failing CLOSED, and spellable around: name the runner that
    // actually runs the test, which is what the script would have run anyway.
    if (forwardsPositionalsToAScript(guard)) {
      return `runs ${guard[0]}, whose script body the branch wrote and this argv does not show, and so may load`
    }
    // A COMPILED LANGUAGE'S RUNNER IS A COMPILE FIRST, and this arm knowingly
    // lets it through. `go test` / `cargo test` build the whole package or
    // crate before a test runs, so a syntax-shaped mutation of ANY `.go`/`.rs`
    // file in it reddens the guard through COMPILATION with nothing asserting
    // the target's behaviour. It is not closed here because closing it lexically
    // means refusing `go`/`cargo` as a guard for every target in such a repo —
    // which IS the "no legal nomination" defect this whole card exists to fix,
    // paid a second time. It is unreachable in this bun-only tree (no toolchain,
    // so the restored guard reds too and `evaluate` refuses), recorded as a
    // deferral in IMPLEMENTATION_PLAN.md, and it belongs to a card that can
    // reason about a compile-unit target and its guard together.
    return null
  }
  const selectors = pathArgs(guard)
  if (selectors.length === 0) {
    // The "so it reaches" half belongs to each ARM, not to this call site: it
    // used to be glued on here as "so the runner discovers from the repo root",
    // which is a sentence only the discovery arms can honestly say. A LONE
    // search (`bun test app/*.test.ts`) lands here too, and told the next build
    // its argv discovered from the repo root when it discovers from `app`.
    return `collects (${whyNoSelection(guard)})`
  }
  // A SEARCH THAT SHARES ITS ARGV WITH A SELECTOR WAS INVISIBLE TO EVERY ARM.
  // `go test ./cmd/ ./...` is a whole-module run, and `./...` reaches
  // `tests/support/helper.go` — the mutated file — as surely as `go test ./...`
  // alone does. But a search is DROPPED everywhere a spelling is compared
  // (`pathArgs`, `argumentOperands`, `guardPathCandidates`) on the reasoning
  // that the no-selection arm above catches it; that reasoning only holds while
  // the search is the ONLY selector. Add `./cmd/` beside it and `pathArgs` is
  // non-empty, so the arm never fires, while the directory and filter arms
  // compare `cmd` against a target under `tests/` and see nothing. Red-then-green
  // forged out of the mutated file's own compilation.
  //
  // So a search is READ HERE, as what it is: a root plus "everything
  // collectible under it". `./...` and `*.test.ts` are rooted at `.`;
  // `tests/...` and `tests/**/*_test.go` at `tests`. A search rooted somewhere
  // ELSE selects nothing of the mutated file and is left alone by THIS arm —
  // `bun test app/other.test.ts app/*.test.ts` stays a legal guard for a
  // library under `tests/`.
  //
  // WHAT THIS ARM DOES NOT REACH, said plainly because the earlier wording
  // claimed otherwise: a search STANDING ALONE never gets here. `pathArgs`
  // drops searches, so `bun test app/*.test.ts` has no selectors and the
  // no-selection arm above has already refused it. That is an OVER-refusal and
  // it fails closed; the answer is to name the test file beside the glob, which
  // is the mixed form this arm reads.
  const search = searchesReaching(guard, target)
  if (search !== null) return search
  // WHAT THE RUN REACHES IS EVERY OPERAND, NOT ONLY EVERY SELECTOR, and reading
  // `pathArgs` here was a hole big enough to drive the whole tautology through.
  // `pathArgs` answers a DIFFERENT question — "does this argv target anything?"
  // — and to answer it safely it DROPS what it cannot recognise: a bare word
  // (`helper_test`) and an operand sitting after a value-less option
  // (`--coverage helper_test.ts`). Both were then invisible to the two arms
  // below, while bun reads each of them as a live filter: `bun test
  // other.test.ts helper_test` runs `tests/support/helper_test.ts` — the
  // mutated file — as its own guard, and the gate called it proved. So the arms
  // that ask "does the run REACH the mutated file?" read every operand the
  // runner itself reads (`argumentOperands`), plus every option's carried value.
  const operands = argumentOperands(guard)
  const carried = guard.map(carriedValue).filter((v) => v.length > 0)
  const reached = [...operands.map((o) => o.path), ...carried]
  const dir = reached.find((a) => a === '.' || target.startsWith(`${a}/`))
  if (dir !== undefined) return `collects (via the directory ${dir})`
  // AND THE OPERAND THAT IS A SUBSTRING OF THE TARGET. A positional is not a
  // path to every runner: `bun test thing_test.ts` runs every discovered test
  // whose PATH CONTAINS `thing_test.ts` — including `src/thing_test.ts`, the
  // mutated file — whether or not a file of that exact spelling exists. That is
  // the runner's real matching semantics, so it is decided HERE, lexically,
  // rather than left to the resolution seam: a bare `thing_test.ts` at the repo
  // root resolves perfectly well AND still filters the mutated file into the
  // same run, which is how this shape survived `guardSelectsNothingOnDisk`.
  //
  // A FILTER HAS TO BE ABLE TO NAME SOMETHING, which is why the letter is
  // required — OF A CARRIED VALUE ONLY. The letter was there because
  // `--timeout=1` carries `1`, an option's numeric argument and not a name,
  // while `1` is a substring of `tests/support/v1.ts`, so an honest nomination
  // of that library was refused for a tautology nobody wrote. But it was
  // applied to every element alike, and a bare POSITIONAL is not an option's
  // value: `bun test tests/other.test.ts 123` reads `123` as a live filter and
  // runs `src/123_test.ts` — a name `TEST_BASENAME` deliberately calls
  // production, so it is a legal nomination — as its own guard, with nothing
  // here to see it. Bun's positional filter semantics are a union, verified
  // against the real runner.
  //
  // So the letter is asked of everything EXCEPT an operand STANDING WHERE A
  // SELECTOR GOES. `--timeout=1` and `--timeout 1` hand their `1` to the
  // option; a positional hands it to the suite, and digits filter as well as
  // letters do.
  const filter =
    operands.find((o) => o.standalone && o.path !== '.' && target.includes(o.path))?.path ??
    reached.find((a) => a !== '.' && /[A-Za-z]/.test(a) && target.includes(a))
  return filter === undefined
    ? null
    : `collects (the runner reads ${filter} as a filter, and the mutated path contains it, so the run reaches)`
}

/**
 * The SEARCH in this argv that reaches the mutated file, said in the caller's
 * words, or null if none does.
 *
 * A search is the one element shape whose reach is not its spelling: `./...`
 * names no path and reaches every package under the cwd, `tests/**` reaches
 * every file under `tests/`. So it is compared by ROOT — everything before the
 * first segment carrying a glob character or go's `...` — and the target being
 * under that root is the tautology, whatever else the argv also selects.
 *
 * Read at OPERAND positions and out of OPTION VALUES alike, and deliberately
 * without `pathArgs`' "is it the operand of a value-less option?" rule: that
 * rule exists to keep an option's argument from counting as a SELECTION, while
 * this asks what the run REACHES, where an unrecognised element has to count as
 * reaching. `--reporter-outfile ./...` is not a shape anyone writes; refusing it
 * costs a nomination one respelling and fails closed.
 */
function searchesReaching(argv: readonly string[], target: string): string | null {
  for (let i = runnerPrefixLength(argv); i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg.length === 0) continue
    const value = arg.startsWith('-') ? carriedValue(arg) : normalizeArg(arg)
    if (value.length === 0 || !namesASearch(value)) continue
    const segments = value.split('/')
    const cut = segments.findIndex((seg) => seg === '...' || /[*?]/.test(seg))
    const root = segments.slice(0, cut).join('/')
    if (root.length === 0 || target === root || target.startsWith(`${root}/`)) {
      const where = root.length === 0 ? 'the repo root' : root
      return `collects (${arg} names a search rooted at ${where}, which reaches every collectible file under it, including)`
    }
  }
  return null
}

/**
 * Every argv element the RUNNER ITSELF reads as an argument: the runner's own
 * invocation dropped, options dropped, searches dropped, and NOTHING else —
 * deliberately looser than `pathArgs`, and for the opposite reason.
 *
 * The two functions answer opposite questions and so must fail closed in
 * opposite directions. `pathArgs` asks "does this argv SELECT anything, or does
 * it discover?", and an element it cannot recognise has to count as NOT a
 * selection or a discovery run wearing a targeted argv slips through. This asks
 * "what does the run REACH?", and there an unrecognised element has to count as
 * reaching, because the runner will do something with it — bun reads a leftover
 * positional as a substring filter over the whole discovered suite.
 *
 * A SEARCH IS STILL DROPPED, and only because it is handled harder elsewhere:
 * keeping it here would only ever compare a literal `*` against a path, so it
 * is read by ROOT instead, in `searchesReaching`. "Elsewhere" used to mean the
 * no-path arm alone, and that was the mixed-selector hole — `go test ./cmd/
 * ./...` has a selector, so that arm never fired, and the search was dropped
 * from every comparison that remained.
 *
 * EACH OPERAND CARRIES WHETHER IT STANDS ALONE — whether it sits where a
 * SELECTOR goes, or immediately after a value-less option where it may be that
 * option's argument. Both still REACH (bun reads `--coverage helper_test.ts` as
 * a live filter, which is why they are all returned), but only a standalone one
 * may be read as a filter when it is spelled in DIGITS: `--timeout 1` really
 * does hand `1` to the option, while `bun test x.test.ts 123` hands `123` to
 * the suite.
 */
function argumentOperands(argv: readonly string[]): { path: string; standalone: boolean }[] {
  const out: { path: string; standalone: boolean }[] = []
  const start = runnerPrefixLength(argv)
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg.length === 0 || arg.startsWith('-')) continue
    const path = normalizeArg(arg)
    if (namesASearch(path)) continue
    const prev = i > start ? (argv[i - 1] as string) : ''
    out.push({ path, standalone: !(prev.startsWith('-') && carriedValue(prev).length === 0) })
  }
  return out
}

/** A dotted module selector: `src.limit`, or the bare `limit`. Every segment is
 *  a python identifier, and there is no separator — the spelling that made the
 *  bypass below invisible to a path comparison. */
const DOTTED_MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

/**
 * The files a DOTTED MODULE SELECTOR names — `src.limit` is `src/limit.py` (or
 * `src/limit/__init__.py`), and `src.limit.CaseName` is still that file with a
 * test case appended.
 *
 * THE BYPASS THIS CLOSES, reproduced end-to-end. `python3 -m unittest src.limit`
 * IMPORTS the mutated module, so a syntax-breaking mutation of `src/limit.py`
 * makes that command red and its restore green — the mutated file serving as
 * its own guard, with an assertion-free "separate" test and an unrelated
 * control, and the gate recorded `proved: true`. Nothing above could see it: a
 * dot is not a slash, so no comparison of SPELLINGS matched; `src/limit.py` is
 * production so the collectible arms never ran; and `src.limit` names nothing
 * on disk, so the resolved seam dropped it too.
 *
 * EVERY PREFIX, because unittest's selector keeps going after the module:
 * `src.limit.LimitTest.test_under` imports `src/limit.py` all the same. So each
 * dotted prefix is expanded and compared, and a match anywhere is the tautology.
 *
 * Applied to every runner rather than only to python: the expansion always ends
 * in `.py`, so the only thing it can ever match is a python target, and a `.py`
 * file named by its module path in a non-python argv is not a shape worth
 * admitting either. It only ever REFUSES — a dotted module is never read as a
 * SELECTION (`pathArgs` drops it), so no guard becomes legal because of this.
 */
/**
 * HOW DEEP THE EXPANSION GOES, and why it has to stop somewhere.
 *
 * Every prefix is a fresh string, so expanding all of them costs the SUM of
 * their lengths — quadratic in the element. The element is an agent-authored
 * argv item of no bounded length: measured on this box, a 40 000-segment
 * dotted element took 8.5s inside a single flight tick, past this file's own
 * 3s wall-clock pin. That is an availability cost, never a bypass, but it is
 * paid on input the gate does not control.
 *
 * THE CAP ONCE CLAIMED TO FAIL CLOSED AND DID NOT. It read: "a prefix deeper
 * than the target's own directory nesting can never equal it, so with 24 levels
 * every repo path this gate could be asked about is still expanded". That is
 * only true while the TARGET is shallower than 24 — and `claim.file` is written
 * by the same build that writes the diff, so a tree nested 25 directories deep
 * is a thing a branch can simply commit. At that depth the selector's matching
 * prefix was past the cap, the truncated expansion matched nothing, and the
 * dotted arm fell open on the one input that was trying to bypass it.
 *
 * So the SPELLING comparison no longer expands at all: `dottedModuleReaches`
 * asks the question backwards, deriving the target's own dotted stem once and
 * testing `raw === stem || raw.startsWith(stem + '.')` in linear time, with no
 * cap and no depth at which it stops answering. What is left here is the
 * SYMLINK seam (`guardPathCandidates`), which needs real paths to `realpath`
 * and so must enumerate; the cap bounds THAT work, and its residual is a dotted
 * selector that reaches the target only through a symlink at a nesting past 24.
 * Dropping the element wholesale on length would instead let
 * `src.limit.<40 000 junk segments>` stop naming `src/limit.py` at all.
 */
const MAX_MODULE_DEPTH = 24

function modulePathsOf(arg: string): string[] {
  const raw = dottedSelectorOf(arg)
  if (raw === null) return []
  const segments = raw.split('.')
  const out: string[] = []
  for (let i = 1; i <= Math.min(segments.length, MAX_MODULE_DEPTH); i += 1) {
    const stem = segments.slice(0, i).join('/')
    out.push(`${stem}.py`, `${stem}/__init__.py`)
  }
  return out
}

/** The dotted selector an argv element carries, or null if it is not one. */
function dottedSelectorOf(arg: string): string | null {
  const raw = arg.startsWith('-') ? carriedValue(arg) : arg
  return raw.length > 0 && DOTTED_MODULE.test(raw) ? raw : null
}

/**
 * Does this argv element name, as a DOTTED MODULE, the mutated file or
 * something inside it — asked WITHOUT expanding the element.
 *
 * The expansion in `modulePathsOf` is quadratic in the element and capped, and
 * the cap was a bypass (see `MAX_MODULE_DEPTH`). The same question has a linear
 * form: the target has exactly ONE dotted spelling, so derive that and ask
 * whether the selector IS it or CONTINUES it. `src/limit.py` is `src.limit`, so
 * `src.limit` matches and so does `src.limit.LimitTest.test_under` — unittest
 * imports the module either way — while `src.limits` does not, because the dot
 * is required. `src/limit/__init__.py` is the package `src.limit` and gets the
 * same treatment. No cap, no depth at which it stops answering, and it still
 * only ever REFUSES.
 */
function dottedModuleReaches(arg: string, target: string): boolean {
  const raw = dottedSelectorOf(arg)
  if (raw === null) return false
  const stem = dottedStemOf(target)
  return stem !== null && (raw === stem || raw.startsWith(`${stem}.`))
}

/** The dotted module spelling of a python target, or null if it has none. */
function dottedStemOf(target: string): string | null {
  const stripped = target.endsWith('/__init__.py')
    ? target.slice(0, -'/__init__.py'.length)
    : target.endsWith('.py')
      ? target.slice(0, -'.py'.length)
      : null
  if (stripped === null || stripped.length === 0) return null
  const dotted = stripped.split('/').join('.')
  return DOTTED_MODULE.test(dotted) ? dotted : null
}

/**
 * DOES THE TREE ITSELF SUPPLY THE `-m` MODULE? The ELEVENTH escape of this
 * family, and the same shape as every load hook before it: THE ARGV DOES NOT
 * SHOW WHAT WILL EXECUTE. The repro, run against this branch's own gate: commit
 * a `pytest/__main__.py` whose body is nothing but an import of the target,
 * nominate `python3 -m pytest tests/unrelated_test.py` for a syntax-breaking
 * mutation with an unrelated `unittest` control, and the proof comes back
 * `proved: true` — guard red mutated, control green, guard green restored —
 * with no test having asserted the target's behaviour. `-m` resolves the module
 * from the working directory first, so the runner the argv names is
 * branch-authored code. A runner the worktree can shadow is not evidence of a
 * test runner.
 *
 * WHAT "COULD RESOLVE" MEANS is read off python's own finders for a single path
 * entry, not guessed: a DIRECTORY named `<module>` (a regular package OR a
 * NAMESPACE package — no `__init__.py` is required), a `<module>.py`, a
 * sourceless `<module>.pyc`, and an extension module `<module>.so` or
 * `<module>.<abi>.so`. MATCHING IS ON THE NAME, file or directory alike,
 * because `ls-tree --name-only` does not distinguish them and python does not
 * care: an extensionless FILE named `pytest` is an over-refusal, and it fails
 * CLOSED — it is spellable around by renaming the entry. Only `python3` can
 * reach here; every other python spelling is off the allowlist already.
 *
 * THIS ARM CONSTRAINS THE NOMINATED MODULE'S OWN NAME ONLY. The two sibling
 * escapes it does NOT see — a DEPENDENCY the real runner imports, and a config
 * pytest reads with no flag on the argv — are closed beside it by
 * `pythonImportShadow` and `pytestConfigShadow`; each is refused separately so
 * the refusal says which one fired. Windows-only suffixes (`.pyw`, `.pyd`) are
 * not probed — guards run on this host.
 */
export function pythonModuleShadow(argv: readonly string[], topLevelNames: readonly string[]): string | null {
  if (argv[0] !== 'python3' || argv[1] !== '-m' || typeof argv[2] !== 'string') return null
  // The dotted split is DEFENCE IN DEPTH, not a reachable spelling today:
  // `TEST_COMMAND_SHAPES` gates argv[2] to the literal `pytest` or `unittest`
  // on guard AND control, so `-m pkg.mod` never reaches here. It is kept so
  // this predicate stays correct if that shape is ever widened — read it as
  // "the first segment is what a path entry resolves", not as evidence that a
  // dotted `-m` is reachable.
  const top = argv[2].split('.')[0] ?? ''
  if (top.length === 0) return null
  for (const n of topLevelNames) {
    if (n === top || n === `${top}.py` || n === `${top}.pyc` || (n.startsWith(`${top}.`) && n.endsWith('.so'))) {
      return n
    }
  }
  return null
}

/**
 * THE DEPENDENCY the runner imports, not the module the argv names. Measured
 * against this branch's own gate at `62638679`: commit a top-level
 * `argparse.py` whose body is `import sys / import src.limit / sys.exit(0)`,
 * syntax-break `src/limit.py`, nominate `python3 -m unittest
 * tests.unrelated_test` as the guard, and the gate returns `ok: true, proved:
 * true` — nothing asserted the target. `pythonModuleShadow` never sees it:
 * `argparse` is not the nominated module, it is a module the REAL runner
 * imports on the way up, and `-m` has already put the worktree's own top level
 * first on `sys.path`.
 *
 * WHICH NAMES THE RUNNER IMPORTS IS NOT ENUMERABLE FROM THE ARGV, so this does
 * not try: for a `python3 -m` nomination ANY top-level MODULE FILE — `*.py`,
 * `*.pyc`, `*.so` — is treated as branch-supplied runner code and refused. That
 * is deliberately broader than the repro. The cost is an over-refusal of an
 * honest python repo that keeps a `setup.py` or a `noxfile.py` at its root, and
 * it fails CLOSED and is spellable around: move the file, or nominate `go`,
 * `cargo`, `bun`, `node` — nothing honest is made unprovable.
 *
 * THE DIRECTORY HALF OF THIS ARM is closed beside it by `pythonPackageShadow`,
 * not here: a top-level DIRECTORY shadows a dependency too, and this predicate
 * cannot see it because `ls-tree --name-only` gives a directory no suffix to
 * match. It is refused on its CONTENTS rather than its name, so a plain `src/`
 * and a plain `tests/` stay legal.
 */
export function pythonImportShadow(argv: readonly string[], topLevelNames: readonly string[]): string | null {
  if (argv[0] !== 'python3' || argv[1] !== '-m') return null
  for (const n of topLevelNames) {
    if (/\.(py|pyc|so)$/.test(n)) return n
  }
  return null
}

/**
 * THE PACKAGE, not the module file — the TWELFTH escape of this family and the
 * last arm of the python one. A review seat ran it against this branch's own
 * gate: commit `tests/__init__.py` whose body is nothing but `import
 * src.limit`, syntax-break `src/limit.py`, nominate `python3 -m unittest
 * tests.unrelated_test` as the guard with an unrelated control, and the gate
 * returned `ok: true, proved: true` — guard red mutated, control green, guard
 * green restored — with nothing having asserted the target. `argparse/` with an
 * `__init__.py` is the same escape shadowing a runner DEPENDENCY instead.
 * Neither sibling sees it: `pythonModuleShadow` reads only the module the argv
 * NAMES (here `unittest`, which the tree does not shadow), and
 * `pythonImportShadow` matches SUFFIXES over top-level names, which a directory
 * does not have.
 *
 * IT IS REFUSED ON THE DIRECTORY'S CONTENTS, NEVER ITS NAME, and that is the
 * whole reason this can exist where a name rule could not: every python repo
 * has `src/` and `tests/` at its root, so refusing top-level directories by
 * name would delete `python3 -m` from `TEST_COMMAND_SHAPES` by another route.
 * What is refused is a top-level directory DIRECTLY containing an `__init__` or
 * `__main__` MODULE — a REGULAR package, whose body executes on import with
 * nothing on the argv to show for it. A namespace package (a directory with
 * neither) shadows a name but EXECUTES NOTHING on import, so it cannot make a
 * guard pass when restored and fail when mutated, which is what a forged proof
 * needs.
 *
 * THE MARKER IS NOT SPELLED `.py` ONLY, and an earlier wording of this block
 * that said `__init__.py`/`__main__.py` was "the only shape" was FALSE — a
 * review seat forged a full `proved: true` through it one file extension away:
 * commit `argparse/__init__.pyc` with no `.py` source beside it and python
 * imports the directory as a regular package all the same
 * (`SourcelessFileLoader`), so the arm looked straight past it. AND THE ABI TAG
 * IS THE SAME HOLE ONE SPELLING OVER: `importlib.machinery.EXTENSION_SUFFIXES`
 * carries `.abi3.so` and `.cpython-<ver>-<platform>.so` beside the bare `.so`,
 * so `argparse/__init__.abi3.so` is a regular package to python and was not one
 * here — while `pythonModuleShadow` already matched the tagged spelling for the
 * file half of the same question. The suffixes are the sibling's — `py`, `pyc`,
 * `so`, tagged or not (an extension module is an `__init__` too) —
 * kept identical to `pythonImportShadow`'s on purpose: the two arms are the file
 * and directory halves of ONE question, and a suffix that is branch-authored
 * code in one is branch-authored code in the other. Windows-only spellings
 * (`.pyw`, `.pyd`) stay out for the reason the sibling states.
 *
 * THE RECURSIVE LISTING ALREADY IN HAND ANSWERS IT — the marker is matched as a
 * path of exactly two segments, so `src/pkg/__init__.py` a directory down is
 * not refused: `-m` adds the ROOT to `sys.path`, and only its direct children
 * are importable as top-level names. It fails CLOSED and is spellable around by
 * deleting the marker (unittest and pytest both discover namespace-package test
 * directories) or by nominating `go`, `cargo`, `bun`, `node`.
 */
const TOP_LEVEL_PACKAGE_MARKER = /^[^/]+\/(?:__init__|__main__)\.(?:py|pyc|so|[^/]*\.so)$/

export function pythonPackageShadow(argv: readonly string[], paths: readonly string[]): string | null {
  if (argv[0] !== 'python3' || argv[1] !== '-m') return null
  for (const p of paths) {
    if (TOP_LEVEL_PACKAGE_MARKER.test(p)) return p
  }
  return null
}

/**
 * THE CONFIG WITH NO FLAG ON THE ARGV. pytest loads the rootdir `conftest.py`
 * itself, before collection and with nothing on the command line to show for
 * it, and it obeys `addopts` out of `pytest.ini` / `tox.ini` / `setup.cfg` /
 * `pyproject.toml` — so a committed `conftest.py` whose body is `import
 * src.limit` reproduces the same forgery as a committed `pytest/__main__.py`,
 * while every argv-shaped arm of this file looks straight past it. It is the
 * residual the previous round recorded and left OPEN; this closes it, on the
 * same pinned tree the module probe reads.
 *
 * MATCHING IS ON THE BASENAME AT ANY DEPTH, not just the repo root, because
 * pytest's rootdir is derived from the ARGS: `python3 -m pytest tests/x_test.py`
 * finds `tests/conftest.py` and an ini file in `tests/` just as readily as the
 * ones beside `.git`. Enumerating which of them would actually win the rootdir
 * race means reimplementing pytest's discovery; refusing the whole basename
 * fails CLOSED and is spellable around by renaming the file or nominating
 * `unittest`, which loads none of them.
 *
 * ONLY `pytest` READS THESE. `python3 -m unittest` has no config file and no
 * auto-loaded hook, so it is not refused for a `conftest.py` sitting in a tree
 * it will never look at.
 */
const PYTEST_CONFIG_BASENAME = /^(?:conftest\.py|pytest\.ini|\.pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml)$/

export function pytestConfigShadow(argv: readonly string[], paths: readonly string[]): string | null {
  if (argv[0] !== 'python3' || argv[1] !== '-m' || argv[2] !== 'pytest') return null
  for (const p of paths) {
    const base = p.split('/').pop() ?? p
    if (PYTEST_CONFIG_BASENAME.test(base)) return p
  }
  return null
}

/**
 * THE CONFIG BUN READS WITH NOTHING ON THE ARGV — the same escape as
 * `pytestConfigShadow`, one runner over, and the runner this repository
 * actually uses. Two review seats reproduced it independently on bun 1.3.13:
 * commit a root `bunfig.toml` whose `[test] preload` names the mutated file (or
 * a file that imports it), nominate an unrelated `bun test tests/other.test.ts`
 * as the guard, and the gate returned `ok: true, proved: true` with nothing
 * having asserted the target. `bun test` reads `bunfig.toml` from its working
 * directory, and bun resolves bare specifiers through a `tsconfig.json`
 * `paths`/`baseUrl` map, so both files can point an unrelated test straight at
 * the mutated one with NOTHING on the command line to show for it.
 *
 * IT IS SCOPED TO THE FILES THE BRANCH ITSELF CHANGED, and that narrowing is
 * the whole reason this arm can exist at all. `pytestConfigShadow`'s tree-wide
 * reading is affordable because a python repo need not hold a `conftest.py`;
 * a `bunfig.toml` is different — THIS repository ships one at its root, with a
 * `[test] preload`, and every other bun repository worth the name does too. A
 * tree-wide refusal would therefore delete `bun test` from
 * `TEST_COMMAND_SHAPES` for the only runner this repo has, leaving no
 * nominatable guard at all: the exact defect this card exists to fix, arriving
 * by the door marked "security". The forgery vector is BRANCH-AUTHORED code,
 * and a config that main already carried is main's, reviewed like any other
 * merged file — the same premise the whole gate rests on. What a branch adds or
 * edits is in the diff, so a diff-scoped read sees every config the branch
 * could have written, and a rename arrives as an addition.
 *
 * REFUSED ON THE KEY, NOT THE FILENAME. A branch that touches `bunfig.toml` to
 * add a `[loader]` mapping, or `tsconfig.json` to change `strict`, has written
 * no load hook and keeps its bun nomination; a `preload =` or a `"paths":` is
 * refused whatever it points at, because following where it points means
 * resolving a module graph, which is the thing this seam exists not to trust.
 * The text is read from the PINNED checkout, never from the agent, and a
 * candidate that is absent there (the branch DELETED it) loads nothing and is
 * skipped.
 *
 * IT FAILS CLOSED and is spellable around: land the config change on its own,
 * or nominate a runner that does not read these files (`go`, `cargo`,
 * `python3 -m unittest`, `node --test`).
 */
/**
 * THE INFIX SPELLING IS IN, because the file that holds the map is routinely
 * not the one named `tsconfig.json`. This repo's root config is four lines over
 * a `tsconfig.base.json` that carries the real `paths`, so a rule matching the
 * exact basename would wave the deciding file straight through. Any
 * `tsconfig`/`jsconfig` with an infix (`tsconfig.base.json`,
 * `tsconfig.build.json`) is therefore a candidate IN ITS OWN RIGHT.
 *
 * NOT BECAUSE `extends` CARRIES THE MAP OVER — an earlier wording of this block
 * said so in both directions and was wrong twice, measured on bun 1.3.13: bun
 * does NOT follow a tsconfig `extends` chain for `paths` (a bare specifier
 * mapped only in the extended file resolves to "Cannot find module"), and a
 * root config that gains ONLY an `extends` line holds no `paths`/`baseUrl` key
 * of its own, so `bunConfigLoadHook` returns null for it and it is not refused
 * on its own. The refusal lands on whichever file actually spells the key,
 * which is exactly why the infix names have to be candidates themselves.
 *
 * PACKAGE.JSON IS IN for the same reason a tsconfig is: its `imports` (`#x`)
 * and `exports` maps decide which file a bare specifier in an unrelated test
 * means, and a review seat forged `proved: true` through a branch-rewritten
 * `imports` map redirecting a specifier inside MAIN's guard file — a redirection
 * with nothing whatever on the argv to show for it. It is refused ON THOSE KEYS
 * only, so the ordinary package.json edit (a dependency bump, a script) keeps
 * its bun nomination.
 *
 * ITS OVER-REFUSAL WAS THE WIDEST ON THIS SEAM and is now closed rather than
 * merely stated: a manifest is edited far more often than a bunfig, and a
 * monorepo's workspace packages routinely carry an `exports` map, so a PR that
 * adds a dependency to one of them lost `bun test` — in a bun-only repo, its
 * only nomination. A review seat ran that on this repository's own manifests and
 * called it what it is: the "no legal nomination exists" defect this card exists
 * to fix, re-created by the fix. The escape hatch this block used to offer,
 * "land the manifest change on its own commit", was measured and does not work —
 * the diff is read over the whole range `<base>...<ref>`, so only a separate PR
 * relieved it. What decides it now is `bunConfigHookSlice`: the key's VALUE at
 * the head is compared with its value at the MERGE BASE, and only a map the
 * BRANCH wrote is refused. Where a PRELOAD points is reasoned about one block
 * down, in `bunConfigInspected`/`hookTargetChangedByBranch`; where a resolution
 * MAP points still is not, and that block says why.
 */
const BUN_LOAD_CONFIG_BASENAME = /^(?:bunfig\.toml|package\.json|(?:ts|js)config(?:\.[\w-]+)*\.json)$/

/**
 * NODE READS THE MANIFEST TOO, and gating this whole arm on `argv[0] === 'bun'`
 * left the identical forgery open one runner over: two review seats drove the
 * gate with a branch-rewritten `package.json` `imports` map redirecting a bare
 * specifier inside MAIN's guard file and got `ok: true, proved: true` under
 * `node --test`, byte-identical to the forgery `bun test` correctly refused.
 * Node honours `imports` (`#x`) and `exports` for the package's own specifiers
 * exactly as bun does, so the map decides which FILE an unrelated test means
 * with nothing on the argv to show for it.
 *
 * PACKAGE.JSON ONLY FOR NODE, because the rest of the list is bun's alone: node
 * does not read `bunfig.toml` at all, and it does not resolve bare specifiers
 * through a tsconfig `paths`/`baseUrl` map (that is bun's and a bundler's
 * behaviour, not the ESM resolver's). Refusing those for a node nomination
 * would be an over-refusal with no forgery behind it.
 */
const NODE_LOAD_CONFIG_BASENAME = /^package\.json$/

/** The branch-changed files a `bun test` / `node --test` nomination would have loaded config out of. */
export function bunConfigCandidates(argv: readonly string[], changedPaths: readonly string[]): string[] {
  const basename = argv[0] === 'bun' ? BUN_LOAD_CONFIG_BASENAME : argv[0] === 'node' ? NODE_LOAD_CONFIG_BASENAME : null
  if (basename === null) return []
  return changedPaths.filter((p) => basename.test(p.split('/').pop() ?? p))
}

/**
 * THE CONFIG THE BRANCH DID NOT HAVE TO TOUCH. `bunConfigCandidates` is scoped
 * to the DIFF, and a review seat walked straight through that scoping: main
 * carries a `bunfig.toml` whose `[test] preload` names `tests/support/hook.ts`,
 * the branch leaves the config alone and rewrites THE HOOK, and every test
 * process bun starts executes the branch's code before a single test runs. The
 * config is not in the diff, so no candidate existed; the key is byte-identical
 * to main's, so `hookIsInherited` said "main's" — and a syntax-breaking
 * mutation with an unrelated guard came back `ok: true, proved: true` with
 * nothing asserting the target's behaviour. The docblock above conceded exactly
 * this: "Where the map POINTS is still not reasoned about."
 *
 * SO THE ROOT BUNFIG IS READ WHETHER OR NOT THE BRANCH TOUCHED IT — `bun test`
 * reads `bunfig.toml` out of its working directory, which is the worktree root
 * — and it is inspected for where its `preload` POINTS, never for who wrote it:
 * a config the branch never touched cannot be refused for being branch-authored
 * (see the `changedFiles` guard at the call site).
 *
 * THE RESOLUTION MAPS ARE DELIBERATELY NOT WIDENED THIS WAY. `imports`,
 * `exports`, `main` and a tsconfig `paths` redirect a SPECIFIER: the target is
 * loaded only if some test imports it, and the map's own text is already
 * compared against the merge base. Refusing a nomination because main's
 * `exports` map happens to name a file this branch edited would take the bun
 * nomination away from nearly every PR in a bun repo — the "no legal nomination
 * exists" defect this card exists to fix, arriving through the door marked
 * "security". A branch-changed file reached through a map is the general
 * transitive-import problem and is not decidable here.
 */
export function bunConfigInspected(argv: readonly string[], changedPaths: readonly string[]): string[] {
  const candidates = bunConfigCandidates(argv, changedPaths)
  if (argv[0] !== 'bun' || candidates.includes('bunfig.toml')) return candidates
  return [...candidates, 'bunfig.toml']
}

/**
 * ONE KEY, FOUR SPELLINGS, AND THE PARSER TAKES ALL OF THEM. A line-anchored
 * bare-key rule (`/(^|\n)[ \t]*preload[ \t]*=/`) was the whole bunfig defence
 * and a review seat walked straight past it: `"preload" = [...]`, `'preload' =
 * [...]`, `test.preload = [...]` and the inline table `test = { preload = [...] }`
 * are the SAME key to a TOML parser, and all four returned `ok: true, proved:
 * true` end to end while the bare spelling was correctly refused. This is the
 * defect this round closed for pytest one runner over: the defence matched one
 * spelling of a key the runner accepts in several.
 *
 * SO IT IS READ ANYWHERE IN THE TEXT, quoted or not, dotted or not — the same
 * unanchored reading the JSON pair below already uses, and for the same reason.
 * It over-refuses a bunfig that merely writes `preload =` inside a comment,
 * which is the direction this seam errs in everywhere else, and the branch that
 * hits it lands its config change on its own commit.
 *
 * ESCAPES ARE DECODED FIRST because a TOML basic-string key may spell itself in
 * `\u`: `"preload"` is the key `preload` to the parser and is not the
 * substring `preload` to a regex.
 *
 * THE DELIMITER IS LOOKED AT, NOT CONSUMED. An alternation (`(?:^|[^A-Za-z0-9_-])`)
 * eats the character before the key, so under the `g`-scan in
 * `bunConfigHookSlice` two occurrences sharing one character could not both
 * match — and a missed occurrence makes the head and base slices differ, which
 * REFUSES. Unreachable in valid TOML and failing closed either way, but a
 * lookbehind says the same thing without the hazard, so a later widening does
 * not inherit it.
 */
const TOML_PRELOAD_KEY = /(?<![A-Za-z0-9_-])["']?preload["']?[ \t]*=/

function decodeTomlEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (whole, short: string, long: string) => {
    const code = Number.parseInt(short ?? long, 16)
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

const JSON_HOOK_KEY: Record<string, RegExp> = {
  imports: /"imports"[ \t]*:/,
  exports: /"exports"[ \t]*:/,
  main: /"main"[ \t]*:/,
  'compilerOptions.paths': /"paths"[ \t]*:/,
  'compilerOptions.baseUrl': /"baseUrl"[ \t]*:/,
}

/**
 * THE THREE MANIFEST KEYS THAT DECIDE WHICH FILE A SPECIFIER MEANS. `main` was
 * missing and a review seat forged a proof through the gap on node v22: with no
 * `exports` map present the CJS resolver falls back to `main`, so a
 * branch-authored `"main": "./src/limit.cjs"` made `require('..')` inside an
 * otherwise unrelated guard load the mutated file — red under the mutation,
 * green restored, and nothing testing the target's behaviour. It is the same
 * redirection `imports`/`exports` already cover, spelled in the oldest key of
 * the three, and it gets the same treatment: refused only where the BRANCH
 * wrote the key, compared against the merge base by `hookIsInherited`, so an
 * inherited `main` (which nearly every published manifest carries) costs a
 * nomination nothing.
 */
const MANIFEST_HOOK_KEY = ['imports', 'exports', 'main'] as const

/**
 * EVERY load-hook key such a file carries, not just the first one. The
 * single-key reading was sound while the only question was "is there a hook at
 * all", and it stopped being sound the moment the answer had to be compared
 * against the base branch: a manifest holding an inherited `imports` map AND a
 * branch-rewritten `exports` map answered `imports`, the inherited one, and the
 * rewritten map was never looked at. Both are asked, and the arm refuses on the
 * first one the BRANCH wrote.
 */
export function bunConfigLoadHooks(path: string, text: string): string[] {
  const base = path.split('/').pop() ?? path
  if (base === 'bunfig.toml') return TOML_PRELOAD_KEY.test(decodeTomlEscapes(text)) ? ['preload'] : []
  // A RESOLUTION MAP, NOT A MANIFEST. `imports`/`exports` are the two
  // package.json keys that decide which FILE a specifier means; everything else
  // in the file (deps, scripts, version) redirects nothing, and refusing on the
  // basename alone would cost a bun-only repo its nomination on every bump.
  if (base === 'package.json') {
    return MANIFEST_HOOK_KEY.filter((k) => (JSON_HOOK_KEY[k] as RegExp).test(text))
  }
  // ANYWHERE IN THE TEXT for the JSON pair: a tsconfig is routinely written on
  // one line, and a key rule anchored to the line start read `{ "compilerOptions":
  // { "baseUrl": "." } }` as hookless. Matching the quoted key anywhere
  // over-refuses a tsconfig that merely mentions `"paths":` in a comment, which
  // is the direction this seam errs in everywhere else.
  return ['compilerOptions.paths', 'compilerOptions.baseUrl'].filter((k) => (JSON_HOOK_KEY[k] as RegExp).test(text))
}

/** The load-hook key that makes such a file decide which code the runner loads. */
export function bunConfigLoadHook(path: string, text: string): string | null {
  return bunConfigLoadHooks(path, text)[0] ?? null
}

/**
 * WHAT THE HOOK KEY ACTUALLY SAYS, canonicalised so the same map written two
 * ways compares equal — the seam that tells a map the BRANCH wrote from one it
 * merely INHERITED. A review seat proved the arm above refused on the FILE being
 * in the diff and the key being present at the head, never on the key being
 * branch-authored: a dependency bump in any workspace manifest that carries an
 * `exports` map stripped a bun-only repo of its only nomination, which is the
 * "no legal nomination exists" defect this card exists to fix, arriving through
 * the door marked "security". The escape hatch the docblock offered — land the
 * manifest change on its own commit — cannot work either, because the diff is
 * read over the whole range `<base>...<ref>`, so only a separate PR relieved it.
 *
 * SO THE VALUE IS COMPARED, NOT THE FILE. A `"exports"` map byte-identical to
 * the one at the merge base is main's, reviewed like any other merged file, and
 * the nomination stands; any difference — a new key, an edited target, a deleted
 * entry — is the branch's and is refused.
 *
 * EVERY OCCURRENCE, JOINED, because a nested second spelling of the same key is
 * a redirection the first one does not show. Whitespace runs collapse to a
 * single space so a reformat is not a change; an UNTERMINATED value reads as
 * `null`, which the caller treats as "not inherited" and refuses — this seam
 * fails CLOSED like every other one on this path.
 */
export function bunConfigHookSlice(text: string, key: string): string | null {
  const pattern = key === 'preload' ? TOML_PRELOAD_KEY : JSON_HOOK_KEY[key]
  if (pattern === undefined) return null
  const src = key === 'preload' ? decodeTomlEscapes(text) : text
  const scan = new RegExp(pattern.source, 'g')
  const values: string[] = []
  for (let m = scan.exec(src); m !== null; m = scan.exec(src)) {
    const value = readHookValue(src, m.index + m[0].length)
    if (value === null) return null
    values.push(value.replace(/\s+/g, ' ').trim())
  }
  if (values.length === 0) return null
  return values.join(' | ')
}

/** The value that starts at or after `from`: a bracketed group, a quoted string, or the rest of the line. */
function readHookValue(text: string, from: number): string | null {
  let i = from
  while (i < text.length && /\s/.test(text[i] as string)) i += 1
  if (i >= text.length) return null
  const open = text[i] as string
  const close = open === '[' ? ']' : open === '{' ? '}' : null
  if (close !== null) {
    let depth = 0
    let quote: string | null = null
    for (let j = i; j < text.length; j += 1) {
      const c = text[j] as string
      if (quote !== null) {
        if (c === '\\') j += 1
        else if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'") quote = c
      else if (c === open) depth += 1
      else if (c === close) {
        depth -= 1
        if (depth === 0) return text.slice(i, j + 1)
      }
    }
    return null
  }
  if (open === '"' || open === "'") {
    for (let j = i + 1; j < text.length; j += 1) {
      const c = text[j] as string
      if (c === '\\') j += 1
      else if (c === open) return text.slice(i, j + 1)
    }
    return null
  }
  const nl = text.indexOf('\n', i)
  const line = (nl === -1 ? text.slice(i) : text.slice(i, nl)).trim()
  return line.length === 0 ? null : line
}

/** Every path a hook's VALUE spells: its quoted strings, or the whole value if it quotes nothing. */
export function hookValuePaths(value: string): string[] {
  const quoted = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g
  const out: string[] = []
  for (let m = quoted.exec(value); m !== null; m = quoted.exec(value)) {
    const raw = (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1')
    if (raw.length > 0) out.push(raw)
  }
  // A BARE VALUE IS A PATH TOO (`preload = ./hook.ts` is not valid TOML, but a
  // JSON `"main": ./x` misspelling and a rest-of-line read both land here). An
  // empty GROUP is not: `[]` names nothing, and reading the brackets as a
  // filename would be a spelling no loader ever resolves.
  const bare = value.trim()
  if (out.length === 0 && bare.length > 0 && !'[{'.includes(bare[0] as string)) out.push(bare)
  return out
}

/**
 * WHERE THE PRELOAD POINTS: the branch-changed file this config hands the
 * runner to EXECUTE, or null if it names none.
 *
 * This is the arm that closes the escape `bunConfigInspected` describes. It
 * asks nothing about who wrote the config — an inherited `preload` is the worst
 * case, because the branch then had to touch nothing the diff-scoped arm looks
 * at. It asks only whether the code that config runs before every test is code
 * THIS BRANCH wrote.
 *
 * THE SPELLING IS CANONICALISED THE WAY EVERY OTHER PATH ON THIS SEAM IS, and
 * the loader's own rewrites are candidates too: `./tests/support/hook.js` is
 * `tests/support/hook.ts` on disk, and `./tests/support/hook` is as well. Each
 * is a CANDIDATE — matching one only ever adds a refusal.
 */
export function hookTargetChangedByBranch(text: string, key: string, changedPaths: readonly string[]): string | null {
  if (key !== 'preload') return null
  const value = bunConfigHookSlice(text, key)
  if (value === null) return null
  const changed = new Set(changedPaths.map((p) => normalizeArg(p)))
  for (const spelling of hookValuePaths(value)) {
    const named = normalizeArg(spelling)
    for (const candidate of [named, ...loaderRewrites(named), ...extensionCompletions(named)]) {
      if (changed.has(candidate)) return candidate
    }
  }
  return null
}

/**
 * THE SPELLING A LOADER REWRITES: a `.js` specifier that loads a `.ts` file.
 * bun (and tsc's `allowImportingTsExtensions`-less resolution, and node's
 * type-stripping loaders) resolve `./tests/support/clamp.js` to
 * `tests/support/clamp.ts` when that is the file on disk — verified on bun
 * 1.3.x — so `--preload=./tests/support/clamp.js` loads the MUTATED library
 * into the very process that runs the guard while equalling no repo-relative
 * target. Every lexical arm of `guardRunsTheMutatedFile` compares exact
 * normalized spellings and missed it, and this seam `realpath`ed the literal
 * `.js` name, got ENOENT and dropped the element: a forged proof came back
 * `proved: true` with nothing asserting the mutated file's behaviour.
 *
 * ONE DIRECTION ONLY, and only as a CANDIDATE. No loader rewrites `.ts` into
 * `.js`, so the map runs `js -> ts|tsx`, `jsx -> tsx`, `mjs -> mts`, `cjs ->
 * cts`. A rewrite is refused only where every other candidate is: when it
 * RESOLVES to the mutated file.
 *
 * IT OVER-REFUSES AT THE SAME-STEM BOUNDARY, and an earlier wording of this
 * block denied it. "A guard that names a `.js` file which really exists is
 * untouched" is false: the rewrite is pushed UNCONDITIONALLY, so with both
 * `clamp.js` and `clamp.ts` on disk beside each other, a guard naming the real
 * `clamp.js` still offers `clamp.ts` as a candidate and is refused for a
 * collision the loader would never make (it would have taken the `.js`). That
 * is a genuine over-refusal — pinned as such — and it is kept because it fails
 * CLOSED and because deciding it properly means re-implementing a resolver's
 * precedence, which is exactly the thing this seam exists to avoid trusting.
 * The cost is one nomination having to spell its guard differently.
 */
const LOADER_REWRITTEN_EXTENSION: Record<string, string[]> = {
  js: ['ts', 'tsx'],
  jsx: ['tsx'],
  mjs: ['mts'],
  cjs: ['cts'],
}

function loaderRewrites(path: string): string[] {
  const dot = path.lastIndexOf('.')
  if (dot <= 0 || dot < path.lastIndexOf('/')) return []
  const swaps = LOADER_REWRITTEN_EXTENSION[path.slice(dot + 1)]
  return swaps === undefined ? [] : swaps.map((ext) => `${path.slice(0, dot + 1)}${ext}`)
}

/**
 * THE EXTENSION A SPECIFIER DOES NOT HAVE TO WRITE. `--preload=./src/limit`
 * loads `src/limit.ts`, and `--preload=./src` loads `src/index.ts`: node and
 * bun both complete a bare specifier from the extension list and both fall back
 * to a directory's `index`. Every arm of `guardRunsTheMutatedFile` compares
 * WRITTEN spellings, and `guardPathCandidates` `realpath`ed the literal
 * `src/limit`, got ENOENT and dropped it — so five spellings of "preload the
 * mutated file" (`--preload=./src/limit`, `-r./src/limit`, `--preload=./src`,
 * `--preload=./src/`, `--preload=./src/index`) all passed while bun really
 * loaded the mutated module into the guard's own process. Reproduced end to end
 * on bun 1.3.x.
 *
 * ONLY WHERE AN EXTENSION IS ABSENT, so a written one is never second-guessed:
 * `report.xml` expands to nothing and stays the one file it names. Like
 * `loaderRewrites` these are CANDIDATES — each is refused only where every
 * candidate is, when it resolves to the mutated file — so the widening can add
 * refusals and never a pass.
 */
const COMPLETED_EXTENSION = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'] as const

function extensionCompletions(path: string): string[] {
  const leaf = path.slice(path.lastIndexOf('/') + 1)
  if (leaf.length === 0 || leaf.includes('.')) return []
  return COMPLETED_EXTENSION.flatMap((ext) => [`${path}.${ext}`, `${path}/index.${ext}`])
}

/**
 * How an OPTION'S CARRIED VALUE reaches the mutated file, or null if none does
 * — asked of a PRODUCTION target too, which is the whole point.
 *
 * `guardRunsTheMutatedFile` short-circuits its directory and filter arms on
 * `aRunnerMayCollect`, because for a production module a whole-suite or
 * whole-directory guard is legal: discovery does not run `src/limit.ts`. That
 * reasoning is about DISCOVERY, and an option's value is not discovered — it is
 * LOADED. `--preload=./src` hands bun a directory to execute code out of, and
 * the collectible gate meant no arm ever looked. So the carried values are read
 * here, before that gate, under the rule that fits them: a value that names the
 * file (in any spelling a loader completes), or names a directory holding it,
 * or names that directory's `index` entry, reaches it.
 *
 * IT OVER-REFUSES ON PURPOSE at the directory edge: `--grep=src` carries a word
 * that happens to be a directory prefix of the target and is refused as if it
 * were a preload. That is the same trade the collectible directory arm already
 * makes for test targets, it fails CLOSED, and the answer is the same one —
 * spell the guard's argument as the thing it means.
 */
function carriedValueReaching(guard: readonly string[], target: string): string | null {
  const start = runnerPrefixLength(guard)
  for (let i = start; i < guard.length; i += 1) {
    const arg = guard[i] as string
    // THE SEPARATOR IS NOT ALWAYS AN `=`: an option's value may be the next
    // element instead (`--preload ./src`), which is the same load with one
    // character changed — see `isBareOption`. The element BEFORE the loop's
    // first candidate belongs to the runner's own invocation (`node --test
    // x.ts`), so the pairing starts one element in.
    const previous = i > start ? (guard[i - 1] as string) : ''
    const attached = carriedValue(arg)
    const separated = attached.length === 0 && !arg.startsWith('-') && isBareOption(previous) ? normalizeArg(arg) : ''
    const value = attached.length > 0 ? attached : separated
    // The refusal names the SPELLING the build wrote, so a space-separated
    // value is reported as the two elements it really is.
    const spelling = attached.length > 0 ? arg : `${previous} ${arg}`
    if (value.length === 0 || value === '.' || namesASearch(value)) continue
    // The loader-REWRITE spelling (`clamp.js` for `clamp.ts`) is deliberately
    // NOT asked here: `guardPathCandidates` already carries it, and its refusal
    // names the file the rewrite lands on, which this arm cannot say as well.
    // THE FRAGMENT COMPOSES WITH ITS CALLER'S SENTENCE, which supplies "the
    // mutated file <path> as its own test" straight after it. "loads it as
    // <spelling>" read back as "…loads it as -rsrc the mutated file src/limit.ts
    // as its own test"; the object belongs to the caller, so this arm must not
    // supply a second one.
    if (value === target || extensionCompletions(value).includes(target)) return `loads via ${spelling}`
    // A DIRECTORY'S `index` IS THE DIRECTORY, for this question: `--preload=./src/index`
    // executes the entry point every module under `src` is reached through.
    const dir = value.endsWith('/index') ? value.slice(0, -'/index'.length) : value
    if (dir.length > 0 && target.startsWith(`${dir}/`)) {
      return `loads, via ${spelling} naming the directory holding it,`
    }
  }
  return null
}

/**
 * The LOAD HOOK this guard carries, in the caller's words, or null if it
 * carries none.
 *
 * A HOOK NAMING A THIRD FILE IS THE WRAPPER'S OPACITY IN ANOTHER SPELLING, and
 * it forged a `proved: true` end to end. `carriedValueReaching` above refuses a
 * hook whose value IS the mutated file, in every spelling a loader completes;
 * nothing could see `--preload=./tests/setup.ts` whose BODY is `import
 * '../src/limit.ts'`. That setup file is branch-authored and this gate reads
 * argv, not file bodies — so the guard loads the mutated PRODUCTION module into
 * a process running an unrelated test, a syntax-shaped mutation reddens it with
 * nothing having asserted the mutated behaviour, and the control stays green
 * because only the guard carries the hook. Reproduced against the real prover:
 * `ok: true, exempt: false, proved: true`, guard_mutated 1 / control_mutated 0 /
 * guard_restored 0, with the guard file asserting only `1 + 1`.
 *
 * So the SHAPE is refused, exactly as a wrapper's is: an option that tells a
 * runtime to EXECUTE a file before the suite opens is opaque whatever file it
 * names. It fails CLOSED, it over-refuses a repo whose suite genuinely needs a
 * hook, and it is spellable around — name the runner and the separate test,
 * which is what the hook would have run anyway.
 *
 * ASKED OF EVERY TARGET, not only a production one, because the load is the
 * same load: a support library under `tests/` is preloaded into the guard's
 * process exactly as `src/limit.ts` is, and no other arm here looks at a hook
 * that names a third file.
 *
 * THE SHORT SPELLING IS AMBIGUOUS AND IS READ NARROWLY. `-r` is node's and
 * bun's `--require`, and `-c` is bun's and jest's `--config`, but go's own
 * `-run` and `-race` also begin `-r` and carry an attached value by the same
 * rule — so an ATTACHED short value counts only when it LOOKS LIKE A PATH
 * (`-r./tests/setup.ts` and `-c./tests/bunfig.toml` do; `-run`'s `un` does
 * not). A long name is unambiguous and needs no such test.
 *
 * `-c` WAS DEFERRED HERE ON THE GROUND THAT `go test -c` SPELLS IT TOO, and
 * that deferral does not survive being read. `go test -c` is a compile-only
 * FLAG taking no value at all, so it can never wear the attached form the arm
 * above admits, and the separated form (`go test -c ./pkg`) is the only
 * collision left. That one is OVER-REFUSED on purpose, the way every ambiguity
 * here is: it fails CLOSED, and it is spellable around by dropping `-c`, since
 * the prover reads exit codes and never a compiled binary. Leaving it open cost
 * more, because `bun test -c ./tests/bunfig.toml other.test.ts` is the
 * `--config` forgery below written in two characters less.
 *
 * A REPORTER IS A LOAD HOOK TOO, and it is the same forged proof one option
 * further along. Node v22's `--test-reporter` takes a MODULE SPECIFIER and
 * executes that module inside the guard's own process while the runner is
 * loading; mocha's and vitest's `--reporter` and jest's `--reporters` do the
 * same. So a branch commits `tests/reporter.mjs` whose whole body is `import
 * '../src/limit.mjs'`, nominates `node --test
 * --test-reporter=./tests/reporter.mjs tests/other.test.mjs`, and the reporter
 * drags the mutated PRODUCTION file into a process running an unrelated test:
 * a syntax break reddens the guard, restoring it goes green, and nothing ever
 * asserted the mutated behaviour.
 *
 * REFUSED ON THE SHAPE WHATEVER THE VALUE NAMES, including a built-in name like
 * `spec` or `junit`. Telling a built-in reporter name from a bare module
 * specifier is a vocabulary bet — one this gate would lose the first time a
 * runner added a name, and losing it means accepting a forged proof — so it
 * fails CLOSED and is spellable around by dropping the option, since the prover
 * reads EXIT CODES and never a line of report output.
 *
 * `--test-reporter-destination` and `--reporter-outfile` STAY LEGAL on purpose:
 * they name a file the runner WRITES, not one it loads, and the regex is
 * anchored so it cannot match the longer option.
 *
 * A CONFIG FILE AND AN ENV FILE ARE THE SAME OPACITY ONE STEP FURTHER OUT, and
 * both are refused here. `bun test --config=./tests/bunfig.toml` hands the
 * runner a file the BRANCH wrote whose `[test] preload` key is the very hook
 * the names above refuse when it is spelled into the argv — the argv says
 * `--config`, the process loads whatever that file names, and the forged proof
 * is the one already reproduced: `ok: true, proved: true` on bun 1.3.13 with
 * the guard file asserting nothing about the mutated behaviour. `--env-file` is
 * the same instruction through a second file: a committed `.env` carrying
 * `NODE_OPTIONS=--import=<hook>` sets the hook the argv never shows, and node
 * spells the identical option `--env-file-if-exists` as well. NODE SPELLS THE
 * CONFIG ITSELF TWICE MORE: `--experimental-config-file=<file>` names a
 * branch-authored `node.config.json`, and `--experimental-default-config-file`
 * reads `node.config.json` from the cwd — both carry an `--import` through the
 * runtime's own options exactly as the dotenv does. Every one of them names a
 * file the runner READS AND OBEYS, which is not
 * `--test-reporter-destination`'s file it merely WRITES.
 *
 * A RESOLUTION MAP IS THE FOURTH SPELLING OF THE SAME FILE, and it does not
 * load anything itself — it decides WHICH FILE a specifier means. `bun test
 * --tsconfig-override=./tests/cfg/tsconfig.json` applies a branch-authored
 * `compilerOptions.paths`, so `{"mylib": ["../../src/limit.ts"]}` turns a bare
 * `import 'mylib'` inside an otherwise unrelated test into an import OF THE
 * MUTATED FILE. Reproduced on bun 1.3.13: without the flag the guard cannot
 * even resolve the specifier ("Cannot find package mylib"); with it the guard
 * exits 0 healthy, exits 1 once `src/limit.ts` is broken, and exits 0 again on
 * restore — a full red-then-green with nothing having asserted the mutated
 * behaviour. The argv NAMES the config, exactly as `--config` does, so it is
 * refused in the same place and for the same reason: the branch wrote the file
 * and this argv does not show its contents.
 *
 * A CONDITION SELECTS A BRANCH OF A MAP THE ARGV NEVER NAMES, and it is the
 * same resolution hook with the file left implicit. `package.json` `imports`
 * may be CONDITION-KEYED — `{"#lib": {"proof": "./src/limit.mjs", "default":
 * "./src/decoy.mjs"}}` — so `node --test --conditions=proof
 * tests/other.test.mjs` turns a bare `import '#lib'` inside an unrelated test
 * into an import OF THE MUTATED FILE, while the SAME argv without the flag
 * resolves to the decoy and stays green. Reproduced on node v22.23.1: healthy
 * 0, mutated 1, restored 0 with the flag; 0 while mutated without it. The FLAG
 * is what reddens the guard, which is precisely what `--tsconfig-override` is
 * refused for, so it is refused beside it. Its value is a NAME, not a path, and
 * node spells it `-C` as well — see `loadHookCarrying`, which keeps that letter
 * out of the path-filtered short pair for exactly that reason.
 *
 * ONLY THE OPTION THAT TAKES A PATH IS LISTED. `--project` and `--tsconfig` are
 * not added on suspicion: vitest's `--project <name>` selects a workspace
 * project by NAME, and a long name here is refused on the name alone, so
 * listing it would refuse an honest guard for a spelling no repro has forged a
 * proof with. The rule stays "an option the runner READS AND OBEYS AS A FILE",
 * and it is widened when a spelling is measured, not when it sounds plausible.
 *
 * A LONG NAME IS REFUSED ON THE NAME, VALUE OR NONE, and that is not belt and
 * braces — it is the only arm that can see node's DEFAULT config spelling.
 * `--experimental-default-config-file` takes no value at all: an arm that fires
 * on a carried value or on a following operand looks straight past it, and
 * `node --test --experimental-default-config-file tests/other.test.mjs` would
 * be refused only by accident (for the test path that follows it) while the
 * same option written last in the argv escaped entirely. Refusing the NAME
 * costs nothing honest: every other option here is malformed without its value.
 *
 * KNOWN RESIDUAL of the same shape, left open on purpose: pytest's `-p
 * my_plugin` executes a branch-authored plugin module, and mocha's short `-R`
 * carries a reporter the same way its long spelling does. Their letters collide
 * with `go test -p 4`'s parallelism flag and with other runners' short options,
 * the short-letter narrowing above is not widened to guess between them, and
 * the python side already carries the larger `conftest.py` residual named
 * above, which no argv rule can close.
 *
 * AND ONE MORE, NAMED HERE SO IT IS NOT REDISCOVERED: a short hook letter
 * carrying a BARE SPECIFIER — `bun test -rmylib tests/other.test.ts` — escapes
 * the letter arm, because that arm only fires on a value that looks like a
 * path. It is not a widening: a bare specifier resolves only through a
 * `tsconfig.json` or a `package.json` the branch COMMITTED, which is the
 * argv-invisible residual already documented above and reachable with NO flag
 * at all. Narrowing the letter is what keeps `go test -cover ./cmd/` legal, and
 * the residual it leaves is one the committed-config class already contains.
 */
// KEPT ON ONE LINE ON PURPOSE: `inner-workflow-mutation-claim.test.ts` reads
// these names straight out of this source to check the Forge schema names them
// too, and its extraction matches this declaration as written.
const LOAD_HOOK_OPTION = /^--(?:preload|require|import|loader|experimental-loader|test-reporter|reporter|reporters|config|experimental-config-file|experimental-default-config-file|env-file|env-file-if-exists|tsconfig-override|conditions)$/

/**
 * GO SPELLS THE SAME HOOK WITH ONE DASH, and the `^--` anchor above cannot see
 * it. `go test -exec <prog>` runs the compiled test binary THROUGH a program the
 * branch wrote; `-toolexec <prog>` runs that program for every compile and link
 * step; and `-overlay <file>` hands the toolchain a JSON map that REPLACES the
 * contents of any source file, the mutated one included. Each is a body this
 * argv does not show, and each forges the same proof: a wrapper script that
 * imports (or an overlay that rewrites) `src/limit.go` reddens an unrelated
 * guard under a syntax break and greens it on restore, with nothing having
 * asserted the mutated behaviour.
 *
 * KEPT AS A SECOND REGEX rather than widened into the first: `-e`, `-o` and
 * their neighbours are other runners' short options, and `SHORT_OPTION_WITH_ATTACHED_VALUE`
 * reads `-exec` as `-e` carrying `xec`. These three are matched WHOLE, before
 * that short-option reading, so nothing else changes meaning. Over-refusal is
 * the cost — a cross-compiling `go test -exec` is honest and is refused with
 * everything else — and it fails CLOSED and is spellable around by running the
 * test the way the guard means to.
 */
// KEPT ON ONE LINE ON PURPOSE, for the same reason as the regex above: the
// Forge-schema guard test reads these names straight out of this source.
const GO_TOOLCHAIN_HOOK_OPTION = /^-(?:exec|toolexec|overlay)$/

function loadHookCarrying(guard: readonly string[]): string | null {
  const start = runnerPrefixLength(guard)
  for (let i = start; i < guard.length; i += 1) {
    const arg = guard[i] as string
    if (!arg.startsWith('-')) continue
    const eq = arg.indexOf('=')
    // GO'S ONE-DASH LONG NAMES ARE READ WHOLE, and asked FIRST: `-exec` matches
    // `SHORT_OPTION_WITH_ATTACHED_VALUE`, so read as a short option it becomes
    // `-e` carrying `xec` and falls straight through the `continue` below —
    // which is exactly how `go test -exec ./tests/wrap.sh ./pkg` stayed legal.
    const goHook = GO_TOOLCHAIN_HOOK_OPTION.test(eq !== -1 ? arg.slice(0, eq) : arg)
    const attachedShort = !goHook && eq === -1 && SHORT_OPTION_WITH_ATTACHED_VALUE.test(arg)
    const name = eq !== -1 ? arg.slice(0, eq) : attachedShort ? arg.slice(0, 2) : arg
    const short = name === '-r' || name === '-c'
    // NODE SPELLS `--conditions` `-C`, AND ITS VALUE IS A NAME, NOT A PATH, so
    // it is kept OUT of `short` above: the path filter below exists because
    // `-cover` splits into `-c` + `over`, and applying it here would wave
    // `-Cproof` straight through — the one spelling this option is forged with.
    // A condition is refused for what it SELECTS, never for looking like a file.
    const conditionShort = name === '-C'
    if (!goHook && !short && !conditionShort && !LOAD_HOOK_OPTION.test(name)) continue
    // …and for the same reason its value is only ever the `=` half or the next
    // element: `carriedValue('-exec')` would answer `xec`.
    const attached = goHook && eq === -1 ? '' : carriedValue(arg)
    if (attached.length > 0) {
      if (short && !looksLikeAPath(attached)) continue
      return arg
    }
    // …AND THE SPACE IS A SEPARATOR HERE TOO (`--preload ./tests/setup.ts`),
    // read the way `carriedValueReaching` reads it: the next element, unless
    // that element is itself an option.
    const next = guard[i + 1]
    if (next !== undefined && next.length > 0 && !next.startsWith('-')) return `${arg} ${next}`
    // …AND A LONG NAME CARRYING NOTHING IS STILL THE HOOK — see the docblock:
    // node's `--experimental-default-config-file` never carries anything, so
    // this is the arm that sees it. The two PATH-VALUED short letters stay out:
    // `go test -c` really is a valueless flag of another runner. `-C` does not,
    // because node's condition alias is malformed without its value and a
    // refusal here costs nothing an honest guard can spell no other way.
    if (goHook || !short) return `${arg} (which reads a file this argv does not name)`
  }
  return null
}

/**
 * Every guard argv element that could NAME SOMETHING ON DISK, paired with the
 * element it came from — for the RESOLVED tautology check in the prover, which
 * follows symlinks and so cannot be done from a spelling alone.
 *
 * DELIBERATELY BROADER THAN `pathArgs`: no `looksLikeAPath` filter, because
 * resolution decides. There an unrecognised operand had to fail CLOSED into
 * "names nothing" (it feeds the no-path arm, which REFUSES on emptiness); here
 * the only consequence of admitting an element is that it gets `realpath`-ed,
 * and an element that resolves to the mutated file IS the mutated file whatever
 * argv position it occupies. The runner's own invocation is still dropped — a
 * repo with a top-level `test/` directory would otherwise see `bun test`'s own
 * `test` word resolve to it and refuse every honest guard for a library inside.
 */
function guardPathCandidates(guard: readonly string[]): { arg: string; path: string; carried: boolean }[] {
  const out: { arg: string; path: string; carried: boolean }[] = []
  for (let i = runnerPrefixLength(guard); i < guard.length; i += 1) {
    const arg = guard[i] as string
    const carried = arg.startsWith('-')
    const raw = carried ? carriedValue(arg) : arg
    if (raw.length === 0) continue
    // NORMALISE BEFORE ASKING WHETHER IT IS A SEARCH. Asked of the RAW element,
    // `./src/limit.mjs?proof` answered yes — a `?` is a glob character — so the
    // one specifier node actually loads was the one element this seam never
    // resolved. `normalizeArg` cuts the query first, and a real glob still
    // carries its `*`/`?` inside the path part.
    const path = normalizeArg(raw)
    if (namesASearch(path)) continue
    out.push({ arg, path, carried })
    // …AND THE EXTENSION THE SPECIFIER DID NOT WRITE, so `--preload=./src/limit`
    // and `--preload=./src` are asked about as the files a loader completes them
    // into (`src/limit.ts`, `src/index.ts`). See `extensionCompletions`.
    for (const completed of extensionCompletions(path)) {
      out.push({ arg: `${arg} (which a loader completes to ${completed})`, path: completed, carried })
    }
    // …AND THE SPELLING A LOADER REWRITES on its way to disk, so the `.js` name
    // of a `.ts` file is asked about as the file it actually loads. Pushed
    // AFTER the literal path, so a guard that names something real is reported
    // in its own words and only the collision falls through to this one.
    for (const rewritten of loaderRewrites(path)) {
      out.push({ arg: `${arg} (which a loader resolves to ${rewritten})`, path: rewritten, carried })
    }
    // …AND WHAT A DOTTED MODULE SELECTOR WOULD IMPORT. `src.limit` resolves to
    // nothing, so on its own it is dropped here — while `python3 -m unittest
    // src.limit` imports `src/limit.py`, and a committed symlink is enough to
    // make that a different file from the one the spelling names. The lexical
    // arm compares spellings; this is the same question asked of the disk.
    for (const path of modulePathsOf(raw)) out.push({ arg, path, carried })
  }
  return out
}

/**
 * How many LEADING argv elements are the RUNNER'S OWN INVOCATION rather than
 * arguments to it — read POSITIONALLY, off the same shapes `TEST_COMMAND_SHAPES`
 * admits, because the thing that selects the suite is not a fixed vocabulary.
 *
 * A TOKEN SET WAS THE WRONG ANSWER AND LEAKED. Dropping a leading run of known
 * words left `make test-py`, `npm run test-all` and `yarn run test-ci` with
 * their SCRIPT NAME sitting where a path goes — so `paths` came back non-empty,
 * the no-path arm never fired, and a whole-suite discovery run that collects the
 * mutated file passed as a targeted guard. The script name is arbitrary
 * (`test:unit`, `test-ci`), so only its POSITION can identify it.
 *
 * THE `run` ARM IS DEFENCE IN DEPTH and is not independently pinned: every
 * script name a project actually writes (`test:unit`, `test-ci`, `test-all`)
 * carries neither a separator nor an extension, so `looksLikeAPath` drops it
 * even when this returns 2 instead of 3. Reading the position correctly is
 * still the honest rule — the arm is unobservable only because a second filter
 * happens to catch the same class, and pinning it would take a script name no
 * project writes.
 */
function runnerPrefixLength(argv: readonly string[]): number {
  switch (argv[0]) {
    case 'bun':
    case 'go':
    case 'cargo':
    // `make <target>` — the target NAME, whatever it is called.
    case 'make':
      return 2
    // `npm test` vs `npm run <script>`: the script name is one element further.
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return argv[1] === 'run' ? 3 : 2
    // `python3 -m pytest|unittest`, plus `unittest`'s own DISCOVERY subcommand —
    // `discover` is not a path, and read as one it emptied the no-path arm of
    // meaning for `python3 -m unittest discover -p 'test*.py'`.
    case 'python3':
      return argv[2] === 'unittest' && argv[3] === 'discover' ? 4 : 3
    // `node --test <path>` — `--test` is WHAT MAKES NODE A TEST RUNNER, exactly
    // as `test` does in `bun test`, so it belongs to the INVOCATION and not to
    // the options. Read as an option it took the path after it as its operand
    // (see `pathArgs`), which emptied the selector list and refused EVERY node
    // guard for a collectible target — with no other spelling available, since
    // `node <path> --test` is not test-runner mode at all. A dead end for node
    // repos on the very class this gate exists to unblock. Only the canonical
    // leading spelling counts; anything else keeps the program-only prefix and
    // fails closed as before.
    case 'node':
      return argv[1] === '--test' ? 2 : 1
    default:
      return 1
  }
}

/**
 * Whether this program's positionals land in a command line the BRANCH WROTE
 * rather than in a runner's own selector — npm, pnpm and yarn, whose script
 * bodies live in `package.json`, and `make`, whose recipe bodies live in the
 * `Makefile`. Those are every wrapper shape on `TEST_COMMAND_SHAPES`.
 *
 * THE BYPASS THIS CLOSES, reproduced end-to-end on npm 10.9.8. The `--` arm of
 * `whyNoSelection` already refuses `npm test -- tests/x.test.ts` for the right
 * reason — everything after `--` is handed to whatever command the script runs,
 * this gate does not read `package.json`, so it cannot know what the forwarded
 * path selects and must assume the run discovers from the repo root. But npm
 * forwards a positional written WITHOUT the separator identically: `npm run
 * test-all tests/x.test.ts` executes the script's own command line with the
 * path appended. A branch may author that script, and a script ending in a
 * shell comment (`"test-all": "bun test #"`) SWALLOWS the appended path — so
 * the argv reads as a targeted guard while the run is whole-suite discovery
 * that collects the mutated file and runs it as its own test. Red mutated,
 * green restored, "proved", with the branch having supplied both halves.
 *
 * `make` IS THE FOURTH, and leaving it off left the hole open under a different
 * spelling — reproduced by a reviewer against a `Makefile` whose recipe is
 * `test-all:\n\tbun test`: the guard `make test-all tests/decoy.test.ts` came
 * back `proved: true` while the SAME repo refused `make test-all`, `npm run
 * test-all tests/decoy.test.ts` and `bun test`. Make does not forward the extra
 * positional to the recipe at all — it reads it as a SECOND GOAL, so the
 * `test-all` recipe runs its own whole-suite command line and then the named
 * file, which exists on disk (`guardSelectsNothingOnDisk` requires it to), is
 * reported up to date and exits 0. The argv reads targeted; the run is
 * discovery. Different mechanism, identical forgery, and the same lexical
 * answer: for make too, no positional counts as a selection.
 *
 * The refusal is lexical and fails CLOSED: for these four programs no
 * positional counts as a selection, so a collectible target has no wrapper
 * guard spelling. That is an OVER-refusal and it is spellable around — name the
 * test file with the runner that actually runs it (`bun test
 * tests/x.test.ts`), which is what the script or recipe would have run anyway.
 * A PRODUCTION target no longer takes a different path: this same predicate is
 * asked at the `aRunnerMayCollect` gate in `guardRunsTheMutatedFile`, so a
 * wrapper is refused as a guard for any target and the WRAPPER-OPACITY class is
 * closed rather than bounded.
 */
function forwardsPositionalsToAScript(argv: readonly string[]): boolean {
  return argv[0] === 'npm' || argv[0] === 'pnpm' || argv[0] === 'yarn' || argv[0] === 'make'
}

/** Whether a string is plainly a path at all: it has a directory separator or a
 *  file extension. The FIRST of the two filters an element must pass to count
 *  as a SELECTION — it is what keeps `bun test --timeout 1000` from presenting
 *  `1000` as "a path was named" and dodging the no-path arm. Fails CLOSED: an
 *  unrecognised element is not a path, so the argv counts as naming nothing. */
function looksLikeAPath(arg: string): boolean {
  return arg.includes('/') || /\.[A-Za-z0-9]+$/.test(arg)
}

/** A SEARCH rather than a name: a glob, or a `...` segment — go's recursive
 *  selector. `go test ./...` normalizes to the bare element `...`, which read
 *  as a named path made a WHOLE-MODULE run look targeted and kept the no-path
 *  arm from ever firing for a collectible target. A search rooted anywhere in
 *  the worktree reaches every collectible file under it. */
function namesASearch(arg: string): boolean {
  return /[*?]/.test(arg) || arg.split('/').includes('...')
}

/** A basename a runner would RUN — either convention DECLARES it a test, or a
 *  runner on the allowlist COLLECTS it. The second of the two filters an
 *  element must pass to count as a SELECTION. */
function namesATestFile(base: string): boolean {
  return TEST_BASENAME.test(base) || RUNNER_COLLECTED_BASENAME.test(base)
}

/**
 * The elements of an argv that SELECT what runs — what is left once the
 * runner's own invocation, every option, every option's carried value, and
 * everything that selects nothing are dropped. Feeds the caller's no-path arm,
 * whose question is "does this argv target anything, or does it discover?".
 *
 * A SEARCH IS NOT A SELECTION. `test*.py` and `./...` name no file, they name a
 * SEARCH, and a search rooted at the worktree reaches every collectible file in
 * it. Dropping them here is what makes the no-path arm fire on `python3 -m
 * unittest discover -p test*.py` and on `go test ./...` — discovery runs
 * wearing the argv of a targeted one.
 *
 * AN OPTION'S CARRIED VALUE IS NOT ONE EITHER, and neither is an OPERAND that
 * does not name something a runner would RUN. `bun test --timeout 1000` selects
 * no test; nor does `bun test --reporter junit.xml`, nor `bun test
 * --reporter-outfile=report.xml` — yet each once presented an element that
 * "looked like a path" and so kept the whole-suite arm from firing while the
 * runner discovered everything, mutated file included. Two filters, both
 * lexical, both failing CLOSED: the element must look like a path AND must name
 * either a DIRECTORY (no extension on its basename) or a file a runner would
 * run. `python3 -m pytest other_test.py` keeps its argument; `junit.xml` and
 * `report.xml` lose theirs.
 *
 * NOR IS AN OPTION'S SEPARATED OPERAND, and that one is decided by POSITION
 * because arity is a vocabulary. `--reporter-outfile out/report.test.ts` names
 * a file bun WRITES, and it is spelled exactly like `--bail tests/x.test.ts`
 * naming a test bun RUNS: nothing lexical tells them apart, so the operand
 * after a value-less option is dropped and the argv reads as discovery. The
 * cost is an OVER-REFUSAL a nomination can always spell around — put the path
 * before the options (`bun test tests/x.test.ts --bail`) or attach the value
 * (`--reporter-outfile=x`), and the selection is seen again.
 *
 * A BARE WORD IS A FILTER, NOT A PATH. `bun test thing` runs every test whose
 * path CONTAINS `thing` — including `src/thing_test.ts`, the mutated file — so
 * it is discovery with a sieve on it, and the first filter drops it. The cost
 * is that a directory guard must be spelled `bun test app/`, not `bun test
 * app`.
 *
 * WHAT THE LEXICAL FILTERS CANNOT DECIDE, recorded so this docblock is not read
 * as promising more than it holds: whether anything on disk answers to a word
 * that wears a path's shape. `bun test thing_test.ts` passes both filters here
 * and is a whole-suite discovery run with a substring filter on it — that one
 * is caught by the FILTER arm of `guardRunsTheMutatedFile` whenever the mutated
 * path contains the word, which is the only case where it matters. What remains
 * is a selector naming a path no tree has: existence is not a property of a
 * spelling, so it is decided where the pinned tree is,
 * `guardSelectsNothingOnDisk`.
 */
function pathArgs(argv: readonly string[]): string[] {
  const paths: string[] = []
  const start = runnerPrefixLength(argv)
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg.startsWith('-')) continue
    // AN OPTION'S SEPARATED OPERAND IS THE OPTION'S, NOT A SELECTION — and
    // which options take one is a VOCABULARY, so this reads POSITION and fails
    // CLOSED. `bun test --reporter-outfile out/report.test.ts` is a whole-suite
    // discovery run whose one operand is test-shaped enough to pass both
    // filters below; counting it as a selection is what kept the no-path arm
    // from firing while the runner collected the mutated file. An option that
    // carries its OWN value (`--reporter-outfile=x`, `-rx`) has already taken
    // one, so the operand after it IS a selection and survives.
    const prev = i > start ? (argv[i - 1] as string) : ''
    if (prev.startsWith('-') && carriedValue(prev).length === 0) continue
    if (arg.length === 0) continue
    // A PACKAGE SCRIPT'S POSITIONAL IS FORWARDED, NOT SELECTED — see
    // `forwardsPositionalsToAScript`. The same reasoning the `--` arm already
    // applied, applied to the spelling that carries no separator in front of
    // it, because npm forwards both alike.
    if (forwardsPositionalsToAScript(argv)) continue
    // NORMALISE BEFORE ASKING WHETHER IT IS A SEARCH — the same order
    // `guardPathCandidates` uses, and asking the RAW element was the
    // inconsistency between them. `./src/limit.mjs?proof` is one file's
    // specifier, not a glob: read raw it "named a search" and dropped into the
    // no-selection arm, which fails closed but describes an argv nobody wrote.
    const path = normalizeArg(arg)
    if (namesASearch(path) || !looksLikeAPath(arg)) continue
    const base = path.split('/').pop() as string
    if (/\.[A-Za-z0-9]+$/.test(base) && !namesATestFile(base)) continue
    paths.push(path)
  }
  return paths
}

/**
 * WHY an argv selected nothing — the sentence the NEXT BUILD reads, and the one
 * thing the no-path refusal was missing.
 *
 * "It names no path" is true and useless when the argv plainly names one:
 * `bun test --coverage tests/support/lib.test.ts` is refused because the
 * operand after a value-less option is that option's, so `pathArgs` drops it
 * and the argv reads as discovery. The spelling that works
 * (`bun test tests/support/lib.test.ts --coverage`) lived only in a docblock,
 * which is not where a build looks — the card's own complaint, that a refusal
 * blames the build for an omission it had no way to see, reproduced one level
 * down. Every arm below mirrors exactly one `pathArgs` filter, in the same
 * order, and names the element it dropped.
 *
 * EACH ARM ALSO OWNS ITS OWN "and so it reaches the mutated file", rather than
 * the caller gluing one sentence onto all of them. The glued one said "so the
 * runner discovers from the repo root", which the SEARCH arm cannot honestly
 * say: `bun test app/*.test.ts` discovers from `app`. Same refusal, an accurate
 * reason.
 *
 * `cargo test --test integration` lands on the first arm too, and that is the
 * whole of cargo's story: `--test`'s operand is a test TARGET name rather than
 * a path, so for a cargo repo a collectible target under `tests/` has no guard
 * spelling that selects. It fails CLOSED and it now SAYS SO instead of implying
 * the build forgot something.
 *
 * GO HAS THE SAME DEAD END, recorded here for the same reason. A support
 * library `tests/support/lib.go` is a legal TARGET (`TEST_BASENAME` only
 * declares `*_test.go`), and `aRunnerMayCollect` calls it collectible for its
 * `tests` parent — so every spelling go offers is refused: `go test
 * ./tests/support` is the DIRECTORY arm, `go test ./...` (with or without a
 * second selector) is the search, and naming `lib.go` is the exact-name arm.
 * Go's file-list mode cannot run `lib_test.go` alone either — same-package
 * symbols would be undefined. So a same-package Go library under `tests/` has
 * no provable guard. It is an OVER-refusal, never a forged proof, and the
 * available answers are a reviewer's judgement or moving the library out of
 * `tests/` — where it stops being collectible and every guard spelling works.
 */
function whyNoSelection(argv: readonly string[]): string {
  const start = runnerPrefixLength(argv)
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg.length === 0 || arg.startsWith('-')) continue
    const prev = i > start ? (argv[i - 1] as string) : ''
    if (prev.startsWith('-') && carriedValue(prev).length === 0) {
      // `--` IS NOT AN OPTION, and the generic sentence handed the build a
      // remedy no runner accepts: "attach the option's own value (--=…)". The
      // canonical npm/yarn/pnpm idiom `npm test -- tests/x.test.ts` lands on
      // exactly this arm, so the arm most builds meet was the one telling them
      // to type a spelling that does not exist. The refusal itself is
      // unchanged and still closed: everything after `--` is forwarded to
      // whatever command the package script runs, and this gate does not read
      // package.json, so it cannot know what the forwarded path selects and
      // must assume the run discovers from the repo root. What changes is that
      // the remedy is now one that exists.
      if (prev === '--') {
        return (
          `${arg} sits after the \`--\` separator, so it is forwarded to whatever command ` +
          `${argv[0] ?? 'the runner'} runs — this gate does not read package.json, so it cannot see what the ` +
          'forwarded path selects and must assume the run discovers from the repo root and reaches the mutated ' +
          'file — name the test file with the runner that actually runs it, with no separator in front of it'
        )
      }
      return (
        `${arg} is read as the operand of ${prev} rather than as a selection, ` +
        'so the runner discovers from the repo root and reaches the mutated file — ' +
        `put the path BEFORE the options, or attach the option's own value (${prev}=…)`
      )
    }
    // THE SAME FORWARDING, WITHOUT THE SEPARATOR — the arm above reads `--`,
    // and npm forwards a bare positional identically. See
    // `forwardsPositionalsToAScript` for the reproduction.
    if (forwardsPositionalsToAScript(argv)) {
      // MAKE IS NOT npm AND THE REMEDY MUST NOT LIE ABOUT IT. Make reads the
      // extra positional as a SECOND GOAL rather than forwarding it into the
      // recipe, and it is the `Makefile`, not `package.json`, that this gate
      // cannot see. Same refusal, the mechanism the build actually wrote.
      if (argv[0] === 'make') {
        const goal = argv[1] ?? 'the target'
        return (
          `${arg} is a second GOAL for make, not a selection — make runs the ${goal} recipe's own command ` +
          'line either way, and this gate does not read the Makefile, so it cannot see what that recipe runs ' +
          'and must assume the run discovers from the repo root and reaches the mutated file — name the test ' +
          'file with the runner that actually runs it'
        )
      }
      const script = argv[1] === 'run' ? (argv[2] ?? 'the script') : (argv[1] ?? 'the script')
      return (
        `${arg} is a positional argument to ${argv[0]}, which forwards it to whatever command the ` +
        `${script} script runs — this gate does not read package.json, so it cannot see what the forwarded ` +
        'path selects (a script ending in a shell comment discards it) and must assume the run discovers ' +
        'from the repo root and reaches the mutated file — name the test file with the runner that actually ' +
        'runs it'
      )
    }
    // Normalised first, mirroring `pathArgs` element for element. This is the
    // ONE arm that must not borrow the repo-root sentence: a search selects its
    // own root, and saying "discovers from the repo root" about
    // `bun test app/*.test.ts` is simply false.
    if (namesASearch(normalizeArg(arg))) {
      return `${arg} names a search, which reaches every collectible file under its root, including the mutated file`
    }
    if (!looksLikeAPath(arg)) {
      return (
        `${arg} has neither a directory separator nor an extension, so a runner reads it as a substring filter ` +
        'and discovers from the repo root, reaching the mutated file'
      )
    }
    const base = normalizeArg(arg).split('/').pop() as string
    if (/\.[A-Za-z0-9]+$/.test(base) && !namesATestFile(base)) {
      return (
        `${base} is not a name an allowlisted runner would RUN, so it selects no test ` +
        'and the runner discovers from the repo root, reaching the mutated file'
      )
    }
  }
  return 'it names no path at all, so the runner discovers from the repo root and reaches the mutated file'
}

/**
 * The SAME rule `claim.file` lives under (repo-relative, no `..`), applied to
 * every guard/control argv element.
 *
 * WITHOUT IT THE TAUTOLOGY CHECK IS BYPASSABLE BY PUNCTUATION. The guard runs
 * with the proof worktree as its cwd, and that worktree's absolute path is
 * derivable by the build (`proofWorktreePath`). So
 * `bun test /<absolute worktree path>/tests/support/lib.ts` and
 * `bun test ../<worktree-dir>/tests/support/lib.ts` both RUN the mutated file —
 * and neither can EVER equal the repo-relative `claim.file`, so the comparison
 * in `guardRunsTheMutatedFile` never sees the match. The file becomes its own
 * guard: red under the mutation, green restored, "proved".
 *
 * Refuse the SHAPE rather than trying to resolve it: a guard that runs in the
 * worktree never needs to leave it, so nothing honest is lost. Applied to the
 * WHOLE element, not just to bare path arguments, so an option that CARRIES an
 * ESCAPING path (`--preload=/abs/lib.ts`, `--preload=../x/lib.ts`) is refused
 * too. An option carrying a repo-RELATIVE path is a different problem and is
 * NOT this function's: `--preload=./tests/support/lib.ts` never leaves the
 * worktree and is legitimate punctuation, so it is the tautology check that has
 * to see through it — see `carriedValue`.
 *
 * A URL IS THE THIRD SPELLING OF AN ABSOLUTE PATH, and it wore neither of the
 * first two: `--preload=file:///<absolute worktree path>/src/limit.ts` does not
 * START with `/`, contains no `=/` (it is `=file:`) and has no `..` segment, so
 * every lexical arm above passed it — while bun loaded the MUTATED file into
 * the guard process, where it threw at preload and became its own RED against
 * an assertion-free "separate" test. `carriedValue` could not see it either:
 * `file:///a/src/limit.ts` normalizes to `file:/a/src/limit.ts`, which equals
 * no repo-relative target. So refuse the SCHEME — a guard runs in the worktree
 * and never needs a URL to name a file in it.
 *
 * KNOWN OVER-REFUSAL, recorded so the next reader does not read it as a bug:
 * `=/` also refuses innocuous option values like `make test ARGS=/tmp/out` and
 * `--grep=/foo/`. It fails CLOSED — the cost is that one nomination must spell
 * its guard differently, and no proof is ever accepted that should not be.
 */
function argvEscapesTheWorktree(arg: string): boolean {
  // THE PERCENT-DECODED SPELLING IS THE SAME ELEMENT to every loader that
  // resolves a specifier as a URL, so both spellings are asked — `%2Fabs%2Fx.js`
  // and `%2E%2E/x` are the leading `/` and the `..` with two characters of
  // punctuation on them.
  const decoded = percentDecoded(arg)
  for (const spelling of decoded === arg ? [arg] : [arg, decoded]) {
    if (elementEscapes(spelling)) return true
    // AND THE ATTACHED SHORT OPTION IS THE FOURTH SPELLING: `-r/abs/lib.ts`,
    // `-r../x/lib.ts` and `-rfile:///abs/lib.ts` hide the leading `/`, the `..`
    // and the scheme behind the option LETTER, where none of the arms above can
    // see them — while the runtime preloads the file all the same. Re-read the
    // attached value as if it stood alone.
    if (SHORT_OPTION_WITH_ATTACHED_VALUE.test(spelling) && elementEscapes(spelling.slice(2))) return true
  }
  return false
}

/**
 * A SCHEME A RUNTIME WILL LOAD, anywhere in the element: the named ones a
 * JS/python runner actually resolves, plus any scheme followed by `/`.
 *
 * `data:` earns its place beside `file:`. `--import=data:text/javascript,…`
 * carries a MODULE BODY, and that body can name the mutated file in any
 * spelling it likes — `import("file:///<absolute worktree path>/lib.ts")` (the
 * reproduced bypass) or a plain relative `import("./tests/support/lib.ts")`,
 * which is neither absolute nor `..`-escaping and normalises to nothing any
 * comparison recognises. There is no honest guard that needs to inline a module
 * body, so the whole shape is refused rather than parsed.
 *
 * A bare `word:word` is untouched — `npm run test:unit`, `make test:all` and
 * pytest's `x.py::test_a` are honest guards whose names own a colon.
 *
 * BOTH ALTERNATIVES SHARE ONE LEFT TOKEN BOUNDARY, and that is not cosmetic.
 * `|` binds across the WHOLE pattern, so the leading group used to guard only
 * the named-scheme branch; the any-scheme branch `[A-Za-z][A-Za-z0-9+.-]*:\/`
 * floated free and was retried from every offset of a long run of
 * scheme-characters that never reaches a `:/` — quadratic, and CodeQL's
 * `js/polynomial-redos` (HIGH) on argv this gate reads from an untrusted
 * nomination. Inside the boundary only ONE start position can begin the scan.
 *
 * THE ANCHORING IS NOT REGEX-LEVEL IDENTICAL, and claiming it was overstated
 * the case. It refuses strictly LESS: an any-scheme run preceded by a character
 * the boundary class excludes — `-rfile:///abs/x`, where `-` is itself a
 * scheme character — matched the free-floating alternative and no longer
 * matches here. A fuzz over 275,607 strings found ~101 such divergences and not
 * one of them is a hole, because every one is still refused downstream: by the
 * attached-short-option re-read in `argvEscapesTheWorktree` (which asks
 * `-rfile:///abs/x` again as `file:///abs/x`, matching at `^`) or by the
 * embedded-absolute arm below, which catches the `/abs` the URL carries. What
 * IS preserved is every spelling that can load anything: a scheme is meaningful
 * only where a token starts, and a run of scheme-characters starts either at
 * the element's head or straight after a character the boundary class already
 * admits — `--import=data:…` after the `=`, the embedded `file:///…` after `(`
 * or `"`, and `x.file://…` consumed from the boundary through the
 * letter-prefixed run.
 */
const LOADABLE_SCHEME = /(^|[^A-Za-z0-9+.-])(?:(?:file|data|node|blob|https?|ftp):|[A-Za-z][A-Za-z0-9+.-]*:\/)/i

function elementEscapes(arg: string): boolean {
  if (arg.startsWith('/') || arg.includes('=/') || arg.split(/[/=]/).includes('..')) return true
  // A PACKAGE-IMPORTS ALIAS IS A NAME ONLY package.json CAN RESOLVE, and it
  // resolves to whatever that file says. `"imports": {"#target":
  // "./src/limit.mjs"}` turns `node --test --import=#target
  // tests/other.test.mjs` into a preload of the MUTATED file (reproduced on
  // node v22): red under the mutation, green restored, and no test of the
  // behaviour anywhere. `normalizeArg` could not see it — `#` is node's
  // FRAGMENT delimiter there, so a leading one cuts the whole specifier away
  // and `#target` reduces to `.`, equalling no repo-relative target. Refuse the
  // SHAPE, at a token boundary so only a specifier that BEGINS with `#` is
  // caught: a guard that runs in the worktree can spell the file it wants.
  if (/(^|=)#/.test(arg)) return true
  // A scheme — `file:` in any form, or any scheme followed by `/` (`file:/…`,
  // `file:///…`, `http://…`) — ANYWHERE IN THE ELEMENT, not only at its head or
  // straight after its `=`. Anchoring it there was a hole: in
  // `--import=data:text/javascript,import("file:///<absolute worktree
  // path>/tests/support/lib.ts")` the value at the `=` is `data:`, whose colon
  // is followed by a letter, and the `file:///` that actually loads the mutated
  // file sits mid-element where no arm looked. A guard runs IN the worktree and
  // never needs a URL to name a file in it, so the scheme is refused wherever it
  // appears. A bare `word:word` is still fine — `npm run test:unit` and `make
  // test:all` are honest guards whose script name owns a colon.
  if (LOADABLE_SCHEME.test(arg)) return true
  // …AND AN ABSOLUTE PATH EMBEDDED IN A VALUE, with no scheme on it at all:
  // `--import=data:text/javascript,import("/<absolute worktree path>/lib.ts")`
  // carries a leading `/` that is not the ELEMENT'S leading `/` and follows no
  // `=`. A `/` opening a token anywhere in the element is that same absolute
  // path, so it is refused too. An ordinary relative path is untouched: every
  // separator in `tests/support/lib.ts` and `./tests/x.ts` follows a path
  // character.
  return /(^|[^A-Za-z0-9._~+-])\/[A-Za-z0-9._~-]/.test(arg)
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
  // AFTER the program and shape checks, so `rm -rf /` is still refused as "not
  // a test runner" — the more informative answer — rather than as a path.
  const escaping = (argv as string[]).find(argvEscapesTheWorktree)
  if (escaping !== undefined) {
    return (
      `claim.${which} argument ${escaping} must be a repo-relative path inside the worktree — ` +
      'an absolute, ..-escaping, URL-scheme or #package-imports-alias path re-enters the worktree under a name the tautology check cannot see'
    )
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
      const head = await deps.run_host(['git', '-C', repo, 'rev-parse', run.branch], repo)
      headSha = head.stdout.trim().toLowerCase()
      if (!head.ok || !HEX40.test(headSha)) {
        return refuse(run.id, claim, `could not resolve the head of ${run.branch}`)
      }
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
      return await proveInWorktree(
        run.id,
        claim,
        wt,
        repo,
        headSha,
        now() + budgetMs,
        input.changed_files ?? [],
        input.base_ref ?? null,
      )
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

  /**
   * How the guard runs the mutated file THROUGH A SYMLINK, or null if it does
   * not. The RESOLVED half of `guardRunsTheMutatedFile`, which compares
   * SPELLINGS only and therefore cannot see an alias.
   *
   * THE BYPASS THIS CLOSES, reproduced end-to-end against the real prover:
   * commit `tests/alias.test.ts` as a symlink to `tests/support/lib.ts`, mutate
   * the library, and nominate `bun test tests/alias.test.ts` as the guard with
   * an assertion-free control. The two spellings differ, so the static check
   * passed — and bun followed the link and ran the MUTATED file as its own
   * guard: red mutated, green restored, "proved", with nothing having asserted
   * anything. `claim.file`'s own containment is already resolved a few lines
   * above (`withinWorktree`); the guard argv was not, and that asymmetry was
   * the whole hole.
   *
   * Resolved on BOTH sides for the same reason `withinWorktree` is: the proof
   * worktree can sit under a symlinked prefix.
   */
  async function guardResolvesToTheMutatedFile(claim: MutationClaim, wt: string): Promise<string | null> {
    const rp = fs.realpath ?? (async (p: string) => p)
    let leaf: string
    try {
      leaf = resolve(await rp(join(wt, claim.file)))
    } catch {
      // Unresolvable: the "does it exist" refusal below is the better answer.
      return null
    }
    const collectible = aRunnerMayCollect(normalizeArg(claim.file))
    for (const candidate of guardPathCandidates(claim.guard)) {
      let resolved: string
      try {
        resolved = resolve(await rp(join(wt, candidate.path)))
      } catch {
        // Names nothing on disk — it cannot be running the mutated file.
        continue
      }
      if (resolved === leaf) return `names it as ${candidate.arg}, which resolves to the same file`
      // THE DIRECTORY ARM IS GATED ON DISCOVERY, NOT ON THE CANDIDATE. A
      // positional directory is a discovery root, and discovery only reaches a
      // file a runner COLLECTS — so `bun test src/` stays legal for a production
      // module. An option's value is not discovered but LOADED
      // (`--preload=./src`), so for a carried candidate the gate does not apply
      // and a directory holding the mutated file is a refusal whatever the
      // target's name. Same reasoning as `carriedValueReaching`, asked of the
      // disk so a symlinked directory cannot spell its way around it.
      if ((collectible || candidate.carried) && leaf.startsWith(resolved.endsWith(sep) ? resolved : resolved + sep)) {
        return `${candidate.carried ? 'loads' : 'collects'} it via ${candidate.arg}, which resolves to a directory holding it`
      }
    }
    return null
  }

  /**
   * The SELECTOR that names nothing on disk, or null if every one of them does
   * — the last spelling of a discovery run wearing a targeted argv, and the one
   * no lexical rule can see.
   *
   * THE BYPASS THIS CLOSES, reproduced end-to-end against the real gate. A
   * target whose name a runner COLLECTS but whose basename does not DECLARE a
   * test (`src/thing_test.ts`: `RUNNER_COLLECTED_BASENAME` yes, `TEST_BASENAME`
   * no, so it classifies `production` and is a legal nomination) plus a guard of
   * `bun test other_test.ts` — a bare word that happens to LOOK like a test
   * file. `pathArgs` counts it as a selection (it has an extension and a
   * collectible basename), so the no-path arm never fires; it equals no
   * repo-relative target, so the naming arm never fires; and there is no such
   * file, so bun reads it as a SUBSTRING FILTER over a discovery run that
   * collects `src/thing_test.ts` — the mutated file — and runs it as its own
   * guard. Red mutated, green restored, "proved", with nothing having asserted
   * anything.
   *
   * A SELECTION THAT SELECTS NOTHING IS NOT A SELECTION. Only here, with the
   * pinned tree on disk, can that be decided — the spelling alone cannot say
   * whether a path exists. So every selector is resolved, and one that names
   * nothing is refused rather than believed. It fails CLOSED: the cost is that
   * a nomination must spell its guard's argument the way the tree spells it,
   * and a guard whose file does not exist was never going to prove anything
   * anyway.
   *
   * WHAT THIS DOES *NOT* DECIDE, stated because reading it as "resolution
   * closes the filter class" is exactly the mistake that shipped: RESOLVING IS
   * NOT SELECTING EXCLUSIVELY. A `thing_test.ts` really sitting at the repo
   * root resolves here and STILL filters `src/thing_test.ts` into the same bun
   * run, and an operand that resolves because the branch committed it
   * (`--reporter-outfile out/report.test.ts`) is a file the runner WRITES while
   * it discovers everything. Both are matching semantics, not existence, so
   * both are decided lexically instead — the FILTER arm of
   * `guardRunsTheMutatedFile` and the option-operand rule in `pathArgs`. This
   * check is the third leg, and only the third.
   *
   * SCOPED TO A COLLECTIBLE TARGET, deliberately. Discovery only reaches the
   * mutated file when a runner would collect it wholesale; for a production
   * module a whole-suite guard is legal (see `guardRunsTheMutatedFile`), so a
   * phantom argument there costs the proof nothing it is owed.
   */
  async function guardSelectsNothingOnDisk(claim: MutationClaim, wt: string): Promise<string | null> {
    if (!aRunnerMayCollect(normalizeArg(claim.file))) return null
    const rp = fs.realpath ?? (async (p: string) => p)
    for (const selector of pathArgs(claim.guard)) {
      try {
        await rp(join(wt, selector))
      } catch {
        return selector
      }
    }
    return null
  }

  async function proveInWorktree(
    run_id: string,
    claim: MutationClaim,
    wt: string,
    repo: string,
    headSha: string,
    deadline: number,
    changedFiles: readonly string[],
    baseRef: string | null,
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

    // RUNNER PROVENANCE, read off the PINNED TREE. `-m` resolves the module
    // from the working directory first, so a `python3 -m <mod>` argv does not
    // say whose code will run — the tree's own contents do. The listing comes
    // from git, never from the agent; it is asked BEFORE anything is mutated or
    // run; and a listing we could not read fails CLOSED.
    //
    // IT IS RECURSIVE, and the top level is derived from it as each path's
    // first segment, because the three things it has to see live at different
    // depths: the `-m` module and a shadowed dependency resolve off the ROOT
    // (that is the one `sys.path` entry `-m` adds), while pytest's
    // `conftest.py` and its ini files are found from the ARGS upward and are
    // routinely a directory down. One listing answers all three.
    const nominated: Array<[string, readonly string[]]> = [
      ['guard', claim.guard],
      ['control', claim.control],
    ]
    const pythonArgvs = nominated.filter(([, a]) => a[0] === 'python3' && a[1] === '-m')
    if (pythonArgvs.length > 0) {
      const ls = await deps.run_host(['git', '-C', wt, 'ls-tree', '-r', '--name-only', '-z', headSha], wt)
      if (!ls.ok) {
        return refuse(
          run_id,
          claim,
          `could not read the tree of ${headSha.slice(0, 8)} to establish runner provenance for a python -m nomination — refusing rather than trusting a runner the worktree may shadow`,
        )
      }
      const paths = ls.stdout
        .split('\0')
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
      const names = [...new Set(paths.map((p) => p.split('/')[0] as string))]
      for (const [which, argv] of pythonArgvs) {
        const shadow = pythonModuleShadow(argv, names)
        if (shadow !== null) {
          return refuse(
            run_id,
            claim,
            `claim.${which} python3 -m ${argv[2]} would run BRANCH-SUPPLIED code, not the installed runner: -m resolves the module from the working directory first, and this tree's own top level contains ${shadow} — a runner the worktree can shadow is not evidence of a test runner; rename ${shadow} or nominate a runner the tree cannot shadow`,
          )
        }
        // THE CONFIG ARM IS ASKED BEFORE THE DEPENDENCY ARM, and the order is
        // about the MESSAGE, not about legality: a top-level `conftest.py`
        // satisfies both (it is a module file, and it is the file pytest
        // imports itself), and the reader is better served by the arm that
        // names what pytest does with it than by the general one.
        const config = pytestConfigShadow(argv, paths)
        if (config !== null) {
          return refuse(
            run_id,
            claim,
            `claim.${which} python3 -m pytest would load BRANCH-SUPPLIED code with nothing on the argv to show for it: this tree contains ${config}, and pytest imports conftest.py itself and obeys addopts out of its ini files — a runner whose behaviour the tree can change with no flag is not evidence of a test runner; rename ${config} or nominate python3 -m unittest, which reads neither`,
          )
        }
        const dependency = pythonImportShadow(argv, names)
        if (dependency !== null) {
          return refuse(
            run_id,
            claim,
            `claim.${which} python3 -m ${argv[2]} would run BRANCH-SUPPLIED code, not the installed runner: -m puts this tree's own top level first on sys.path, and it contains the module file ${dependency} — the runner imports modules the argv never names, so any top-level module can be the one it loads; move ${dependency} out of the tree root or nominate a runner that does not search it`,
          )
        }
        // THE PACKAGE ARM IS LAST because it is the broadest reading of the same
        // path entry: a top-level DIRECTORY is importable too, and the module
        // files above cannot see it. Refused on the marker it CONTAINS, so a
        // plain `src/`/`tests/` is untouched.
        const pkg = pythonPackageShadow(argv, paths)
        if (pkg !== null) {
          return refuse(
            run_id,
            claim,
            `claim.${which} python3 -m ${argv[2]} would run BRANCH-SUPPLIED code, not the installed runner: -m puts this tree's own top level first on sys.path, and ${pkg} makes its directory an importable package whose body executes on import — neither the runner the argv names nor any module it imports is safe from it; delete ${pkg} (both runners discover a namespace-package directory without it) or nominate a runner that does not search this tree`,
          )
        }
      }
    }

    // THE SAME QUESTION FOR BUN, asked of the files the BRANCH wrote rather
    // than of the whole tree. `bun test` reads `bunfig.toml` out of its working
    // directory and resolves bare specifiers through `tsconfig.json`, so a
    // branch-authored `preload`/`paths` puts the mutated file into an unrelated
    // test's process with nothing on the argv to show for it — two seats forged
    // a full `proved: true` that way. The diff comes from git via the gate, the
    // text from the pinned checkout, and a candidate absent there was deleted by
    // this branch and loads nothing. See `bunConfigCandidates` for why this arm
    // is diff-scoped where the pytest one is tree-wide — with the ROOT BUNFIG
    // added back unconditionally, for the reason `bunConfigInspected` gives.
    //
    // AND IT IS THE KEY'S VALUE THAT DECIDES, not the file's presence in the
    // diff. A manifest carrying a map main already wrote is main's, exactly as
    // an inherited `bunfig.toml` is; refusing it for a dependency bump beside it
    // took a bun-only repository's only nomination away. `hookProvenance`
    // compares the key at the MERGE BASE with the key at the head and refuses
    // only what this branch actually wrote. Every step of it fails CLOSED: no
    // base, no merge base, an unreadable value — all read as branch-authored;
    // a file the base does not have at all is 'added', which refuses too but
    // says something a branch can act on rather than "restore what main
    // carries", which for an ADDED file names nothing that exists.
    let mergeBase: string | null | undefined
    /**
     * 'inherited' — the key's value is byte-for-byte what the merge base carried;
     * 'added'     — the base has no such FILE, so the branch brought it;
     * 'branch'    — anything else, including every step that could not be decided.
     */
    async function hookProvenance(candidate: string, key: string, headText: string): Promise<'inherited' | 'added' | 'branch'> {
      if (baseRef === null || baseRef.trim().length === 0) return 'branch'
      if (mergeBase === undefined) {
        const mb = await deps.run_host(['git', '-C', wt, 'merge-base', baseRef, headSha], wt)
        const sha = mb.stdout.trim().toLowerCase()
        mergeBase = mb.ok && HEX40.test(sha) ? sha : null
      }
      if (mergeBase === null) return 'branch'
      const show = await deps.run_host(['git', '-C', wt, 'show', `${mergeBase}:${candidate}`], wt)
      if (!show.ok) return 'added'
      const here = bunConfigHookSlice(headText, key)
      const there = bunConfigHookSlice(show.stdout, key)
      return here !== null && there !== null && here === there ? 'inherited' : 'branch'
    }
    const changedSet = new Set(changedFiles)
    for (const [which, argv] of nominated) {
      for (const candidate of bunConfigInspected(argv, changedFiles)) {
        let text: string
        try {
          text = await fs.read(join(wt, candidate))
        } catch {
          continue
        }
        for (const key of bunConfigLoadHooks(candidate, text)) {
          // WHERE IT POINTS, FIRST — the one question that does not care who
          // wrote the config. A `preload` main itself carries, aimed at a file
          // this branch rewrote, runs the branch's code in every test process.
          const pointed = hookTargetChangedByBranch(text, key, changedFiles)
          if (pointed !== null) {
            return refuse(
              run_id,
              claim,
              `claim.${which} ${argv[0]} would load BRANCH-SUPPLIED code with nothing on the argv to show for it: the ${key} in ${candidate} names ${pointed}, which this branch rewrites, and it is executed in EVERY test process this runner starts before a single test runs — that the config itself is main's changes nothing about whose code it runs; land the change to ${pointed} in a PR of its own, or nominate a runner that does not read ${candidate}`,
            )
          }
          // AND WHO WROTE IT, second — asked only of a config in the DIFF. A
          // config the branch never touched cannot be "the map the branch
          // wrote", and reading the root bunfig unconditionally must not turn
          // an unresolvable merge base into a refusal for main's own file.
          if (!changedSet.has(candidate)) continue
          const provenance = await hookProvenance(candidate, key, text)
          if (provenance === 'inherited') continue
          const remedy =
            provenance === 'added'
              ? `${candidate} is NEW on this branch, so there is nothing at ${baseRef ?? 'the base branch'} to restore it to: land the new file in a PR of its own, or nominate a runner that does not read it`
              : `restore ${key} to what ${baseRef ?? 'the base branch'} carries, land it in a PR of its own, or nominate a runner that does not read it`
          return refuse(
            run_id,
            claim,
            `claim.${which} ${argv[0]} would load BRANCH-SUPPLIED code with nothing on the argv to show for it: this branch writes the ${key} in ${candidate}, and it decides which files the runner loads for every test it runs — a runner whose behaviour the branch changes with no flag is not evidence of a test runner; ${remedy}`,
          )
        }
      }
    }

    // THE TAUTOLOGY, RESOLVED. Before a single byte is mutated: does any guard
    // argument resolve to the file about to be broken? `validateClaim` asked
    // the same question of the SPELLINGS; only here, with the worktree on
    // disk, can a symlink be followed.
    const aliased = await guardResolvesToTheMutatedFile(claim, wt)
    if (aliased !== null) {
      return refuse(
        run_id,
        claim,
        `claim.guard ${aliased} — a tautology, not a proof: the guard must be a separate test OF the behaviour of ${claim.file}`,
      )
    }

    // AND THE SELECTOR THAT NAMES NOTHING. A guard argument that exists in no
    // tree is not selecting a test, it is a filter over a discovery run — which
    // reaches the mutated file when a runner collects it. Same seam, same
    // reason it cannot be decided lexically.
    const phantom = await guardSelectsNothingOnDisk(claim, wt)
    if (phantom !== null) {
      return refuse(
        run_id,
        claim,
        `claim.guard names ${phantom}, which does not exist at ${headSha.slice(0, 8)} — a selector that selects nothing is a filter over a whole-suite discovery run, and that run collects the mutated file ${claim.file}: name the separate test you mean, spelled as the tree spells it`,
      )
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

    // THE TREE THE RESTORED-GUARD OBSERVATION IS OF. Everything that has run
    // by this line is BRANCH-AUTHORED code: the control by construction (a
    // wrapper, or any test file whose module body executes on load), and the
    // guard's own first run just as much. It executed BETWEEN the guard's RED
    // and its GREEN with write access to the whole worktree, and nothing
    // checked what it wrote to anything but claim.file. Review round 8
    // reproduced exactly that at this branch's head: an unconditionally-red
    // guard that never imports the target, plus a control whose module body
    // writeFileSync's a passing copy of the guard's test file, came back
    // proved:true — red, green, green, with nothing having tested the target;
    // and again with the control spelled as a make wrapper.
    //
    // RE-PROVISION rather than a `git status --porcelain` gate. Porcelain is
    // blind to writes under ignored paths — a control that writes into
    // node_modules plants code the guard then imports, and the tree still
    // reads clean — and it would refuse honest runners that drop caches
    // beside their tests (__pycache__, .pytest_cache, coverage output): a hole
    // in one direction and an over-refusal in the other. A fresh checkout of
    // the PINNED sha makes the final observation identical to the commit BY
    // CONSTRUCTION, whatever ran and wherever it wrote.
    //
    // The same re-provision closes the ONE-ACTOR variant, which no inspection
    // of the control could ever see: a GUARD whose first (red) run rewrites
    // ITSELF green.
    //
    // Containment is not re-checked afterwards: the re-provisioned tree is the
    // same immutable commit the check at the top of this function already
    // passed against.
    await deps.run_host(['git', '-C', repo, 'worktree', 'remove', '--force', wt], repo)
    const reAdd = await deps.run_host(['git', '-C', repo, 'worktree', 'add', '--detach', '--force', wt, headSha], repo)
    if (!reAdd.ok) {
      return refuse(
        run_id,
        claim,
        'could not re-provision the proof worktree after the nominated commands ran — the restored-guard observation must be of a tree no nominated command edited',
      )
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
  // WHAT `proved: true` MEANS, AND WHAT IT DOES NOT — the standing limit of a
  // mutation proof, recorded here because a review seat reproduced it and the
  // honest answer is that it is not closable at this seam. The oracle observes
  // three EXIT CODES; it cannot see whether the guard ASSERTED anything. A
  // guard that merely imports the mutated file — `import '../src/lib.ts';
  // test('x', () => {})` — goes red under a syntax-breaking mutation and green
  // when restored, which is the accepted shape exactly. Distinguishing
  // load-coverage from behaviour means reading the guard's source and deciding
  // what an assertion IS, per framework, and a gate that guessed wrong would
  // refuse honest proofs instead of forged ones. So the mitigations are the ones
  // already here and they are all structural: the guard may not run the mutated
  // file (`guardRunsTheMutatedFile`), it may not be the control, its runner may
  // not be branch-supplied (the shadow arms above), and the argv it really ran
  // is written into the reason below, onto the run row, for the reviewer who
  // reads the diff. This is a documented limit of mutation proofs, not a
  // property this branch removed.
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
 *
 * `.trident` IS DELIBERATELY NOT ON THIS LIST, and the reason is the defect this
 * whole gate change exists to fix. A plan under `.trident/plans/` is read by an
 * AGENT and never by the harness, and a plan-doc-only commit is a real shape in
 * this repo (`159ceee7` is one) — so listing it here would classify that commit
 * as production, require a proof of it, and leave no legal target to nominate:
 * exactly the no-reachable-outcome bug fixed above, re-created for plan docs.
 * The escape it leaves open is narrow and named: a diff of {plan doc + declared
 * tests} takes the no-production-file exemption. Nothing that ships reads those
 * files, and a reviewer reads the plan anyway. Reopen it here only together
 * with an outcome for the plan-only diff.
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
    // BYTE-EXACT, deliberately: a surrounding-whitespace path is NOT trimmed
    // into prose. `README.md ` (trailing space) is a different file from
    // `README.md`, and trimming let it carry a whole diff into the prose-only
    // exemption. Fails CLOSED — an odd name means "require the proof".
    const path = raw
    if (path.length === 0 || path.trim().length !== path.length) return false
    const segments = path.split('/')
    if (segments.some((segment) => PROSE_DIR_DENYLIST.includes(segment))) return false
    const base = segments[segments.length - 1] ?? ''
    if (EXECUTABLE_PROSE_FILES.includes(base)) return false
    if (PROSE_EXACT.includes(base)) return true
    return PROSE_SUFFIXES.some((suffix) => base.endsWith(suffix))
  })
}

/** One entry of the branch diff: the path git wrote, and whether the branch
 *  DELETES it. A deleted path really did change, so it stays in the diff — but
 *  it is absent at the pinned head, so no mutation can ever apply to it. */
export interface ChangedFile {
  path: string
  deleted: boolean
}

/**
 * The files this branch changes against `base`, WITH their status, per git —
 * NEVER per an agent's account of them. Returns null when the diff could not be
 * read or came back malformed, which every consumer treats as "require the
 * proof".
 *
 * `ref` should be a PINNED commit sha wherever the answer is going to be used to
 * decide something (the gate passes one): given a branch NAME this re-resolves
 * the ref, and a branch that moves between two such resolutions yields a file
 * list for a commit nobody is proving.
 */
export async function changedFilesWithStatus(
  run_host: RunHostCommand,
  repo_path: string,
  base_branch: string,
  ref: string | null,
): Promise<ChangedFile[] | null> {
  if (ref === null || ref.trim().length === 0) return null
  // `--no-renames`: rename detection prints ONLY the destination, so a
  // production file `git mv`-ed to a test-shaped name would appear in this list
  // as a declared test and could carry the whole diff into the exemption below.
  // Without it the source path — the production file that actually changed —
  // is invisible to every classifier downstream.
  // `-z` IS THE FLAG THAT KEEPS THE PATHS: it turns off C-QUOTING as well as
  // line-splitting, so `tests/süß.test.ts` arrives as itself rather than as
  // `"tests/s\303\274\303\237.test.ts"` — a spelling whose basename matches
  // `TEST_BASENAME` no longer (a declared test would classify `production`, and
  // the exemption could not fire) and which `files.includes(claim.file)` can
  // never match either, so the gate would refuse and blame the build for an
  // omission it did not make. `core.quotePath=false` is belt and braces: under
  // `-z` it is INERT (deleting it leaves the real-git non-ASCII behaviour
  // unchanged), and it is kept only so a future reader who drops `-z` does not
  // silently reintroduce quoting.
  // NUL parsing with NO per-record `.trim()`: a path is BYTES, and a split that
  // trims is not byte-preserving. `src/logic.test.ts ` (trailing space — a
  // legal git path, and a production file) trimmed to `src/logic.test.ts`
  // classifies as a DECLARED TEST, which is exactly the input the
  // no-production-file exemption is decided on. The same trim also hid a path
  // containing a newline, which `\n`-splitting tore into two half-paths that
  // classify as neither. Matches `listConflictedFiles` in merge.ts, which reads
  // git the same way for the same reason.
  // `--name-status` RATHER THAN `--name-only`, and that is not cosmetic on
  // either count:
  //   (a) IT MAKES THE PARSE TRIM-PROOF. `run_host` returns `stdout.trim()`
  //       (git-mode.ts), which runs BEFORE this function sees a byte — so under
  //       `--name-only` a first path spelled ` README.md` (leading space, a
  //       legal git path) arrived as `README.md` and bought the prose-only
  //       exemption, defeating the byte-exactness this parse promises. Trailing
  //       whitespace already survived because the record ends in NUL and NUL is
  //       not whitespace; a leading STATUS LETTER gives the front of the stream
  //       the same protection, and there is no untrimmed host seam to reach for.
  //   (b) IT DISTINGUISHES A DELETION. A path the branch DELETES is a real
  //       change and belongs in this list, but it is absent at the pinned head,
  //       so nominating it is refused ("does not exist at <sha>") — and calling
  //       it a legal target made a deletion-only diff an unreachable-nomination
  //       deadlock: the refusal named the one file that could not be named back.
  const res = await run_host(
    [
      'git',
      '-C',
      repo_path,
      '-c',
      'core.quotePath=false',
      'diff',
      '-z',
      '--no-renames',
      '--name-status',
      `${base_branch}...${ref}`,
    ],
    repo_path,
  )
  if (!res.ok) return null
  // AN EMPTY DIFF IS AN ANSWER, NOT A FAILURE — and collapsing the two made the
  // gate say "the branch diff could not be read" about a branch whose diff was
  // read perfectly and was empty. git exits 0 and prints nothing; the reader
  // then split '' into [''] and reported the same null a git FAILURE reports,
  // which left the dedicated "the branch diff is empty" refusal unreachable and
  // the operator chasing a git problem that never happened. Both still fail
  // closed — `[]` is not exempt (`diffHasNoLegalMutationTarget`) and carries no
  // `claim.file`, so the proof is still required — they just say which is true.
  if (res.stdout.length === 0) return []
  // `<status>NUL<path>NUL…`, so a well-formed answer has an EVEN number of
  // records and a trailing empty token after the final NUL. Anything else — a
  // truncated stream, a status field that is not the single letter
  // `--no-renames` guarantees (a rename score `R100` would carry two paths) —
  // reads as null, i.e. REQUIRE THE PROOF. Fails closed at every step, like
  // every other reader on this path.
  const records = res.stdout.split('\0')
  if (records.length < 3 || records[records.length - 1] !== '') return null
  const fields = records.slice(0, -1)
  if (fields.length % 2 !== 0) return null
  const out: ChangedFile[] = []
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i] as string
    const path = fields[i + 1] as string
    if (!/^[A-Z]$/.test(status) || path.length === 0) return null
    out.push({ path, deleted: status === 'D' })
  }
  return out
}

/**
 * The PATHS this branch changes — `changedFilesWithStatus` with the status
 * dropped. Deletions are INCLUDED: `claim.file` must appear in this list, and a
 * branch that deletes a file really did change it. Whether a path can be
 * MUTATED is a separate question, answered off the status.
 */
export async function changedFilesOnBranch(
  run_host: RunHostCommand,
  repo_path: string,
  base_branch: string,
  ref: string | null,
): Promise<string[] | null> {
  const entries = await changedFilesWithStatus(run_host, repo_path, base_branch, ref)
  return entries === null ? null : entries.map((e) => e.path)
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
  /**
   * True when the diff itself made the proof moot and none was run — either
   * because it is prose-only, or because git says it changed no production
   * file at all. `reason` says WHICH; the two strings are deliberately
   * distinct so a run record never has to guess.
   */
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return false
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
  if (!check.ok) {
    const detail = check.stderr.trim().slice(0, 120)
    return `git check-ref-format --branch rejects it${detail.length > 0 ? `: ${detail}` : ''}`
  }
  return null
}

/**
 * Resolve the head the MERGE would take, without requiring the run's LOCAL
 * branch ref to still exist. A run's worktree — which is what holds the local
 * branch — is routinely cleaned up before this gate runs (#482 refused an
 * APPROVED build exactly this way); the commit itself is still in the object
 * store and reachable through the remote-tracking ref. Resolution order:
 *   1. the local ref, as a bare name — byte-identical to the pre-existing
 *      behaviour whenever the worktree is live;
 *   2. `refs/remotes/origin/<branch>`, and ONLY after a fetch that SUCCEEDED
 *      with an explicit forced refspec (see below);
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

  // `--verify --quiet` is not cosmetic: PLAIN `rev-parse` echoes
  // `--end-of-options` itself as the first output line and, on a name it cannot
  // resolve, echoes the name too. `--verify` prints one sha or nothing.
  const local = await run_host(
    ['git', '-C', repo_path, 'rev-parse', '--verify', '--quiet', '--end-of-options', branch ?? 'HEAD'],
    repo_path,
  )
  const localSha = local.stdout.trim().toLowerCase()
  // `local.ok` is load-bearing: a failing `git rev-parse <name>` can still print
  // to stdout, and on a 40-hex-shaped branch name that print is hex — the exit
  // code is the only thing that says git actually resolved it.
  if (local.ok && HEX40.test(localSha)) return localSha

  if (branch !== null) {
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
 * THE NO-PRODUCTION-FILE EXEMPTION, as a predicate — exported so the empty-list
 * arm is REACHABLE and pinned. An empty list DOES arrive from the gate now that
 * `changedFilesWithStatus` tells an empty diff apart from an unreadable one,
 * and it is NOT exempt: `[].every(…)` is vacuously true, which would turn "this
 * branch changes nothing" into "nothing to mutate, merge it". A diff with no
 * files has no production change to certify and no claim to bind, so it fails
 * closed into requiring the proof and is refused by name.
 */
export function diffHasNoLegalMutationTarget(files: readonly string[] | null): boolean {
  if (files === null || files.length === 0) return false
  return files.every((f) => classifyMutationTarget(f) !== 'production')
}

/**
 * The changed paths a mutation could actually be APPLIED to: production by
 * classification, AND still present at the head being proved.
 *
 * THE SECOND HALF IS WHY THIS EXISTS. A path this branch DELETES is a real
 * change and stays in the diff — `claim.file` must appear there — but the
 * prover reads the file out of the pinned worktree and refuses what is not
 * there ("does not exist at <sha> — the mutation cannot apply"). Naming a
 * deletion as the target the build SHOULD have nominated therefore closed a
 * loop on the reader: the refusal named the one file that could not be named
 * back. So the refusal is written off THIS list, and a diff whose only
 * production changes are deletions is told exactly that instead.
 *
 * IT IS NOT AN EXEMPTION, and that is deliberate. `git mv src/limit.ts
 * src/limit.test.ts` reaches the reader as a DELETION plus a test-shaped
 * addition (`--no-renames`, so the source is visible) — the code is still in
 * the tree, still running, and "no production file changed" would be a lie
 * about it. Treating deletions as absent targets for the EXEMPTION would hand
 * that rename the free pass `--no-renames` exists to deny. So the proof is
 * still required, and the refusal says why none can be run.
 */
export function legalMutationTargets(files: readonly string[] | null, deleted: readonly string[] = []): string[] {
  if (files === null) return []
  // A SET, because both lists come from git and neither is bounded: `includes`
  // inside `filter` is O(files x deleted), ~2.5e7 comparisons on a 5k/5k rename.
  // Availability hygiene only — the answer is identical.
  const gone = new Set(deleted)
  return files.filter((f) => classifyMutationTarget(f) === 'production' && !gone.has(f))
}

/**
 * Why a required proof with NO claim is refused — split so the message never
 * blames the build for an omission it could not avoid. The no-legal-target
 * branch is defense-in-depth: the exemption above uses the same classifier,
 * so reaching it means the two disagreed — a gate defect, and the message
 * says so, naming a file it considered and why it was disqualified.
 */
/** A source extension an allowlisted runner actually executes — used ONLY to
 *  pick which legal target the refusal names, never to decide legality. */
const EXECUTABLE_SOURCE = /\.([cm]?[jt]sx?|go|py|rs)$/

/**
 * A path AS A REASON STRING PRINTS IT. Git's `-z` parse preserves every byte of
 * a filename, correctly — a path really may contain a newline — but a reason is
 * a one-line record that reaches a log line, a status post and a DB row, and
 * `src/new\nline.ts` interpolated raw turns one of those into two. Escaped, not
 * dropped: the reader still needs the name to find the file.
 */
function asReason(path: string): string {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(path) ? JSON.stringify(path) : path
}

/** The budget in characters for a file list interpolated into ONE reason
 *  string. Chosen so that every diff this gate has ever seen names every file
 *  and nothing is elided in practice; it exists for the thousand-file rename,
 *  which is bounded only by git and would otherwise reach a log line, a status
 *  post and a DB row whole.
 *
 *  IT SITS BELOW `orchestrator.ts`'s `STAGE_REASON_CEILING` (4,000) ON PURPOSE.
 *  At 4,000 the two were equal, so the one line this cap exists for — the
 *  thousand-file diff, whose reason measured 4,092 characters ending `… +903
 *  more)` — was cut by the stage-row truncation at 4,065, mid-name, taking the
 *  elision COUNT with it: the reader lost both the last name and the fact that
 *  anything had been elided, which is the exact failure `namesWithinBudget` was
 *  written to prevent. The prefix around the list ("no production file in this
 *  diff — nothing to mutate: all N changed files are…") plus the `, … +N more`
 *  suffix is comfortably under 400 characters, so a 3,600 name budget keeps the
 *  WHOLE reason, elision count included, inside the durable row. */
const REASON_NAME_BUDGET = 3_600

/** As many of `paths` as fit the budget, in order, with the elision COUNTED
 *  rather than implied — a list that silently stops is worse than no list. The
 *  budget bounds the NAMES; the result may exceed it by two deliberate amounts,
 *  because both are worth more than an exact ceiling: the `, … +N more` suffix
 *  is appended after the budget is spent, and the FIRST name is always printed
 *  however long it is, since a reason that names nothing but a count is not a
 *  reason. Every consumer bounds its own copy (`truncateNote`,
 *  `truncateStageReason`), so this is a courtesy cap, not a guarantee. */
function namesWithinBudget(paths: readonly string[]): string {
  const kept: string[] = []
  let used = 0
  for (const p of paths) {
    const name = asReason(p)
    if (kept.length > 0 && used + name.length + 2 > REASON_NAME_BUDGET) break
    kept.push(name)
    used += name.length + 2
  }
  const elided = paths.length - kept.length
  return elided > 0 ? `${kept.join(', ')}, … +${elided} more` : kept.join(', ')
}

export function missingClaimRefusalReason(files: readonly string[] | null, deleted: readonly string[] = []): string {
  if (files === null) {
    return 'mutation proof required but the branch diff could not be read — a proof cannot be bound to it'
  }
  if (files.length === 0) {
    return 'mutation proof required but the branch diff is empty — a proof cannot be bound to a diff with no files'
  }
  const legal = legalMutationTargets(files, deleted)
  // NAME A TARGET A RUNNER COULD ACTUALLY REDDEN, when the diff has one. Every
  // legal target is legal by CLASSIFICATION — not prose, not a declared test —
  // and that admits files no allowlisted runner executes: a `.github/workflows`
  // YAML is not prose (`PROSE_DIR_DENYLIST`), so a workflow-plus-README diff was
  // told, confidently, that the YAML was the mutation it should have nominated.
  // Requiring a proof for that class is older than this branch and is left
  // alone; naming an unprovable file as the answer is what this fixes. So a
  // source file is preferred, and when none exists the message says the target
  // it names may not be reddenable at all.
  const executable = legal.find((f) => EXECUTABLE_SOURCE.test(f))
  const named = executable ?? legal[0]
  if (named !== undefined) {
    const caveat =
      executable === undefined
        ? ' — if no allowlisted runner can execute it, that is a finding for the reviewer rather than a nomination the build can make'
        : ''
    return `mutation proof required but the build nominated no mutation to run — a legal mutation target existed: ${asReason(named)} changed in this diff and is neither a declared test nor documentation${caveat}`
  }
  // THE DELETION-ONLY DIFF, said out loud. This branch is REACHABLE and is not
  // a gate defect: a deleted production file is a production change (so no
  // exemption fires) that no mutation can be applied to (so no nomination can
  // pass). The old message called the deleted file "a legal mutation target
  // [that] existed" and told the build to nominate it — which the prover then
  // refused for being absent. Naming the deadlock is the whole fix available
  // here: exempting it would be the rename bypass in a new coat.
  const deletedSet = new Set(deleted)
  const gone = files.filter((f) => deletedSet.has(f) && classifyMutationTarget(f) === 'production')
  if (gone.length > 0) {
    return (
      `mutation proof required but NO mutation of this diff can be run: its only production changes are DELETIONS ` +
      `(${namesWithinBudget(gone)}), which are absent at the head being proved — nominating one is refused because the ` +
      `mutation cannot apply, and nothing else in the diff is a legal target. This diff needs a reviewer's ` +
      `judgement, not a proof.`
    )
  }
  const first = files[0] as string
  const why = classifyMutationTarget(first) === 'test' ? 'a declared test file' : 'documentation'
  return `mutation proof required but no file in this diff is a legal mutation target — e.g. ${asReason(first)} is ${why} — yet no exemption fired; that disagreement is a gate defect, not a build omission`
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

  const entries = await changedFilesWithStatus(input.run_host, input.run.repo_path, input.base_branch, pinnedSha)
  const files = entries === null ? null : entries.map((e) => e.path)
  // The paths this branch DELETES: still part of the diff, never mutatable.
  const deleted = (entries ?? []).filter((e) => e.deleted).map((e) => e.path)
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

  // A DIFF WITH NO LEGAL MUTATION TARGET: every changed file is a declared test
  // or documentation, so the set of nominations that could pass is EMPTY, and
  // requiring a proof is asking for one with no referent. Sound because `files`
  // comes from git (changedFilesWithStatus), never from the agent: if no
  // production file changed, no production behaviour can have regressed.
  // Recorded exactly like the prose-only exemption (`exempt: true` + its OWN
  // reason string) so the run record shows WHICH exemption fired; bound to the
  // pinned commit the same way, and claim-independent for the same reason the
  // prose path is: the premise is about the diff, not the nomination.
  //
  // THE SOFT EDGES, stated so a reader does not have to find them.
  //
  // (1) The file LIST comes from git, but the file NAMES are written by the
  // build, and a name is what makes a file a "declared test". So a build that
  // put production logic in `src/limit.test.ts` — or in `src/__tests__/impl.ts`,
  // the DIRECTORY route to the same declaration — would buy this exemption.
  // `TEST_BASENAME` is held to the CONVENTIONAL declarations exactly to keep
  // that surface as small as it can be (a looser name like `src/ab-test.ts`
  // stays `production` and buys nothing), and the rest is VISIBILITY: the reason
  // below names EVERY changed file, so the run record shows the reviewer exactly
  // which names to disbelieve.
  //
  // (2) An all-declared-test diff is exempt whatever it does to those tests —
  // including a PR that deletes assertions. That is the honest consequence of
  // the premise: this gate proves that PRODUCTION behaviour did not silently
  // regress, and it has no opinion on test content. A weakened suite is a
  // REVIEW finding (Argus reads the diff), not something a mutation of a
  // production file that nobody changed could ever have caught.
  //
  // (3) A production file this branch DELETES is still a production change, so
  // this exemption does NOT fire for it — even though no mutation can be
  // applied to a file that is absent at the pinned head. That asymmetry is
  // deliberate: `git mv src/limit.ts src/limit.test.ts` arrives as a deletion
  // plus a test-shaped addition, and exempting deletions would hand that rename
  // the free pass `--no-renames` exists to deny. What the deletion changes is
  // the REFUSAL: it no longer names an unnominatable file as the target the
  // build should have picked (see `missingClaimRefusalReason`).
  if (diffHasNoLegalMutationTarget(files)) {
    const stillThere = await headStillAt(input, pinnedSha)
    if (!stillThere) {
      return {
        ok: false,
        reason: 'mutation proof rejected: the branch moved while the no-production-file exemption was being decided',
        exempt: false,
        evidence: null,
      }
    }
    const changed = files as string[]
    // NAME THEM ALL — every changed file, not just the declared tests. These
    // are the names the exemption rests on, and this string is the only place
    // they outlive the run. A list FILTERED to the tests hides the rest of the
    // diff the exemption also covered, and a silent truncation hides exactly
    // the entry a reviewer is here for — five ordinary `*.test.ts` names and a
    // sixth that is production logic wearing a test's name. So the list is
    // capped by TOTAL LENGTH, not by count, and the cap announces itself: every
    // ordinary diff still names every file, and the pathological one — a
    // thousand-file test-only rename — no longer interpolates a multi-hundred-KB
    // single line into the log line. The tick note and the stage row cap their
    // OWN copies already (`truncateNote`, `truncateStageReason`), and this does
    // not replace them: it bounds the string where it is BUILT, so the cut is
    // announced as a count of elided names rather than as a byte offset, and a
    // consumer that does not truncate cannot be handed the blob in the first
    // place. The count before the list is the honest total either way.
    return {
      ok: true,
      reason: `no production file in this diff — nothing to mutate: all ${changed.length} changed files are declared tests or documentation (${namesWithinBudget(changed)})`,
      exempt: true,
      evidence: null,
    }
  }

  if (input.claim === null || input.claim === undefined) {
    return { ok: false, reason: missingClaimRefusalReason(files, deleted), exempt: false, evidence: null }
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
  // `changed_files` is the SAME git-derived list that bound the proof to this PR
  // two checks above. Runner provenance needs it: a config file this branch
  // wrote decides which code a `bun test` guard loads (`bunConfigCandidates`).
  // `base_ref` is the other half of that question — the diff says the branch
  // TOUCHED the file, and only the base says whether the branch wrote the load
  // hook inside it.
  const evidence = await prover.prove({
    run: input.run,
    claim: input.claim,
    head_sha: pinnedSha,
    changed_files: files,
    base_ref: input.base_branch,
  })

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
