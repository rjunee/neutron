/**
 * Deterministic PURITY PREFLIGHT — run the public leak gate on a branch's own
 * tree BEFORE the PR is opened, and report a verdict the caller can act on.
 *
 * WHY THIS EXISTS. On 2026-08-31, 3 of 4 trident PRs opened that night were red,
 * and every one of them was red on exactly one check: `scripts/ci/leak-gate.sh`.
 * typecheck, lint, layering and every test shard were green. In all three cases
 * the finding was in the branch's OWN plan doc under `.trident/plans/` — prose
 * the builder REGENERATES each run, in which it warns itself not to write the
 * very vocabulary the gate bans. The note asserting compliance was the
 * violation. Because that prose is model-authored fresh every round, a wording
 * fix cannot hold; only a mechanical loop can. So: run the gate here, hand the
 * findings back to a bounded fixer, and re-run.
 *
 * WORD DISCIPLINE FOR THIS FILE. The vocabulary rules at
 * `scripts/ci/leak-gate.sh:367` and `:387` match a six-letter retired
 * multi-org word ANYWHERE in a committed file — source, comment or test. It is
 * never written literally here; where a fixture needs it, it is assembled from
 * fragments at runtime (the discipline `scripts/ci/leak-gate-selftest.test.ts`
 * established). Absolute host filesystem paths are banned the same way.
 *
 * FOUR INVARIANTS, each of them load-bearing:
 *
 * 1. SENTINEL-OR-ERROR. A verdict is an exit code AND the gate's own verdict
 *    line. An exit 0 with no sentinel — a truncated run, a blind test double, a
 *    gate that died before it scanned — is `gate-error`, NEVER `clean`. "Looked
 *    at nothing" reading as "found nothing" is the precise failure that lets
 *    this class of red recur, and the gate itself refuses to conflate them
 *    (exit 3 / INCOMPLETE); so does this module.
 * 2. NEVER THROW, ALWAYS CLEAN UP. Every path returns an outcome, and the
 *    throwaway worktree is removed in a `finally` that swallows its own
 *    failure. A gate bug must never wedge a build lane.
 * 3. NO EXCERPTS. A finding is {rule, file, line} and nothing else. The excerpt
 *    carries the very text being banned (up to and including owner PII), and it
 *    would travel into notes, PR bodies and stored state — mirrored forever.
 *    The fixer reads the file itself.
 * 4. ADVISORY, BOUNDED. This returns a verdict for the CALLER to act on; it
 *    blocks nothing on its own. The only loop is the fix loop, bounded at
 *    `LEAK_PREFLIGHT_MAX_FIX_ATTEMPTS` — at most 3 gate runs, then the caller
 *    proceeds with the findings named.
 * 5. NOTHING THE SCANNED CHECKOUT SUPPLIES IS EXECUTED, AND THE CREDENTIAL IS
 *    NOT IN SCOPE ANYWAY. See `ownLeakGateScript` and `GATE_SCRUBBED_ENV`.
 *
 * Every side effect goes through the injected `EnvCapableHostRunner`, so the
 * unit suite scripts the whole flow with no filesystem and no subprocess.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EnvCapableHostRunner, HostCommandResult } from './git-mode.ts'

/** At most 2 self-correction rounds — so at most 3 gate runs — then report. */
export const LEAK_PREFLIGHT_MAX_FIX_ATTEMPTS = 2

/**
 * Watchdog budget for ONE gate invocation.
 *
 * `spawnCapture`'s default is 60s (trident/git-mode.ts) and the gate takes ~100s
 * on this tree, so EVERY gate call must pass this explicitly or a production
 * preflight dies mid-scan and reports a timeout as a gate error.
 */
export const LEAK_GATE_TIMEOUT_MS = 15 * 60_000

