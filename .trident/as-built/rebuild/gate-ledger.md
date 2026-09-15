## 2026-09-15 — Trident gate ledger rebuilt

### What changed

The 165-row inventory now gives every gate exactly one Fate value: 85 `keep-in-place`, 73 `re-home-to-TS`, and 7 `deleted-with-the-mechanism` (`docs/trident-gates-inventory.md:55-64`). The seven deleted IDs and the reason G022 remains a replacement obligation are explicit at `docs/trident-gates-inventory.md:57`.

The summary now reports the row-derived 155 Silent and 10 Loud classifications. G135 is the only row that moved: independent hook enforcement changed it from Silent to Loud, while the prior summary retained the old total (`docs/trident-gates-inventory.md:3`, `docs/trident-gates-inventory.md:229`). The current 11-entry NO TEST set is enumerated at `docs/trident-gates-inventory.md:39-41`; the routing plan now removes the seven subsequently pinned IDs from its stale 18-entry list (`docs/trident-routing-gap.md:131-133`).

All numerical `inner-workflow.mjs` references in the inventory, routing audit, and locked pivot document are labeled `pre-#845`; the inventory records why the historical anchors were retained instead of recalculated (`docs/trident-gates-inventory.md:59`).

The unsupported Work Board acceptance box was removed. Its replacement records that the box was agent-authored, is not present in a governing spec, and must not be reinstated as owner acceptance (`docs/spec-items/the-orchestrator-owns-the-build-loop.md:61-62`). The routing audit now points to host-owned inventory gate G130 instead of calling the removed box a product contract (`docs/trident-routing-gap.md:81`).

### Decisions

Historical workflow anchors were marked `pre-#845` rather than re-anchored. The old lines are evidence from the original enumeration, and relabeling preserves that provenance without claiming the shortened file still has those locations (`docs/trident-gates-inventory.md:5`, `docs/trident-gates-inventory.md:59`).

Fates follow ownership at cutover: existing host-owned TypeScript, shell, and hook boundaries stay; workflow-embedded behavior moves into the TypeScript replacement; checks whose condition exists only because of the retired launcher are deleted with it (`docs/trident-gates-inventory.md:57`).

### Enumeration and validation

`awk -F'|' '/^\\| G[0-9][0-9][0-9] / { if ($7 ~ /Silent:/) s++; else if ($7 ~ /Loud:/) l++; n++; fate[$3]++ } END { print n, s, l; for (f in fate) print f, fate[f] }' docs/trident-gates-inventory.md` printed 165 rows, 155 Silent, 10 Loud, with fate totals 85/73/7. This enumerates every row by its gate-ID shape rather than relying on the prose summary.

The stale-anchor check searched all three affected documents for `inner-workflow.mjs:[0-9]+` and filtered out lines containing `pre-#845`; it returned no lines. The same unfiltered search found the labeled anchors as its positive control.

`bash scripts/ci/lint.sh` passed. `bash scripts/ci/typecheck-all.sh` checked 51 configurations: 46 passed, including `trident/tsconfig.json`; five unrelated configurations failed on existing platform/type-package errors in `app`, `gateway`, `logger`, `onboarding`, and the root config. The repository has no `bun run typecheck` script. The local purity scan found zero findings in every available rule and returned incomplete because its private denylist was unavailable.

### Mutation table

| Guard | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| None | Not applicable: this documentation-only change adds no executable guard or test. | Not applicable | Not applicable |

### Deliberately not done

No code or tests changed. Historical line numbers were not guessed against the post-#845 file. The seven launcher-only gates were not reassigned to a compatibility path, because the locked cutover deletes that mechanism and forbids dual execution paths (`docs/trident-gates-inventory.md:57`). No spec decision changed.
