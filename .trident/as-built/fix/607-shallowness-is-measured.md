## 2026-09-14 — Measure shallowness before fetching or computing a base

### Change and acceptance evidence

Issue #607. Missing commits in complete clones now use a plain fetch; depth 1 is
reserved for a measured shallow checkout (`scripts/ci/as-built-write-guard.sh:112`).
The production base computation here is Git's three-dot diff at
`scripts/ci/as-built-write-guard.sh:152`. Its prerequisite now measures history,
deepens if shallow, and verifies completeness before permitting the diff
(`scripts/ci/as-built-write-guard.sh:127`, `scripts/ci/as-built-write-guard.sh:150`).
A successful fetch that leaves grafts cannot authorize that diff
(`scripts/ci/as-built-write-guard.sh:133`).

The real Git fixture constructs R→A→C, A→B, R→S and merge M with parents B,S
(`scripts/ci/git-history.test.ts:35`). Its full-history base for C/M is A; fetching
B at depth 1 makes Git successfully return R, a wrong but valid commit
(`scripts/ci/git-history.test.ts:82`, `scripts/ci/git-history.test.ts:86`). Running
the guard in a linked worktree restores completeness and the exact answer A
(`scripts/ci/git-history.test.ts:87`). The protected log differs between R and A,
so choosing R also changes the real guard verdict, not only a helper's return.

Acceptance checks are executable in `scripts/ci/git-history.test.ts`:

- Missing-base full clone stays complete, retains exactly three main commits,
  and issues exactly one plain fetch (`scripts/ci/git-history.test.ts:56`).
- Grafted linked worktree returns R before and A after the guard
  (`scripts/ci/git-history.test.ts:76`).
- A successful ineffective fetch refuses before diff (`scripts/ci/git-history.test.ts:94`).
- Genuine shallow clone uses depth **1**, then unshallow, then fallback deepen
  **200** when unshallow fails (`scripts/ci/git-history.test.ts:109`).
