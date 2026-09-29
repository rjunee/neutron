## 2026-09-29 — Retain witnessed card publication across an intermediate failure

An intermediate failed attempt can replace the card's linked run without
publishing anything. Looking only at that run's `published_pr` then loses an
earlier witnessed creation receipt and refuses the card's own existing PR.
This implements the card-lineage acceptance in
`docs/spec-items/salvage-publication-provenance.md` for #1418.

The dispatch owner now checks the direct linked receipt's repository and branch,
then consults earlier terminal attempts of that exact card
(`trident/board-dispatch.ts:1814`). The lookup requires the linked run's ledger
anchor, matching project and repository, and an earlier terminal PR-mode owner
on the requested branch with a positive durable `published_pr`. Both run start
order and ledger insertion order are checked (`trident/store.ts:1417`). An
observational `pr`, matching task text or matching branch alone grants nothing.
Publication ownership does not import a different attempt's build checkpoint;
the existing task and checkpoint rules still determine whether work is reused.

Four real consuming cases cover witnessed and discovered PRs, directly and
across an intermediate failed attempt
(`open/__tests__/project-build-e2e.test.ts:4939`). The witnessed lineage reaches
merge on its existing PR; the discovered sibling stays unowned and unmerged.
Store controls cover mode, chronology, anchor, project, repository, branch,
terminal state and malformed receipts (`trident/store.test.ts:36`). Dispatch
controls reject direct receipts from another repository or branch while a
text-only edit preserving that scope retains ownership
(`trident/board-dispatch.test.ts:1797`).

Six semantic mutants were executed and restored. Dropping the inherited receipt
kills the owned consuming case while its unowned sibling passes. Substituting
the observational PR kills the unowned case while its owned sibling passes.
Individually removing the SQL PR-mode, start-order, ledger-order or exact-anchor
predicate kills its corresponding refusal case while the valid control passes.
Each mutant produced one assertion failure and one passing control, without
using a syntax or execution failure as evidence.

Validation: 284 store/dispatch tests and four focused consuming E2E tests pass;
root and Trident TypeScript checks, changed-file lint and whitespace validation
pass. No live rows, PRs or deployment were changed. This record establishes the
static repair; it does not claim that #1418 has been deployed or witnessed live.
