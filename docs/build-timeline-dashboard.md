# Temporary PR build dashboard

Run `bun run scripts/build-timeline-server.ts` with configuration supplied by the
operator's protected environment file. This standalone diagnostic reads sources;
it never starts builds, changes workflow state or applies database migrations.

| Environment | Meaning |
|---|---|
| `TIMELINE_USERNAME`, `TIMELINE_PASSWORD` | Required Basic-auth credentials; no built-in defaults |
| `TIMELINE_CATALOGUE` | Required path to the GitHub catalogue JSON |
| `TIMELINE_OBSERVATIONS` | Required path to phase observation NDJSON |
| `TIMELINE_PORT` | Loopback listener port, default `8790` |
| `TIMELINE_DATABASES` | JSON array of `{path, repoPath, repository}` SQLite sources; default `[]`; `repoPath` is an exact database filter |
| `TIMELINE_IMPORT_STATUS` | Optional importer status JSON `{lastSuccessAt, error}`; stale or failed imports warn without hiding prior observations |

Expose the loopback listener through the operator's HTTPS reverse proxy. The
application owns the single Basic-auth gate. `/` serves the page, `/timeline`
serves the refreshed fragment, and `/api/timeline` returns the complete combined
snapshot. All require authentication and use `Cache-Control: no-store`.

Refresh the catalogue every 30 seconds with:

```sh
bun scripts/build-timeline-sources.ts catalogue \
  --repo example/project --repo example/operations \
  --output catalogue.json --observations observations.jsonl
```

The collector uses `GH_TOKEN` or `GITHUB_TOKEN` when supplied. It fetches the
inclusive paginated history, then refreshes changed PRs between full sweeps. CI
sampling is bounded to recent/current heads; each PR states its coverage. The
web page refreshes every 30 seconds and pages 50 PRs at a time. Search and repository
filters apply before pagination. The default chart shows the observed-work window,
from first recorded phase start to last recorded phase end; missing phases remain
unknown. Widths share the current page's scale. Each PR is one bar, with overlapping
phases partitioned on the same wall-clock axis rather than added together. Concurrent
phase categories share the height of the bar. Hover reveals phase information;
click or keyboard activation opens full phase, model, token and coverage details.
Source failures have a visible coverage disclosure and refresh failures an alert.
Run-only records remain in the authenticated JSON API, outside the PR chart.

## Readable chart acceptance

- Every displayed PR has one fixed-height bar; 25 parallel CI jobs cannot make the
  row taller or multiply wall time. `trident/build-timeline-html.test.ts` verifies
  interval partitions, overlaps, gaps and proportional widths.
- Labels and durations sit outside bars, so small phases never contain clipped
  text. Unknown phase timing never fabricates a build duration.
- The page remains usable at desktop and 390-pixel phone width without horizontal
  document scrolling. Phase details are available by hover, click and keyboard.
  Verify using real browser screenshots and interaction checks.
- Search covers the whole catalogue before pagination, and source-level unknown
  model/token data stays unknown. The authenticated API retains run-only groups.
  `scripts/__tests__/build-timeline-server.test.ts` verifies filtering and auth.

Record forward orchestration phases through the validated recorder:

```sh
bun scripts/build-timeline-sources.ts record --output observations.jsonl < phase.json
```

`DirectPhaseObservation` in `scripts/build-timeline-sources.ts` is the record
contract. Start and completion use the same `phaseId`, a fresh `eventId` and
increasing `observedAt`. Declare actual PR links and source evidence; model and
all unreported metrics are `null`. Input tokens exclude cached input. Never
allocate a session total across phases based on elapsed time. Shell commands do
not independently consume model tokens. If an attested agent-session envelope
carries tokens, label it agent-session activity and keep its nested command spans'
tokens unknown. Multi-PR links mark a shared span, not multiple spend.

The native Codex importer consumes exact command receipts:

```sh
bun scripts/build-timeline-codex-import.ts rollout.jsonl bindings.json --tail-bytes 16777216
```

It prints observation NDJSON to stdout and coverage to stderr. Bindings specify
allowed repositories, an opaque evidence reference and explicit time-bounded
checkout-to-PR links. Do not replace historical observations with a bounded tail:
merge validated new records using `appendChangedPhaseObservations`. A private
refresh process can publish importer status separately. Ambiguous, incomplete or
unbound history stays unknown. Raw commands, outputs and local paths are not
included in imported public-facing labels.

The implementation does not establish past planning/build/fix intervals where
no producer recorded them. It does not estimate cost or savings. Future Core
installation and identity remain [separate unspecified work](spec-items/build-timeline-core.md).
