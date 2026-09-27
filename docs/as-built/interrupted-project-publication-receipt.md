## 2026-09-26 — Retain project publication responses across interruption

Acceptance remains in `docs/spec-items/salvage-publication-provenance.md` under
#1217. The typed project publisher kept a successful PR creation response only
in memory until independent inspection and the final run update. An interrupted
inspection therefore left an existing PR without the evidence required to
establish its ownership. The outer salvage publisher's corroborated receipt
callback does not cover this project-driver window.

`trident/production-host-effects.ts:527` now saves the successful response before
inspection through `trident/project-publication-receipt.ts`, using the existing
run stage-event store. The response retains the run, project, repository,
worktree, branch, base, merge mode, target branch and head. Recovery reads the
latest response and inspects its exact PR; malformed evidence cannot fall back
to an older response. Only an independently observed matching OPEN PR permits
`published_pr` ownership. Existing publication and later review/merge gates
remain in force.

The real-git production host tests reconstruct the publisher after interrupted
PR observation and ownership persistence. Both recover with exactly one create,
including a repeated pass. Negative cases cover damaged receipt identity,
invalid numbers, malformed latest bytes, foreign PR identity, wrong head or
base, missing PR and failed response storage. The foreign discovery control
still refuses ownership. `bun test trident/production-host-effects.test.ts -t
'publication'` passes 50 tests.

Removing response persistence makes both consuming restart cases refuse
publication; bypassing the response identity check makes the foreign-identity
case grant ownership. Both mutations fail their assertions and were restored.
The Trident TypeScript check and 38 spec-index tests pass.

The crash between remote creation and durable response storage remains
unresolved; no historical PR is backfilled. This change does not settle native
owner work markers or broker mutations, release native-child admission leases,
or establish actual machine-restart acceptance. The broader recovery and
served-acceptance criteria remain open.
