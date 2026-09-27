## 2026-09-27 — Preserve existing published work and refused candidates independently

Issue #1316 reproduced a publication loss with real Git: a fresh sibling built
from current main passed the null-reviewed-head path, skipped replay, and
replaced the existing branch under a valid exact lease while omitting earlier
published content. The lease prevented a concurrent ref race but did not prove
content preservation.

Both publication writers now validate the same observed OID used by their push
lease. Raw ancestry accepts normal subsequent edits and deletions. Rewritten
history requires a clean three-way merge whose resulting tree already equals
the candidate. The calculation uses an isolated Git configuration and raw object
graph, preventing local replacement refs, grafts, shallow views and custom merge
drivers from manufacturing approval. Unknown or conflicting evidence refuses.

Independent review required authenticating and stabilizing every object used by
that calculation, not only reading commit names through mutable alternates. The
guard now captures a compressed reachable pack, independently indexes it, runs
full strict Git integrity validation, and verifies both original commit roots.
Only that private snapshot supplies ancestry and merge; inherited object-store
selectors are removed. Pack and index generation share a 512-MiB ceiling and
all commands share a 60-second deadline. Failure refuses and cleans up. This
small implementation copies historical blobs too: an intact 1,245-commit
measurement used 32.7 MB and approximately seven seconds. There is no cache.
Focused controls cover unavailable validation, truncated and oversized packs,
aggregate deadline exhaustion, inherited object-store selectors, and a valid
replay measured after the source Git directory becomes unavailable.

G100 preservation now creates a deterministic candidate-specific recovery ref
with an expected-absence lease. An exact existing match is a measured no-op;
foreign or unreadable state refuses. The refusal names the witnessed ref, the
original branch remains intact, and no PR/review is started. Clean, carrier,
unavailable and throwing trailer scans retain their advisory preservation
behavior. Legacy claim disagreements use this same path.

Focused validation includes real-Git loss and valid replay, both publication
writers, exact lease races, immutable recovery refs, scan exception controls,
hostile graph/configuration controls and deliberate descendant deletion. The
consuming `open/__tests__/project-build-e2e.test.ts` cases execute real preparation,
native worker transport, production publication, review and merge: missing prior
work leaves the original remote unchanged, while valid rewritten work reaches
merge with its earlier content. Existing driver behavior reports the refused
publication effect as `unknown` with its precise reason.

Two semantic mutants were killed by assertion failures: unconditional loss
acceptance and ancestry-only rejection of valid content-preserving replay.
Both were removed after measurement. Root and Trident TypeScript checks passed.
The exact focused commands and final results accompany this change's handoff;
these focused results are not a whole-suite or deployment receipt. Independent
review is complete; the shared-host full gate, CI and served acceptance remain
outstanding.

Independent native review approved frozen preservation source
`00d22cdd1bf117c03d5a89d3a815400ebad00b36`, including the reachable-object repair.
Two bounded Fable attempts returned no verdict before their deadlines and were
not counted as approval. An explicitly narrowed production-only Opus review
then approved the complete helper and both publisher/G100 production deltas in
one 53-second turn. Its scope excluded test/documentation bulk; native review
and the measured consuming and mutation checks establish those separate parts.
Nonblocking operating-envelope notes are retained in issue #1352, not another
fix round.

Root composed the independent namespace correction at
`7a114b7e93780794018757f9f6a56b0651d05643`, producing
`3468bf0a4a1e65a8ba95aae5b6b3aaaa4a52a029`. The two changes have no overlapping
files: comparisons to each parent establish that all reviewed source bytes are
unchanged. This composition receives its own complete validation; neither
parent's focused or full-suite receipt is transferred to it.

A rewritten history that intentionally removes prior content without retaining
ancestry or a separately verified transformation cannot establish preservation
from its final tree alone; it stays refused. No intention is inferred from prose,
and no old approval, suite or mutation proof transfers to a moved head.
