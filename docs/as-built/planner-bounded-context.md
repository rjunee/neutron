## 2026-10-09 — Keep continuation planning context reachable

The live efficiency audit in #1196 found planner tool responses large enough
for the native client to persist them outside the restricted planner's worktree.
Its saved-output paths were therefore unusable. The host selected continuation
planning correctly, but sent the complete prior execution specification and diff
alongside the small owned task ledger. Whole-file reads had the same problem.

`runtime/workers/planner-work.ts:211` replaces the bulk brief response with a
manifest. `read` selects either a scoped worktree file or the admitted host's
brief, context or measured state, including individual JSON fields. Pagination
preserves exact content and uses UTF-16 offsets with a matching source digest
for continuation. `:94` budgets both JSON encodings used by the native bridge,
leaving room for its envelope and keeping surrogate pairs intact. `:232` adds
bounded literal search within the existing file scope. State describes the diff
and preparation separately; their full values remain readable. Publication at
`:292` still measures and stores the complete head, diff and preparation.

The existing role, native tool grant, capability, admission, census, retirement,
file confinement, diagnostics and result validation remain authoritative. This
change adds no shell execution or access to native saved-output paths. The
spawned tool manifest describes the new operations; an already running native
parent must be observed using the new manifest before deployment acceptance.

The real native response formatter measured the unchanged synthetic continuation
at 298,650 bytes. Both new regressions failed before implementation: the response
exceeded the 16 KiB ceiling and host-resource reads were unsupported. Corrected
focused tests pass 17 cases, including exact instruction and ledger retrieval,
Unicode/control-character reconstruction, source-change refusal, literal search,
retirement and preservation of the full published diff. Semantic mutations that
remove the output bound, accept changed digests, or refuse legitimate pages each
fail their opposing regression; original source bytes were restored afterward.

Planner, native profile and startup regression coverage passes 76 tests. The
real HTTP/native bridge passes 16 tests, including complete reconstruction of a
36,000-character brief and a targeted owned-ledger read with every response below
16 KiB. Its real spawn-manifest assertion checks the new schema. The prepared
Open build consumer passes through planning, preserved builder validation and
governed merge (one test, 19 assertions). An initial consumer assertion assumed a
word in the existing brief and failed; the corrected check compares the returned
instructions with the actual owned brief. A manifest check initially inspected
the registry-only endpoint and failed; it now reads the actual spawned manifest.
Runtime, Open, root and Trident typechecks pass. Lint and diff checking pass.
The seven changed/new files, plus an unchanged tracked control, pass the
configured privacy gate. This scoped scan does not replace full-tree CI purity.

The first full shared-host gate ran on source
`692f7a08a3aa0000a0392bf2b86ada15306c0dca`, from 19:48:03 through 20:22:59 UTC.
Lint and all 51 TypeScript projects passed, and all 1,806 discovered files ran.
One of 19 lanes failed: two boot-recovery cases still expected the former bulk
brief. The other lanes passed and the suite-input identity stayed unchanged.
`open/wiring/__tests__/claude-native-dispatch-boot.test.ts:317` now checks the
manifest and retrieves the actual brief through its admitted resource, preserving
the census, sibling ownership and historical-evidence assertions. The corrected
boot-recovery, bounded planner-output and review-gate checks pass 189 tests across
four files on the combined source.

The combined `bash scripts/check-shared-host.sh` ran at source
`3de9db95cb1ac10be5b16c36aef14f44b0d24d7a` from 20:27:16 through 21:01:03 UTC.
Lint and all 51 TypeScript projects passed; all 1,806 discovered files executed.
Eighteen of 19 lanes passed. The only failure was the inventory citation guard:
the new G072 row omitted test-citation line numbers. Those citations are now
corrected to the actual enforcement and regression lines. The unchanged guard
passes both tests with 1,524 assertions. Only that documentation row and this
change's two new records changed after the full run; runtime code, test code and
runner configuration were not edited. This records a failed full run followed by its
affected guard passing, not a second full-suite pass. Exact publication-head CI
remains required before merge.

The two continuation corrections share one source delivery. Publication, scoped
deployment and live before/after token measurements remain pending. These fixture
results establish usable bounded output, not measured production token savings
or completion of #1196. Scheduling merged separately in #1480.