/**
 * The environment variables the gate is run WITHOUT.
 *
 * ⚠️ THE FIRST CUT OF THIS RAN THE SCANNED CHECKOUT'S OWN COPY OF THE GATE, and the production
 * `run_host` is `makeLazyCredentialedHostRunner` (`open/composer.ts`), whose child environment
 * carries `GH_TOKEN` plus the `GIT_CONFIG_*` triple whose credential helper reads it back out
 * (`github/credential.ts` `githubProcessEnv`). So a branch could ship a `scripts/ci/leak-gate.sh`
 * — or, one layer down, the `extract-comment-prose.awk` that script `awk -f`s — and have it
 * EXECUTED on the publisher host with the owner's credential readable from its environment,
 * before the PR opened and before any reviewer saw the diff. Two independent controls now:
 * `ownLeakGateScript` decides WHAT runs, and this decides what is there to steal if some future
 * injection succeeds anyway — the same pairing `trident/orchestrator.ts`'s merge-driver docblock
 * arrived at after the same mistake twice.
 *
 * The gate needs none of it: every git read it makes is a local `git -C`.
 *
 * `GITHUB_ACTIONS` / `GITHUB_RUN_ID` / `GITHUB_EVENT_NAME` go for a second, non-security reason:
 * any one of them present flips the gate to its `canonical` secret context (`leak-gate.sh:170`),
 * where a missing `LEAK_GATE_PII_DENYLIST_B64` is a hard exit 2 rather than a skipped tier. A
 * stray one in the publisher's environment would make this preflight permanently inert.
 */
export const GATE_SCRUBBED_ENV = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GITHUB_ACTIONS',
  'GITHUB_RUN_ID',
  'GITHUB_EVENT_NAME',
]

/**
 * THIS INSTALLATION's copy of the gate — never the scanned checkout's.
 *
 * Walks up from this module rather than joining a fixed `..`, because trident is a workspace
 * package: depending on whether the resolver hands back the real path or the
 * `node_modules/@neutronai/trident` symlink, the tree root is one hop up or three. Exactly the
 * shape `ownAsBuiltMergeDriver` (`trident/orchestrator.ts`) uses, and for exactly the same reason.
 *
 * `null` means "no trusted gate in this installation", which the caller reports as a gate error
 * and proceeds — the safe direction. It NEVER falls back to the checkout's copy.
 *
 * WHAT CHANGES BY RUNNING OUR COPY OVER A FOREIGN TREE, stated rather than hand-waved: `HERE` is
 * ours, so the allowlist and the prose extractor are ours too, and `leak-gate.sh:283`
 * (`ALLOWLIST_OWNS_TREE`) already anticipates precisely this — pointed at a tree it does not live
 * in, the gate drops the `allowlist-stale` audit and keeps the rest. The one behavioural
 * difference left is that a NEW allowlist entry authored on the branch is not honoured here, so
 * its file can be flagged locally and pass in CI. That costs at most the bounded attempts, this
 * whole module is advisory, and CI remains the enforcement of record.
 */
