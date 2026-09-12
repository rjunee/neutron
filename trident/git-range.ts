/**
 * THE ONE PLACE A GIT REV-RANGE ARGV IS BUILT (#546).
 *
 * ── WHY THIS EXISTS: THREE ROUNDS OF MEASURING WHAT COULD BE PREVENTED ─
 * A rev-range operand that reaches git without `--end-of-options` is an arbitrary-file-write
 * primitive. Measured on git 2.43: with a base of `--output=<path>`, `git diff --name-only`
 * writes that file and EXITS 0, the grouped `--output` diff honours both outputs, and
 * `git rev-list --count` writes it while exiting 129.
 *
 * Every consumer carrying the marker was, for three rounds, a property asserted by a text
 * scanner over the tree — and that scanner was wrong three times, each in a different
 * mechanism:
 *
 *   1. it searched for one SPELLING of the operand (`${baseRef}..`), so
 *      `computeDiffLineCount`'s `base_ref` and `mutation-prover.ts`'s three-dot range were
 *      invisible, and the first of those shipped unshielded;
 *   2. it then attributed the marker by a TWELVE-LINE WINDOW, which read the round's own
 *      explanatory comments — the ones that say `--end-of-options` — as evidence, so every
 *      mutation passed;
 *   3. with comments blanked, it still examined only the FIRST range on each physical line.
 *
 * Three rounds spent making one instrument adequate is the signal that **the property is
 * being measured where it should be prevented**. So the argv is built here, the marker is
 * not a parameter, and there is no way to call this and omit it. What the scanner has left
 * to assert is one much simpler claim: nothing outside this module hands git a `..` operand,
 * except the shell wrappers and the prompt strings, which are enumerated because a TypeScript
 * helper cannot reach them.
 *
 * ── WHAT THE SHAPE GUARANTEES ─────────────────────────────────────────
 * `-c` settings precede the subcommand (git requires it); flags precede the marker (they
 * must, or git stops parsing them); the marker precedes the range operand (that is its whole
 * job); the `--` pathspec separator follows the operand. A caller supplies the parts and
 * cannot reorder them.
 *
 * It does NOT validate the base: that is `diffBaseRef`'s job, which refuses an empty,
 * whitespace-padded or option-shaped name at the binding. This is the second layer, and the
 * two are independent on purpose — the first round of this fix put a correct check in the
 * wrong place and routed the dangerous value to the unguarded branch.
 */

/** A two-dot range asks "what did the head add on top of the base"; three-dot uses the merge base. */
export type RangeDots = '..' | '...'

export interface GitRangeArgv {
  /** The repository the command runs in (`git -C`). */
  repo_path: string
  /** `-c key=value` settings, which git requires BEFORE the subcommand. */
  config?: readonly string[]
  /** `diff`, `log`, `rev-list` — the three families this repo ranges with. */
  subcommand: 'diff' | 'log' | 'rev-list'
  /** Options for the subcommand. They must precede the marker, and this puts them there. */
  flags?: readonly string[]
  /** The left-hand side: a sha or a FULLY QUALIFIED ref — `diffBaseRef`'s answer, which is
   *  the launch pin, `refs/remotes/origin/<base>` or `refs/heads/<base>`. Never a shorthand:
   *  `origin/main` and `main` are both names git resolves against every namespace, and a
   *  same-named tag answers to either. */
  base: string
  /** The right-hand side. */
  head: string
  /** `..` (default) or `...`. */
  dots?: RangeDots
  /** Pathspecs, rendered after the `--` separator. Omitted entirely when empty. */
  pathspec?: readonly string[]
}

/**
 * The argv for one git rev-range command, with `--end-of-options` in the only position that
 * works and no way to leave it out.
 *
 * The marker is deliberately NOT a parameter. That is the whole point of this module: an
 * unshielded range is unconstructible here, so the question "does every call site carry it"
 * stops being a property some scanner has to rediscover after each refactor.
 */
export function gitRangeArgv(spec: GitRangeArgv): string[] {
  return [
    'git',
    '-C',
    spec.repo_path,
    ...(spec.config ?? []),
    spec.subcommand,
    ...(spec.flags ?? []),
    // THE MARKER, between the last flag and the operand. Anywhere else is useless: before the
    // flags it stops git reading them, after the operand it is too late.
    '--end-of-options',
    `${spec.base}${spec.dots ?? '..'}${spec.head}`,
    ...(spec.pathspec === undefined || spec.pathspec.length === 0 ? [] : ['--', ...spec.pathspec]),
  ]
}
