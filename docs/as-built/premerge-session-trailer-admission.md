## 2026-09-23 — Independently check commit messages at merge admission

The remaining merge-boundary scope from PR #1171 is implemented using the
existing G166 scanner. Local merge now checks the reviewed history before
`mergeLocalReviewed` (`trident/production-host-effects.ts:523`); PR merge checks
after pinned readiness has fetched and witnessed the reviewed head, before any
draft-ready write (`:539`). Ownership, draft transitions, CI and the final pinned
merge remain in place. This adds admission, not message rewriting or a change
to G100 preservation or the advisory leak preflight.

`trident/gates/release-readiness.ts:192` shares the existing authenticated
raw-object scan and origin-observed public-base window. Publication calls that
wrapper once, preserving its existing behavior. The independent merge call
recomputes the same window: a carrier on an already-public base above the launch
pin is excluded under the existing ancestry rules, while a branch-owned carrier
beneath a clean tip blocks. Failed or incomplete raw evidence remains unknown.

Real-Git controls in `trident/production-host-effects.test.ts:545` cover both
merge modes, a public-base carrier, a branch-owned ancestor carrier beneath a
clean tip, harmless body mentions and coauthors. The six controls at `:588`
refuse failed, truncated and throwing raw reads after successful publication.
The consuming Open composition tests at
`open/__tests__/project-build-e2e.test.ts:1010` seed local history or an already
published, owned draft and invoke the real host's merge effect directly. This
is deliberately independent of publication: a working pre-push guard cannot
satisfy these controls. They verify the actual base contents or unchanged base,
and the PR's merged state or unchanged open draft.

Paired semantic mutations were run and restored. Bypassing only the pre-merge
refusal made all four carrier controls fail, including both consuming cases
actually merging. Scanning from the full launch pin instead of using the public
window made all four clean sibling controls fail on the already-public carrier.
The restored focused suites passed 284 tests across production host effects,
release readiness, build host, publication session trailers and the spec index.
Root, Open and Trident TypeScript checks and targeted ESLint passed.
The complete consuming E2E suite passed all 213 tests with Unix-socket access
enabled. Its initial sandboxed run passed 204 tests and failed nine socket-based
fixtures because binding their local broker sockets was denied; the four new
consuming cases passed in both environments.

The optional full-tree leak check did not pass with the local denylist: the exact
base archive measured 455 findings (167 substring and 288 word matches); this
worktree measured the same rule totals plus one finding in its untracked `.git`
pointer. The tree scanner excludes `.git/*` but includes that worktree metadata
file (`scripts/ci/leak-gate.sh:212`). No leak-gate behavior is changed here.

No deployment or live dispatch is claimed by this local candidate. The new
specification is `docs/spec-items/premerge-session-trailer-admission.md`.