export function ownLeakGateScript(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let hop = 0; hop < 8; hop++) {
    const candidate = join(dir, 'scripts', 'ci', 'leak-gate.sh')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * The two files a reword may NEVER touch, enforced here and not only asked for in the fixer's
 * prompt: the scanner and its allowlist. "Fix the text, never the scanner" is a property worth a
 * check, because a fixer that silences the gate instead of correcting the prose would produce a
 * green preflight and a red CI — the exact loop this module exists to close.
 */
const PROTECTED_PATHS = ['scripts/ci/leak-gate.sh', 'scripts/ci/leak-gate-allowlist.txt']

/**
 * One gate finding. Deliberately NO excerpt field — see invariant 3 above.
 * `file` may be the gate's pseudo-file `COMMIT-MESSAGE` or `PR-TITLE-BODY`.
 */
export interface LeakFinding {
  rule: string
  file: string
  line: number
}

export interface LeakPreflightOutcome {
  status: 'clean' | 'incomplete' | 'fixed' | 'findings-unresolved' | 'skipped-no-gate' | 'gate-error'
  /** The branch head the verdict describes — moves when the fixer commits. */
  head: string
  findings: LeakFinding[]
  /** Rule tiers the gate could not run (no local secret). Never "passing". */
  skipped_rules: string[]
  attempts: number
  note: string
}

/**
 * The self-correction seam. `fixed: true` means "I reworded the flagged text in
 * the worktree and `git add`ed it"; committing is this module's job. The real
 * agent-backed fixer is wired separately — this file only defines the seam.
 */
export type LeakPreflightFixer = (input: {
  worktree: string
  branch: string
  findings: LeakFinding[]
  attempt: number
}) => Promise<{ fixed: boolean; note?: string }>

/**
 * Parse `report_hits` output (scripts/ci/leak-gate.sh:313): two spaces, then
 * `[rule] file:line:excerpt`.
 *
 * The LAZY `(.+?)` is load-bearing: an excerpt of scanned source routinely
 * contains its own `:NN:`, and a greedy match would swallow it and mis-split
 * file from line. The excerpt is dropped AT THIS BOUNDARY and never captured.
 * The truncation line `  [rule] … and N more` carries no `:digits:` and so
 * cannot parse as a finding.
 */
export function parseLeakGateOutput(out: string): { findings: LeakFinding[]; skipped_rules: string[] } {
  const findings: LeakFinding[] = []
  for (const raw of out.split('\n')) {
    const m = /^ {2}\[([a-z0-9-]+)\] (.+?):(\d+):/.exec(raw)
    if (m === null) continue
    const [, rule, file, line] = m
    if (rule === undefined || file === undefined || line === undefined) continue
    findings.push({ rule, file, line: Number(line) })
  }
  const skipped = /RULES THAT COULD NOT RUN:\s*(.+)/.exec(out)
  const skipped_rules =
    skipped?.[1] === undefined
      ? []
      : skipped[1]
          .trim()
          .split(', ')
          .map((r) => r.trim())
          .filter((r) => r !== '')
  return { findings, skipped_rules }
}

/**
 * Classify one gate run by exit code AND verdict sentinel — both required.
 * Anything else, including an `ok` run that printed no verdict at all, is an
 * error. See invariant 1.
 */
export function classifyLeakGateRun(res: HostCommandResult): 'clean' | 'incomplete' | 'findings' | 'error' {
  const out = res.stdout
  if (res.exit_code === 0 && out.includes('LEAK GATE: SILENT')) return 'clean'
  if (res.exit_code === 3 && out.includes('LEAK GATE: INCOMPLETE')) return 'incomplete'
  if (res.exit_code === 1 && out.includes('LEAK GATE: FAIL')) return 'findings'
  return 'error'
}

/** ~200 chars of whatever the failing call said, for a human-readable note. */
function tail(res: HostCommandResult): string {
  const text = res.stderr.trim() === '' ? res.stdout.trim() : res.stderr.trim()
  return text.slice(-200)
}

export async function runLeakGatePreflight(input: {
  run_host: EnvCapableHostRunner
  repo_path: string
  branch: string
  head: string
  base_sha: string
  scratch_dir: string
  fixer?: LeakPreflightFixer
  max_fix_attempts?: number
  /** The TRUSTED gate to run. Defaults to `ownLeakGateScript()`; never the checkout's copy. */
  gate_script?: string
}): Promise<LeakPreflightOutcome> {
  const { run_host, repo_path, branch, base_sha, scratch_dir } = input
  const maxFixAttempts = input.max_fix_attempts ?? LEAK_PREFLIGHT_MAX_FIX_ATTEMPTS
  let current = input.head
  let attempts = 0
  let worktreeAdded = false

  const gateError = (note: string): LeakPreflightOutcome => ({
    status: 'gate-error',
    head: current,
    findings: [],
    skipped_rules: [],
    attempts,
    note,
  })

  try {
    // (a) No gate in this repo is not a failure — it is simply nothing to do.
    const present = await run_host(['test', '-f', `${repo_path}/scripts/ci/leak-gate.sh`], repo_path)
    if (!present.ok)
      return {
        status: 'skipped-no-gate',
        head: current,
        findings: [],
        skipped_rules: [],
        attempts: 0,
        note: 'leak preflight skipped: no scripts/ci/leak-gate.sh in this repo',
      }

    // (a2) …and the gate we RUN is this installation's, resolved off this module. The probe above
    // reads the target repo to learn whether it opted into the gate at all; it never selects what
    // executes. No trusted copy → gate error, and the publish proceeds.
    const gate = input.gate_script ?? ownLeakGateScript()
    if (gate === null) return gateError('leak preflight: no trusted gate script in this installation')

    // (b) Scan a THROWAWAY detached worktree of the head, never a live checkout.
    // A prune first: the scratch path is per-publish, but the `finally` removal below deliberately
    // swallows its own failure, so a registration left behind by an earlier round would otherwise
    // make `worktree add` fail (git exits 128 on an existing path) and every later round inert.
    await run_host(['git', '-C', repo_path, 'worktree', 'prune'], repo_path)
    const added = await run_host(
      ['git', '-C', repo_path, 'worktree', 'add', '--detach', '--force', scratch_dir, current],
      repo_path,
    )
    if (!added.ok) return gateError(`leak preflight: could not provision a scan worktree: ${tail(added)}`)
    worktreeAdded = true

    for (;;) {
      // Run THIS INSTALL's gate over the scanned tree, with the credential taken out of the
      // environment — see `ownLeakGateScript` and `GATE_SCRUBBED_ENV` for why both.
      // `LEAK_GATE_BASE_SHA` pins the commit-message scan window to exactly this branch's commits;
      // without a real sha the gate falls back to origin/main, which is the right default. The
      // 40-or-64 hex shape accepts a sha256 object id, so an object-format change unpins nothing.
      const extraEnv = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(base_sha)
        ? { LEAK_GATE_BASE_SHA: base_sha }
        : undefined
      // An absolute `env`, not a bare one, so the lookup does not depend on a PATH at all; the
      // bare name is a fallback rather than a guess, and a host with neither fails loudly (the
      // spawn errors) instead of running the gate with the credential still in scope.
      const envBin = existsSync('/usr/bin/env') ? '/usr/bin/env' : 'env'
      const res = await run_host(
        [
          envBin,
          ...GATE_SCRUBBED_ENV.flatMap((name) => ['-u', name]),
          'bash',
          gate,
          '--tree',
          scratch_dir,
        ],
        scratch_dir,
        extraEnv,
        LEAK_GATE_TIMEOUT_MS,
      )

      const verdict = classifyLeakGateRun(res)

      if (verdict === 'clean')
        return {
          status: attempts > 0 ? 'fixed' : 'clean',
          head: current,
          findings: [],
          skipped_rules: [],
          attempts,
          note:
            attempts > 0
              ? `leak preflight: silent after ${attempts} self-correction attempt(s)`
              : 'leak preflight: silent',
        }

      if (verdict === 'incomplete') {
        // A tier that could not run must NEVER read as passing — and `fixed` is a passing word.
        // A successful reword does not make an unrun tier run, so a fix that lands under a
        // skipped tier is still `incomplete`; the attempt count carries the rest of the story.
        const { skipped_rules } = parseLeakGateOutput(res.stdout)
        return {
          status: 'incomplete',
          head: current,
          findings: [],
          skipped_rules,
          attempts,
          note: `leak preflight: 0 findings from the rules that ran${attempts > 0 ? ` after ${attempts} self-correction attempt(s)` : ''}; SKIPPED (no local secret): ${skipped_rules.join(', ')}`,
        }
      }

      if (verdict === 'error')
        return gateError(`leak preflight: gate returned no usable verdict (exit ${res.exit_code}): ${tail(res)}`)

      const parsed = parseLeakGateOutput(res.stdout)
      // A FAIL verdict whose findings we cannot read is malformed output, and
      // malformed output must not silently pass.
      if (parsed.findings.length === 0)
        return gateError('leak preflight: gate reported findings but none could be parsed from its output')

      // THE SCAN TREE'S OWN GIT POINTER IS NOT A COMMITTED BYTE. `git worktree
      // add` writes a `.git` FILE at the scratch root whose single line is
      // `gitdir: <absolute path on this host>`; the gate's file walk skips the
      // `.git` DIRECTORY (`./.git/*`) but nothing skips that FILE, so the
      // absolute path it must contain is reported as a finding on every run
      // here — while CI, whose checkout has a real `.git` directory, never sees
      // it. Left in, it would be an UNFIXABLE finding on a file no commit
      // contains: the fixer cannot reword it, both attempts burn on it, and
      // every PR gets annotated with it. Drop it, and only it, by exact path.
      const findings = parsed.findings.filter((f) => f.file !== '.git')
      const { skipped_rules } = parsed
      if (findings.length === 0) {
        // Everything the gate objected to was that pointer: the tree itself is
        // as silent as the rules that RAN can say — and a tier that could not
        // run still never reads as clean.
        const silent = skipped_rules.length === 0
        return {
          status: silent ? (attempts > 0 ? 'fixed' : 'clean') : 'incomplete',
          head: current,
          findings: [],
          skipped_rules,
          attempts,
          note: silent
            ? `leak preflight: silent (the scan tree pointer file is not part of the branch)${attempts > 0 ? ` after ${attempts} self-correction attempt(s)` : ''}`
            : `leak preflight: 0 findings from the rules that ran${attempts > 0 ? ` after ${attempts} self-correction attempt(s)` : ''}; SKIPPED (no local secret): ${skipped_rules.join(', ')}`,
        }
      }

      const unresolved = (extra: string): LeakPreflightOutcome => ({
        status: 'findings-unresolved',
        head: current,
        findings,
        skipped_rules,
        attempts,
        note: `leak preflight: ${findings.length} finding(s) not self-corrected after ${attempts} attempt(s)${extra}`,
      })

      if (input.fixer === undefined || attempts >= maxFixAttempts) return unresolved('')

      attempts += 1
      const fix = await input.fixer({ worktree: scratch_dir, branch, findings, attempt: attempts })
      if (!fix.fixed) return unresolved(fix.note === undefined ? '' : `; ${fix.note}`)

      // THE FIXER'S WORD IS NOT THE EVIDENCE — the INDEX IS, and it is audited, not merely
      // counted. The prompt asks for an in-place reword of the flagged files and forbids deleting
      // anything or touching the scanner; a prompt is not a control. An agent that deleted the
      // flagged plan doc, or that edited `leak-gate.sh` until it stopped objecting, would satisfy
      // "something is staged" and produce a green preflight over a tree nobody wanted. So:
      //   • nothing staged            → the claim is empty (and would loop an identical gate run);
      //   • any status but M          → a delete/add/rename is not a reword;
      //   • a path the gate did not flag → out of scope for this turn;
      //   • the scanner or allowlist  → refused even when the gate flagged it (fix the text).
      // Every rejection is `findings-unresolved`, so the PR opens with the findings named — the
      // bad fix simply never becomes a commit.
      const staged = await run_host(
        ['git', '-C', scratch_dir, 'diff', '--cached', '--name-status'],
        scratch_dir,
      )
      if (!staged.ok) return unresolved('; the staged fix could not be read')
      const stagedLines = staged.stdout.split('\n').filter((l) => l.trim() !== '')
      if (stagedLines.length === 0) return unresolved('; fixer reported fixed but staged nothing')
      const flagged = new Set(findings.map((f) => f.file))
      let refusal: string | null = null
      for (const line of stagedLines) {
        const parts = line.split('\t')
        const status = parts[0] ?? ''
        // Rename/copy lines carry `<old>\t<new>`; either way the LAST field is the live path.
        const path = parts[parts.length - 1] ?? ''
        if (PROTECTED_PATHS.includes(path)) {
          refusal = '; the fixer staged a change to the scanner itself'
          break
        }
        if (status !== 'M') {
          refusal = '; the fixer staged something other than an in-place reword'
          break
        }
        if (!flagged.has(path)) {
          refusal = '; the fixer staged a file the gate did not flag'
          break
        }
      }
      if (refusal !== null) return unresolved(refusal)

      // The message deliberately quotes no rule and no excerpt: commit messages
      // are mirrored forever and are themselves scanned by the gate.
      const committed = await run_host(
        [
          'git',
          '-C',
          scratch_dir,
          '-c',
          'user.name=trident',
          '-c',
          'user.email=trident@neutron.local',
          'commit',
          '-m',
          'reword text flagged by the purity preflight',
        ],
        scratch_dir,
      )
      if (!committed.ok) return gateError(`leak preflight: could not commit the fix: ${tail(committed)}`)

      const revparse = await run_host(['git', '-C', scratch_dir, 'rev-parse', 'HEAD'], scratch_dir)
      if (!revparse.ok) return gateError(`leak preflight: could not read the fixed head: ${tail(revparse)}`)
      const newHead = revparse.stdout.trim()

      // COMPARE-AND-SWAP. The old value is required: if the branch moved
      // underneath us, this fails rather than clobbering someone else's commit.
      const swapped = await run_host(
        ['git', '-C', repo_path, 'update-ref', `refs/heads/${branch}`, newHead, current],
        repo_path,
      )
      if (!swapped.ok)
        return gateError(`leak preflight: the branch moved underneath the preflight: ${tail(swapped)}`)
      current = newHead
    }
  } catch (err) {
    return gateError(`leak preflight: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (worktreeAdded) {
      // Best effort, and its own failure is swallowed: cleanup must never be the
      // reason a lane sees an exception.
      try {
        await run_host(['git', '-C', repo_path, 'worktree', 'remove', '--force', scratch_dir], repo_path)
      } catch {
        /* the scratch worktree is disposable; a stuck removal is not a verdict */
      }
    }
  }
}
