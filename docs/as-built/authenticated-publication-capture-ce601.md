## 2026-09-21 — Authenticate publication captures against Git object identity

This repairs G166 on the cumulative publication branch while retaining the
locked plan's gate-preservation requirement (`SPEC.md:634` and
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:265`). It adapts the
authentication mechanism from `33cb30e7` onto `ce601b78`; the later head validation,
raw graph traversal and awaited refusal conversion remain in place. It is a local
candidate for the existing PR, not evidence of deployment or an unattended merge.

The old size check could accept a truncated carrier when decoding an invalid byte
added exactly as many UTF-8 bytes as truncation removed. Its token-prefix heuristic
also refused a legitimate clean message ending in `Claude-Session` followed by LF.
Both are now decided by object identity: `trident/gates/release-readiness.ts:55`
hashes the Git commit envelope and captured bytes, restoring only supported LF
terminators. `:149` verifies that hash before `:154` scans the message. A mismatch
is unknown and names the SHA and measured byte counts. SHA-1 and SHA-256 are
selected by the validated listed OID width.

The real-git tests at `trident/gates/release-readiness.test.ts:565` construct the
invalid-UTF-8 object, demonstrate the equal-length truncated capture, and require
unknown from both readiness entry points. `:596` covers lost colons and
equal-length substitutions; `:629` covers direct and one-LF captures, clean
trailer-like prefixes, valid replacement characters, both empty-message separator
forms, and clean messages without a final LF. `:658` rejects a headers-only cut
that lost actual message data. Every case runs with 40- and 64-character Git OIDs.
The existing empty-message, carrier, malformed-head, graph-view and thrown-runner
regressions remain active. The G166 inventory now states the hash boundary;
historical as-built records remain unchanged.

Nine executable mutations were applied separately and restored. Each produced
assertion failures, not parser failures:

| Mutation | Direction | Failing tests |
| --- | --- | ---: |
| Return true from object authentication | Under-refusal | 2 |
| Skip authentication at zero byte gap | Under-refusal | 2 |
| Skip authentication at one byte gap | Under-refusal | 2 |
| Skip authentication at two byte gap | Under-refusal | 2 |
| Always hash with SHA-1 | Over-refusal | 1 |
| Return false from object authentication | Over-refusal | 2 |
| Reject the two-LF empty-message restoration | Over-refusal | 2 |
| Reject the one-LF empty-message restoration | Over-refusal | 2 |
| Reject authenticated clean `Claude-Session` prefixes | Over-refusal | 2 |

Focused verification: 38 tests passed, 184 assertions. Both root and Trident
TypeScript projects passed after an offline frozen-lockfile dependency install.
The focused suite, inventory citations, real-git build-claim tests, publication
trailer tests, stranded salvage tests, gateway stranded-sweep composition,
build-host and production-host effects passed together: 215 tests across eight
files. `open/__tests__/project-build-e2e.test.ts` passed separately: 104 tests,
1,037 assertions. Its initial sandbox run failed nine local socket listeners;
the complete rerun with socket access passed. The separate build-claim unit
suite is 9 passed / 1 failed because its synthetic carrier still has an unrelated
OID; the companion fixture change belongs to the claim-preservation lane.

The leak guard passed on all four changed files with the repository allowlist
and license. A full raw-worktree scan reported 454 findings in unchanged content
and the local worktree pointer; it is not a green full-tree leak result.

The scope is capture authentication. G100 preservation behavior is unchanged;
its test doubles need object-consistent OIDs alongside this candidate. Arbitrary
fabrication of the range listing is outside the authentication boundary, and
captures losing more than the supported LF terminators remain unknown.
