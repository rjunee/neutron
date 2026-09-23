## 2026-09-23 — Recover an exact builder commit before publication

Refs #1133. The rebuilt builder brief omitted the commit instruction that the
legacy workflow emitted. The failed build's run-owned brief contained the
snapshot and execution-scope contracts but no wrapper instruction; its completed
result named the same trailer-bearing object the publication gate refused.
That object's sole parent matched the host's pre-dispatch snapshot. This was a
missing producer instruction, not evidence that the builder ignored one.

`open/wiring/project-build.ts:543` now gives build and fix workers the installed
host wrapper's argv, omits the session trailer, retains co-author attribution,
and requires both reported commit fields to use the final measured OID. Planner
and reviewer briefs do not acquire a commit instruction.

The host also handles a direct commit at the completed-worker boundary, before
checkpointing, mutation proof, publication, or review
(`trident/build-run.ts:687`). `trident/recover-builder-commit.ts:43` authenticates
raw bytes against the claimed Git object ID. Recovery requires an unsigned
single-parent commit directly on the host-held worker input, matching full head
and payload claims, assigned branch and PR, and the exact original completed
worker envelope. It refuses signed, merge, unsupported-header and uncertain
objects. Clean commits remain unchanged.

Only session-trailer lines are removed. The complete header block, including
tree, parent, author, committer and encoding, and every other message byte are
retained. The candidate is independently read back before use. A prepared Git
transaction locks the assigned branch, checks that it is still a direct ref,
and swaps only the expected OID (`trident/swap-builder-commit.sh:13`). A concurrent
child, sibling or symref is preserved. Neither HEAD nor the index is reset.
The original commit object remains available.

A durable host intent precedes the swap. It binds the original artifact digest,
run, step, original OID and replacement OID. The original worker file stays
immutable; artifact readers project only those two commit fields after checking
the receipt and the existing original pending-to-completed checkpoint sequence
(`open/wiring/project-build.ts:571`). Mutation nominations, suite evidence and
publication metadata therefore refer to the recovered revision without
inventing another worker result. An unacknowledged successful swap can be
reconciled by the same pending request with unchanged brief bytes.

G135's wrapper and G166's publication scanners are unchanged. Recovery does not
rewrite ancestors, infer ownership from an author name, replace a signature,
skip a review, or grant publication on unreadable history. Already-completed
old checkpoints with compatible briefs bypass the worker boundary on exact-head retry
(`trident/build-run.ts:513`); they still fail G166 if they carry the trailer.
An existing run whose persisted brief differs from the new deployment
is not migrated by this change. A completed but unpublished PR run also fails
the ordinary retry seed's remote-tip proof (`trident/board-dispatch.ts:1551`),
so a card retry requests a fresh build rather than adopting that old commit.
Use a fresh card for the historical failure; do not manually rewrite or publish
its old branch.

Verification includes real Git controls for raw identity, preserved headers and
non-UTF-8 bytes, missing final newlines, replacement refs, unsupported objects,
concurrent branch movement, immutable artifacts and lost swap acknowledgement.
The parent-check widening and recovery-removal narrowing mutations each fail
their behavioral guard while the clean-commit control passes. The unchanged
wrapper, release-readiness and publication real-Git suites pass together.
The consuming Open E2E tests merge direct and wrapped attribution through both
build and fix rounds, including executable production mutation nominations.
They assert public messages are clean, raw headers survive, and original worker
artifacts retain their original SHAs. Disabling recovery makes the direct-build
E2E fail at G166 while its wrapped control still merges. A historical carrier
test proves same-run resume remains blocked and unpublished PR retry cannot
adopt its checkpoint. All 51 TypeScript configurations passed before rebasing.
The full unsharded run audited all 1,650 test files. Its two new registry failures
were fixed by preserving line delimiters with string splitting rather than a
broad regex; the unchanged identity registry and 21 recovery tests then passed.
Its one unrelated voice-note retry failure passed an isolated 14-test rerun.
Independent review found no blocker within the fresh-run and same-brief recovery
scope. Deployment and a fresh live unattended merge are separate acceptance.
