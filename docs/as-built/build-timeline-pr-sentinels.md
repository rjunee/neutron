## 2026-09-25 — Correct dashboard PR identity and mutable CI timing

A served-data audit found a legacy Trident `pr = 0` row rendered as `PR #0`.
The dashboard now accepts only positive safe-integer PR identities, normalizing
invalid legacy values before both SQLite group selection and timeline projection.
Sentinels retain individual run identities instead of collapsing into a fake PR
lineage. A valid published PR takes precedence; an invalid published value does
not hide a valid legacy PR number. Workflow rows remain untouched.

The page and JSON separately expose PR and run-only group totals. Pagination
retains the full-source totals while showing the current page's group count.
Consuming SQLite, renderer and authenticated API tests cover sentinel rows,
valid PR controls, publication status and limit-before-grouping behavior.

Post-deployment polling also exposed GitHub revising a check run's start while
retaining its check ID. Treating that mutable field as identity stopped catalogue
refresh. Only GitHub CI check snapshots now key start identity by the stable
check ID instead. The collector appends revisions, retaining older snapshots,
and readers choose the newest timing. Other phase starts and changed check IDs
remain rejected. A consuming collector-to-log test covers initial, revised and
completed snapshots; negative controls retain strict non-check attribution.

Both root and Trident TypeScript checks and focused lint passed. Four deliberate
semantic mutants were killed and restored: admitting PR zero, rejecting valid
PRs, refusing GitHub start revisions, and allowing direct-source start revisions.
Independent review found no blocking issue in the final implementation. Full CI
and two successive successful served refresh ticks remain deployment gates.

Validation and deployment evidence are recorded on the follow-up PR and #1313;
the temporary dashboard's source/provenance and authentication contracts remain
unchanged. The separate portable Core work remains unspecified.