- Each sibling has shallow and complete linked cases, exact fetch arguments and
  counts **1**/**3**, and a failed diagnostic re-probe (`scripts/ci/git-history.test.ts:128`).
- Failed, malformed and failed-but-printing-false probes refuse; UNKNOWN does
  not become SHALLOW (`scripts/ci/git-history.test.ts:170`, `scripts/ci/git-history.test.ts:190`).

### Decisions and outcome vocabulary

Use one sourced probe (`scripts/ci/git-history.sh:4`) rather than copy the
siblings' partial pattern. It accepts only successful literal true/false answers.
UNKNOWN returns **2**, joining the guards' existing cannot-evaluate outcome;
0 means clean/skip and 1 means a violation (`scripts/ci/as-built-write-guard.sh:31`,
`scripts/ci/composition-field-ratchet-guard.sh:27`,
`scripts/ci/route-slot-ratchet-guard.sh:27`,
`scripts/ci/depcruise-ratchet-guard.sh:32`). Callers must stop evaluation on 2,
restore access to Git/history, and rerun. The existing CI invocation propagates
nonzero exits by default (`scripts/ci/check-governed-repo-attributes.ts:106`).

Each invocation remeasures before depth-bearing fetches; the diff prerequisite
also remeasures after deepening. This mechanism does not rely on the fetching
command honestly reporting that it repaired history. The executable regression
and mutation controls maintain that boundary. This does not serialize unrelated
concurrent Git writers or guarantee a corrupted object database is healthy.

Keep the existing 200 fallback, but require completeness afterwards: a bounded
deepen that still leaves grafts cannot justify a plausible merge base. No change
to product decisions in SPEC.md was needed. The explicitly requested build-lane
staging location for this record takes precedence over the normal direct-shard
location described in docs/process/work-tracking.md §4.

### Shallowness audit

Enumerated non-test source using `rg -n 'is-shallow-repository|/shallow|git-path.*shallow'`
with documentation and test files excluded. The positive control is the real
probe at `scripts/ci/git-history.sh:6`. In this working tree, decision sites found:

| Site | Method and disposition |
| --- | --- |
| `scripts/ci/as-built-write-guard.sh:112` and `:129`, `:133` | Shared Git probe; unknown refuses; completeness required before diff. |
| `scripts/ci/composition-field-ratchet-guard.sh:70` and `:97` | Shared Git probe for fetch and diagnostic. |
| `scripts/ci/depcruise-ratchet-guard.sh:68` and `:94` | Shared Git probe for fetch and diagnostic. |
| `scripts/ci/route-slot-ratchet-guard.sh:69` and `:97` | Shared Git probe for fetch and diagnostic. |
| `install.sh:1394` | Git probe; failed probe falls through. Outside this change. |
| `trident/orchestrator.ts:1493` | Git probe, explicit unknown; fetch success is trusted at `:1503`. Outside this change. |
| `trident/orchestrator.ts:4273` | Git probe with explicit yes/no/unknown at `:4277`. Outside this change. |
| `trident/merge.ts:1037` | Git probe in fallback after the first base assessment at `:1063`. Explicitly excluded from edits. |

`trident/orchestrator.ts:1512` reads the shallow path only for diagnostic detail.
The former file-existence probes in the four scoped scripts were replaced. A
whole-tree content search for the old diagnostic phrase together with its new
wording found the three new messages at composition-field:99, depcruise:96 and
route-slot:99; these new messages are the positive control. This is a working-tree
content audit, not a claim about a freshly fetched remote ref; network was not used.

### Mutation evidence

Every row ran the focused test against the mutation and again after restoration.
The mutation runner printed the actual changed line before running it. All 31
mutations were RED and all restores GREEN. One initial attempt at ignoring the
post-fetch probe failure still refused through the later completeness check; the
fixture reached that line, but exit 2 alone could not distinguish UNKNOWN from a
false SHALLOW classification. The test now asserts both the refusal and the
absence of that false classification (`scripts/ci/git-history.test.ts:182`).

| Guard | Landing line | Mutation | Mutated | Restored |
| --- | --- | --- | --- | --- |
| full clone depth guard removed | `scripts/ci/as-built-write-guard.sh:113` | `if true; then` | RED | GREEN |
| shallow fetch arm disabled | `scripts/ci/as-built-write-guard.sh:113` | `if false; then` | RED | GREEN |
| depth constant changed | `scripts/ci/as-built-write-guard.sh:114` | `--depth=2` | RED | GREEN |
| deepen constant changed | `scripts/ci/as-built-write-guard.sh:132` | `--deepen=201` | RED | GREEN |
| linked probe reverted | `scripts/ci/as-built-write-guard.sh:130` | `[ -f "$(git -C "$ROOT" rev-parse --git-dir)/shallow" ] \|\| return 0` | RED | GREEN |
| complete clone deepened | `scripts/ci/as-built-write-guard.sh:130` | `:` | RED | GREEN |
| post-fetch completeness disabled | `scripts/ci/as-built-write-guard.sh:134` | `if false; then` | RED | GREEN |
| history refusal ignored | `scripts/ci/as-built-write-guard.sh:150` | `ensure_history` | RED | GREEN |
| missing commit probe refusal ignored | `scripts/ci/as-built-write-guard.sh:112` | `shallow="$(read_shallowness)"` | RED | GREEN |
| history probe refusal ignored | `scripts/ci/as-built-write-guard.sh:129` | `shallow="$(read_shallowness)"` | RED | GREEN |
| post-fetch probe refusal ignored | `scripts/ci/as-built-write-guard.sh:133` | `shallow="$(read_shallowness)"` | RED | GREEN |
| failed probe accepted | `scripts/ci/git-history.sh:8` | `return 0` | RED | GREEN |
| malformed probe accepted | `scripts/ci/git-history.sh:12` | `return 0` | RED | GREEN |
| composition-field pre-fetch unknown ignored | `scripts/ci/composition-field-ratchet-guard.sh:70` | `shallow="$(read_shallowness)"` | RED | GREEN |
| composition-field diagnostic unknown ignored | `scripts/ci/composition-field-ratchet-guard.sh:97` | `shallow="$(read_shallowness)"` | RED | GREEN |
| composition-field linked diagnostic reverted | `scripts/ci/composition-field-ratchet-guard.sh:98` | `if [ -f "$(git -C "$ROOT" rev-parse --absolute-git-dir)/shallow" ]; then` | RED | GREEN |
| depcruise pre-fetch unknown ignored | `scripts/ci/depcruise-ratchet-guard.sh:68` | `shallow="$(read_shallowness)"` | RED | GREEN |
| depcruise diagnostic unknown ignored | `scripts/ci/depcruise-ratchet-guard.sh:94` | `shallow="$(read_shallowness)"` | RED | GREEN |
| depcruise linked diagnostic reverted | `scripts/ci/depcruise-ratchet-guard.sh:95` | `if [ -f "$(git -C "$ROOT" rev-parse --absolute-git-dir)/shallow" ]; then` | RED | GREEN |
| route-slot pre-fetch unknown ignored | `scripts/ci/route-slot-ratchet-guard.sh:69` | `shallow="$(read_shallowness)"` | RED | GREEN |
| route-slot diagnostic unknown ignored | `scripts/ci/route-slot-ratchet-guard.sh:97` | `shallow="$(read_shallowness)"` | RED | GREEN |
| route-slot linked diagnostic reverted | `scripts/ci/route-slot-ratchet-guard.sh:98` | `if [ -f "$(git -C "$ROOT" rev-parse --absolute-git-dir)/shallow" ]; then` | RED | GREEN |
| composition-field full clone depth guard disabled | `scripts/ci/composition-field-ratchet-guard.sh:72` | `if true; then` | RED | GREEN |
| composition-field shallow fetch arm disabled | `scripts/ci/composition-field-ratchet-guard.sh:72` | `if false; then` | RED | GREEN |
| composition-field depth constant changed | `scripts/ci/composition-field-ratchet-guard.sh:73` | `--depth=2 origin main` | RED | GREEN |
| depcruise full clone depth guard disabled | `scripts/ci/depcruise-ratchet-guard.sh:70` | `if true; then` | RED | GREEN |
| depcruise shallow fetch arm disabled | `scripts/ci/depcruise-ratchet-guard.sh:70` | `if false; then` | RED | GREEN |
| depcruise depth constant changed | `scripts/ci/depcruise-ratchet-guard.sh:71` | `--depth=2 origin main` | RED | GREEN |
| route-slot full clone depth guard disabled | `scripts/ci/route-slot-ratchet-guard.sh:71` | `if true; then` | RED | GREEN |
| route-slot shallow fetch arm disabled | `scripts/ci/route-slot-ratchet-guard.sh:71` | `if false; then` | RED | GREEN |
| route-slot depth constant changed | `scripts/ci/route-slot-ratchet-guard.sh:72` | `--depth=2 origin main` | RED | GREEN |

### Validation and deliberate limits

Scoped tests: `bun test scripts/ci/git-history.test.ts scripts/ci/as-built-write-guard.test.ts scripts/ci/composition-field-ratchet-guard.test.ts scripts/ci/depcruise-ratchet-guard.test.ts scripts/ci/route-slot-ratchet-guard.test.ts`.

Lint: `bash scripts/ci/lint.sh` passed. Typecheck uses the repository's
`bash scripts/ci/typecheck-all.sh` (the script map at `package.json:57` provides start/test/migrate commands).
All **51** tsconfig checks passed. The five scoped test files passed: **76 tests**,
**285 assertions**. Shell syntax checks and the final test-file ESLint check passed.

No deletion of shallow metadata, no feature flags, no alternate implementation,
no changes to trident/merge.ts or trident/codex-review.sh. The three-dot production
base in this issue is guarded; broader ancestry consumers such as
`trident/review-run.ts:488` were inspected but deliberately left outside this
shell-guard fix. No attempt to repair every existing graft or to lock all Git
writers. An unhealed checkout refuses instead. No network access, push, PR or merge.

Leak gate: `bash scripts/ci/leak-gate.sh --tree .` reported **INCOMPLETE**: zero
findings among executed rules, but the private PII denylist and message denylist
rules could not run. This is not claimed as a clean leak-gate result.
