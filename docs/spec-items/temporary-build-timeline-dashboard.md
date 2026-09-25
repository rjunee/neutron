---
title: Observe PR wall-clock phases in a temporary authenticated dashboard
group: platform
status: open
priority: P1
cutover: false
---

# Temporary build timeline dashboard (#1313)

The owner needs to locate wall-clock time spent across all configured repositories'
PRs, including direct orchestration, local test suites, CI, review, fixes and
deployment. Tokens are secondary. A small standalone diagnostic server provides
this view now; the portable Core remains the separate, unspecified
[future item](build-timeline-core.md) (#1314).

The reviewed scope is a read-only Bun service, bound to loopback behind an
operator-configured external HTTPS reverse proxy. One mandatory Basic-auth gate
covers the page and data. Public code contains no hosted address, credentials or
private deployment paths. This preserves the single-owner product boundary in
`SPEC.md` §2.1; deployment-specific DNS, TLS and service configuration live outside
this repository.

GitHub is the inclusive PR catalogue, paginated per configured repository. Trident
run/attempt/receipt/stage rows contribute observed intervals. Explicit orchestration
phase records and native command start/end records contribute direct-work spans.
Every direct span has a stable identity, explicit PR linkage, source and model
identity or unknown. One span linked to multiple PRs remains shared, not additive.
Historical commands with ambiguous PR ownership remain unassigned; merely mentioning
a PR or working in a checkout does not assign an entire session's tokens to it.

PR lifecycle (creation through close, or refresh while open) is distinct from
observed work. Work preceding PR creation and deployment following merge remain
visible when linked by evidence. Rows sort by latest observed activity. Equal time
uses equal width across rows; simultaneous phases use parallel lanes. Gaps are
unattributed time, not proven waiting or idleness. A known waiting interval may be
named only by its producer. A missing end stays open/dashed and does not establish
worker liveness. Legacy stage pairs require unambiguous observed endpoints.

Attempt receipts are absolute observations. Phase snapshots are cumulative
run/phase totals and cannot be apportioned across repeated spans or added to their
attempt projections. Input excludes cache reads/creation. Unknown is never zero;
explicit zero survives. Complete accounting needs all five metrics, including
provider-reported cost. These are the existing rules in
`trident-phase-accounting.md:11-25`, not a new savings instrument. Shell command
spans carry unknown tokens unless a provider actually attributed usage.

## Acceptance

- [ ] All PRs returned by each configured repository's paginated catalogue appear;
      an inaccessible repository produces a source-error banner without erasing
      readable repositories. Trident-free PRs retain unknown phase coverage.
- [ ] Reverse chronology follows recent recorded activity, including a new retry
      of an older PR. Repository badges distinguish equal PR numbers across repos.
      Only positive safe-integer PR identifiers count as PRs. Legacy sentinel
      values remain separate run-only rows, with real PR and run-only totals
      explicitly distinguished across pagination.
- [ ] Widths represent actual timestamp differences on a shared scale. Concurrent
      review, suites and CI stay overlapping; sequential siblings reuse lanes.
      Repeated host stage names pair by their recorded start identity. Ambiguous
      pairs remain unknown. Phase labels, wall time, models and coverage are readable
      on desktop and phone, with a work-focused view for long lifecycle envelopes.
- [ ] Native direct command spans use recorded start/end, explicit time-scoped PR
      mapping and invoking model context; absent context stays unknown. Explicit
      forward phase records support planning, building, fixing, review, tests,
      CI and deploy without reconstructing invented history.
      GitHub CI snapshots may revise the recorded start for the same check-run
      identity; the newest observation supplies timing without rewriting earlier
      snapshots. Non-GitHub phase start identities remain immutable.
- [ ] Unknown, partial and complete metrics remain distinct, costs are never
      estimated, and phase totals cannot double-count attempt receipts. Multi-PR
      linked observations are marked shared and not summed.
- [ ] Page/fragment/JSON deny anonymous and incorrect credentials and serve valid
      credentials. Missing credentials refuse startup; read-only SQLite does not
      migrate or write workflow state. Browser refresh is 30 seconds, with stale
      source and failed-refresh notices. Raw logs and source paths are not served.
- [ ] Consuming tests and bidirectional semantic mutations cover authentication,
      unknown/zero accounting and valid/invalid interval attribution. Both root
      and Trident TypeScript checks and the shared-host suite pass.
- [ ] Deployment proves the externally reachable HTTPS page, anonymous denial,
      authenticated page/data, refresh and real inclusive PR/phase sources. Record
      code/deployment revisions and outstanding historical unknown coverage.
      Merge alone does not satisfy served verification (harness-orchestrator
      pivot plan §4, lines 278-279).

Verify: `bun test trident/build-timeline.test.ts scripts/__tests__/build-timeline-server.test.ts`
plus the catalogue/recorder/importer focused tests, then
`bash scripts/check-shared-host.sh`. The deployment criterion stays open until its
separate operational evidence exists.
