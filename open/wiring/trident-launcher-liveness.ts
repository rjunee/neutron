import { deriveReplSupervisionPaths } from '@neutronai/runtime/adapters/claude-code/index.ts'
import {
  probeLauncherGenerationAlive,
  type LauncherGenerationLiveness,
} from '@neutronai/runtime/adapters/claude-code/persistent/supervision.ts'
import type { LauncherLiveness, TridentLivenessProbe } from '@neutronai/trident/tick.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'

/**
 * The runtime layer may not import trident, so `LauncherGenerationLiveness`
 * (`persistent/supervision.ts`) and `LauncherLiveness` (`trident/tick.ts`) are two
 * declarations of one union. THIS seam is where they meet, so this is where the
 * identity is checked: both assignments must hold, which fails to compile the
 * moment either side gains or loses a member. Without it, adding a verdict on one
 * side would silently widen or narrow what trident's tick can be handed — and the
 * member added by #518 is precisely the one whose absence turns a deploy back into
 * a reported crash.
 */
const _runtimeVerdictIsTridentVerdict: LauncherLiveness = null as unknown as LauncherGenerationLiveness
const _tridentVerdictIsRuntimeVerdict: LauncherGenerationLiveness = null as unknown as LauncherLiveness
void _runtimeVerdictIsTridentVerdict
void _tridentVerdictIsRuntimeVerdict


/** The verdicts that positively establish DEATH. They disagree only about the cause. */
const DEAD_VERDICTS: ReadonlySet<LauncherLiveness> = new Set<LauncherLiveness>([
  'dead',
  'killed-by-gateway-shutdown',
  'dead-cause-undetermined',
])

/** QUESTION 1: does every home that could answer say the process is gone? */
function allDead(verdicts: ReadonlySet<LauncherLiveness>): boolean {
  return [...verdicts].every((v) => DEAD_VERDICTS.has(v))
}

/**
 * QUESTION 2: with death unanimous, what killed it?
 *
 * An attribution survives only when NOTHING CONTRADICTS IT. The table, and why each row
 * is what it is:
 *
 *   - one verdict          → that verdict. Nothing to reconcile.
 *   - killed + undetermined → KILLED. One home positively observed the kill; the other
 *                            failed to establish a cause. A NON-OBSERVATION NEVER
 *                            OVERRIDES AN OBSERVATION — the same rule that made the
 *                            shutdown persist what it observed instead of inferring it.
 *   - dead + undetermined   → UNDETERMINED. `dead` asserts "no shutdown accounts for
 *                            this", which is compatible with "the cause was not
 *                            established"; what is NOT available is the crash sentence
 *                            plain `dead` would make the tick compose, because one home
 *                            has evidence the cause is unestablished. The weaker claim
 *                            wins because it is the one both homes support.
 *   - dead + killed         → DISPUTED → undetermined, logged loudly. Both are POSITIVE
 *                            attributions and they contradict each other. Verified
 *                            rather than assumed: plain `dead` never arises from a
 *                            failed look — the pool branch answers it for a session that
 *                            by construction has not been through a shutdown
 *                            (`pool.ts` deletes the pool entry BEFORE writing the
 *                            record), and the registry branch answers it only when a
 *                            look for an entry naming this generation found none. So
 *                            this is a real conflict, not `dead-cause-undetermined`
 *                            wearing the wrong name, and it is NOT resolved by silently
 *                            preferring an arm. An earlier revision preferred the
 *                            attribution; this reports the death and records the
 *                            attribution as disputed, so an operator sees a
 *                            disagreement rather than a coin flip. `dead-cause-
 *                            undetermined` is exactly the right carrier: a disputed
 *                            cause IS an unestablished one.
 *
 * A generation lives in ONE instance's registry (per-spawn UUID), so the disputed row is
 * unreachable by construction today. It is resolved rather than asserted away because an
 * unreachability argument is not a reason to let a conflict launder itself into a
 * confident sentence if the arrangement ever changes.
 */
function mergeAttribution(
  verdicts: ReadonlySet<LauncherLiveness>,
  generationKey: string,
  log: (message: string) => void,
): LauncherLiveness {
  if (verdicts.size === 1) return [...verdicts][0]!
  const disputed = verdicts.has('dead') && verdicts.has('killed-by-gateway-shutdown')
  if (disputed) {
    log(
      `trident launcher liveness: homes DISAGREE about why generation ${generationKey.slice(0, 8)} died ` +
        `(one found no gateway-shutdown record, another found one) — reporting the death with the cause ` +
        `UNDETERMINED rather than choosing an arm`,
    )
    return 'dead-cause-undetermined'
  }
  // killed + undetermined: the observation stands.
  if (verdicts.has('killed-by-gateway-shutdown')) return 'killed-by-gateway-shutdown'
  // dead + undetermined: the claim both homes support.
  return 'dead-cause-undetermined'
}

export function buildTridentLauncherLivenessProbe(opts?: {
  probe?: (generationKey: string, replRegistryPath: string) => LauncherLiveness
  derive_registry_path?: (home: string) => string
  /** Where a merge disagreement is reported. Defaults to stderr. */
  log?: (message: string) => void
}): TridentLivenessProbe {
  const log = opts?.log ?? ((message: string) => process.stderr.write(`[trident] ${message}\n`))
  const probe = opts?.probe ?? probeLauncherGenerationAlive
  const deriveRegistryPath =
    opts?.derive_registry_path ?? ((home: string) => deriveReplSupervisionPaths(home).replRegistryPath)

  return async (run: TridentRun): Promise<LauncherLiveness> => {
    try {
      const key = run.workflow_run_id
      if (typeof key !== 'string' || key.length === 0) return 'unknown'

      // A fresh fire launches from repo_path; a continuation may launch from its
      // worktree. Generation UUIDs are per spawn, so either registry can answer
      // authoritatively without creating cross-registry false positives.
      const homes = [...new Set([run.worktree, run.repo_path])].filter(
        (home): home is string => typeof home === 'string' && home.length > 0,
      )
      const answers = homes.map((home) => probe(key, deriveRegistryPath(home)))
      const known = answers.filter((answer) => answer !== 'unknown')
      if (known.length === 0) return 'unknown'
      // TWO QUESTIONS ON ONE LATTICE WAS THE BUG. Merging them together is what made a
      // `dead` + `dead-cause-undetermined` pair fall through to `'unknown'` and strand a
      // build the probe had confirmed dead in BOTH homes — the stranding this item
      // exists to remove, arriving through the merge instead of the record. They are
      // resolved in order, explicitly, and each has its own rule.
      const distinct = new Set(known)

      // QUESTION 1 — IS IT DEAD? `dead`, `killed-by-gateway-shutdown` and
      // `dead-cause-undetermined` all answer YES; they differ only on WHY. So any set
      // drawn entirely from those three is unanimous death, and `'unknown'` here means
      // "a home could not tell whether it is alive" — NEVER "the homes disagreed about
      // why it died". A single `'alive'` forbids reaping: ambiguity is never permission.
      // The lattice in full, so no arm is reachable only by fallthrough:
      //   every answer dead-flavoured → death, and question 2 decides the cause;
      //   every answer 'alive'        → alive;
      //   mixed                       → 'unknown', a live process forbids reaping.
      if (allDead(distinct)) return mergeAttribution(distinct, key, log)
      if ([...distinct].every((v) => v === 'alive')) return 'alive'
      return 'unknown'
    } catch {
      // A probe outage or unreadable registry is ambiguity, never death evidence.
      return 'unknown'
    }
  }
}
