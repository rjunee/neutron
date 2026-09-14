## 2026-09-14 — Identity registry probes regex literal meaning (#625)

### Change and evidence

The registry previously matched raw regex source and its prefilter skipped a
character-class-only source. `/NEUTRON[_]HOME/` therefore matched the name at
runtime while remaining invisible. The regression fixtures now prove this
raw/compiled distinction for all four names, preserve ordinary literals and
legitimate nonmatches, and exercise the readers/unregistered/stale transition
(tests/integration/identity-env-readers-registry.test.ts:1241 and :1260).

The four names now supply both the raw word-boundary patterns and compiled
candidate probes (:185). The helper compiles literal bodies with their flags,
resets matching state for each candidate, retains raw references such as
placeholders, and conservatively reports compilation failures (:578). Slash
admission prevents the prefilter from dropping regex-only sources (:663), and
the AST regex branch uses the helper (:728).

### Findings and decisions

The first corrected tree run exposed 83 additional unregistered files. These
were enumerated from the failure array and every regex AST node in those files
was tested against all four candidates. Each finding was reported before edits.
The registry now records each file with a source-line citation to a broad
matching literal (:241). These annotations assert a regex match, not env access
or trimming correctness. No predicate was changed to silence the findings.

Compiled probing uses the runtime's regex semantics without executing source
programs. Broad patterns intentionally cost registry rows. Compilation failure
joins the existing boolean reader classification (:588); by default a new file
then fails the existing unregistered check (:873-880). The tracked-source scan
and exact registry comparison run in the integration suite independently of
application readers (:825), continuously maintaining the file membership rule.
CI invokes the test runner at .github/workflows/ci.yml:437.

Candidate probing does not synthesize surrounding context or compute dynamic
patterns. The prefixed hidden-name miss remains explicitly pinned (:1296).
Computed keys, concatenation, and split JSX remain outside the single-node walk.
The current scope is documented in config/index.ts:573-581. A whole-tree search
for `REGEX whose|regex.*\.text|five are pinned|no single.*node|exactly TWO ways|no backslash, no entity`
matched positive controls in the suite and the historical docs/AS_BUILT.md:3089;
the latter is frozen and intentionally unchanged.

### Mutation proof

Each mutation printed its actual landing line, ran the two regression tests,
and was individually restored to two passing tests. Lines below identify the
final formatted source in tests/integration/identity-env-readers-registry.test.ts.

| Guard | Mutation | Red | Restored |
| --- | --- | --- | --- |
| Regex dispatch :729 | Restore raw-only matcher | 2 failures, exit 1 | 2 pass, exit 0 |
| Prefilter :665 | Remove slash admission | 2 failures, exit 1 | 2 pass, exit 0 |
| Candidate match :585 | Return true for every pattern | 2 failures, exit 1 | 2 pass, exit 0 |
| Raw-reference leg :579 | Disable raw match | 1 failure, exit 1 | 2 pass, exit 0 |
| Compile failure :588 | Return false | 1 failure, exit 1 | 2 pass, exit 0 |

Mutation landing lines before final formatting were respectively 726, 663, 584,
578, and 587. The raw-only mutation isolates semantic detection while keeping
the repaired prefilter reachable; the separate prefilter mutation proves that
second obligation. The over-rejection mutation fails legitimate nonmatches.

### Validation and scope

- Affected suite: 21 pass, 0 fail, 90 assertions.
- `bash scripts/ci/lint.sh`: pass.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations pass.
- `git diff --check` and added-text/single-heading checks: pass.
- Full-tree leak gate: exit 1 on local `.git:1` worktree metadata; the
  private denylist was also unavailable, so its PII rules could not run.
  The metadata is outside the proposed diff.
- No whole test suite was run.

No product decision changed, and no application behavior, per-reader trimming
predicate, computed-expression analysis, or registry granularity was changed.
The file-level guard still cannot detect an additional read in a registered file.
