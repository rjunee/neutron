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
| `TIMELINE_IMPORT_STATUS` | Optional importer status JSON `{lastSuccessAt, error, partial, coverage: {unbound, incomplete, scanPartial}}`; stale, failed, partial or unknown coverage warns without hiding prior observations |

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
focus or tap opens a custom phase popover; the full-size duration control exposes
all actions, including tiny spans. Clicking the PR label opens complete evidence.
Single-phase hover shows the activity once, followed by elapsed time, tokens,
model and local start/completion clocks. The full explorer retains range context.
Open PRs form the first section, with merged/closed below and recent activity
ordering within each section. Explicit PR state is separate from fresh provider
work signals. The default shared 1h focus window clips longer bars with an explicit
overflow control; Fit all shows their complete proportional extent. The locked
[timeline spec](spec-items/temporary-build-timeline-dashboard.md) owns status
freshness thresholds and the focus-window contract.
Source warnings have an expanded coverage disclosure and refresh failures an alert.
Import status uses a numeric millisecond `lastSuccessAt`, nullable `error`, boolean
`partial` and `scanPartial`, and nonnegative safe-integer `unbound` observation and
`incomplete` source counts. Fresh complete registered-source reports use explicit
false flags and zero counts. Legacy `{lastSuccessAt, error}` records and missing
coverage fields remain unverified; a successful refresh alone never proves
complete attribution. Unknown counts are not zero, and unbound history is never
silently assigned to a PR. Raw importer errors and paths are not served.
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
checkout-to-PR links. Do not replace historical observations with a bounded tail.
Native receipts have immutable event IDs: retain previously recorded IDs before
passing new receipts to `appendChangedPhaseObservations`. Passing every raw tail
directly to that append-only writer is unsafe: a tail can lose model context and
change a receipt's model to unknown without creating a new event. For example:

```ts
const recorded = new Set((await readPhaseObservations(journal)).map(row => row.eventId))
await appendChangedPhaseObservations(journal, imported.observations.filter(row => !recorded.has(row.eventId)))
```

This retains the original receipt, including an originally unknown model. A private
refresher that atomically merges its journal by event ID can preserve richer known
models when later tails lose context; it must not downgrade them or manufacture
new phase snapshots to bypass immutable identity checks. A private
refresh process can publish importer status separately. Ambiguous, incomplete or
unbound history stays unknown. Raw commands, outputs and local paths are not
included in imported public-facing labels.

For bounded whole-tree collection, give the private refresher one authorized Codex
`sessions` root rather than registering each rollout separately:

```sh
bun scripts/build-timeline-codex-discover.ts "$TIMELINE_CODEX_SESSIONS_ROOT" bindings.json
```

This scans only `sessions/YYYY/MM/DD/rollout-*.jsonl`, skips symlinks, and refuses
more than 256 files, 4,096 directory entries or 128 MiB of source data in one scan.
It reads each rollout through a verified file descriptor into a fixed-size
snapshot, then prints observation NDJSON to stdout and aggregate coverage to
stderr. An append after the snapshot's N-byte boundary is picked up on the next
scan; an empty newly created file contributes incomplete coverage until bytes
arrive. Replacement, truncation below N, and same-size rewrites refuse. The
private refresher retains journal event IDs and appends
only new observations as above. The directory root authorizes reading native
receipts; it does not attest PR ownership or phase. Test command spans need an
explicit time-bounded checkout-to-PR binding or an exact session/turn binding.
When both are present their PR links must agree; conflicting or ambiguous
checkout evidence refuses attribution. Successful GitHub commands can identify
their own PR. In-conversation tasks still need exact `turnBindings`. New unbound
rollouts appear in coverage without generating attributed phases.

Large session histories with explicit source registrations use the library API
`importRegisteredCodexRollout(sessionsRoot, rolloutPath, options, checkpoint?)`
instead of enumerating the tree. Each call reads exactly one canonical absolute
dated rollout, applies only that source's options, and returns observations,
coverage, private source identity, scan byte counts and a serializable checkpoint.
The initial backfill covers at most 1 GiB of source bytes; later calls read only
bytes after the checkpoint's captured byte boundary. Each new range is fingerprinted
and then parsed in 64 KiB chunks. A digest mismatch between the two passes refuses,
even when timestamps alias. Rewrites completed before fingerprinting begins or made
after the parsing pass ends can remain undetected when metadata also permits them.
`scan.readBytes` reports total physical bytes read, the sum of `parsedBytes` and
`verificationBytes`; a successful nonempty range is read twice. Only importer-consumed receipt fields are
retained in a private journal capped at 128 MiB and one million records. Command
output, test selectors, PR body text, prompts and other context are discarded;
successful PR-create output retains only an exact GitHub PR URL. Native identities,
boundaries, model history and per-turn usage retain their original meaning, including
malformed and regressing usage. Malformed JSON/root/payload records retain a compact
marker so coverage cannot silently improve. Older valid checkpoints are projected
on replay without reading rollout bytes again. Each scan also caps lines at one
million and individual lines at
8 MiB. Bounded unfinished final-line bytes persist in the checkpoint and are
prepended to the next append before parsing; they explicitly report incomplete coverage.
Unchanged sources read zero rollout bytes. Retained receipts are reinterpreted
under the current source config, preserving historical turn model/usage context.

The caller owns trusted private checkpoint storage: serialize refreshes, validate
unique registered paths and inode identities, process sources sequentially, and
atomically persist each complete checkpoint including its receipt journal. Never
persist a cursor separately from its journal. A crash before persistence safely
replays the old cursor; returned historical observations allow the output journal
to recover even after checkpoint persistence. Keep both journals private: checkpoint
records include native receipt details and paths. Export only observations and
aggregate coverage. Report coverage as registered-source scope; unregistered
history is unknown, not zero. Missing checkpoints trigger bounded backfill;
invalid checkpoints, replacements and truncation refuse. Same-size rewrites refuse
when metadata changes or the two passes produce different digests.
Append-only growth is assumed for the durable checkpoint prefix, which is never
reread. Rewriting that earlier prefix while growing the file, or a same-size
rewrite whose timestamps alias, cannot be detected by stat identity checks.

Native in-conversation work has no child command to wrap. For open and completed tasks,
the importer also accepts operator-attested `turnBindings` in its private config:

```json
{
  "repositories": ["example/project"],
  "evidenceRef": "codex:task-receipts",
  "turnBindings": [{
    "sessionId": "recorded-session-id",
    "turnId": "recorded-turn-id",
    "phase": "build",
    "links": [{ "repository": "example/project", "prNumber": 7 }]
  }]
}
```

The operator must attest both the task's PR ownership and its phase; a checkout,
PR mention, agent name or task title is not that attestation. Supported categories
are `plan`, `build`, `fix`, `review`, `test`, `ci` and `deploy`. The native
`task_started` receipt supplies an open task's start at one-second resolution;
`task_complete` supplies its own matching start/end. A context or registration alone
does not supply a start. Missing completion remains an open/dashed interval with
unknown completion and incomplete coverage; it does not prove worker liveness.
An exact native `token_usage_record` for the
same session and turn supplies input, output and cached-input counts for that
attested task only. Native usage records are cumulative within a turn, so the
last monotonic snapshot in the scan supplies its totals; malformed or regressing
matching snapshots leave them unknown. Native input includes cached input, so the displayed input
field excludes cached input and the cache-read field carries it separately.
Missing receipts leave tokens unknown;
cache creation and provider cost remain unknown. Nested command spans retain
unknown tokens. A unique recorded invoking model is shown only from a full source
scan or complete checkpoint journal; missing or mixed task contexts remain unknown.
Later native evidence may revise the task model to unknown while its exact turn,
PR links, category and start remain immutable. Each changed native snapshot has
a deterministic immutable event ID and advances the same phase with cumulative
usage, using native receipt observation clocks rather than refresh time. Equal-time
conflicting snapshots refuse through the journal's existing ambiguity guard.
All start-backed task snapshots from partial tails are deferred: a tail can omit
an earlier model or malformed usage receipt. For completion-only history, a tail can omit a
usage receipt; such a partial task is deferred instead of recording unknown usage
permanently. One model in a tail cannot prove the task used only that model.
These are task envelopes that can contain
nested tests or review commands, so their overlapping durations are not additive.
Register the session root and private binding config with the refresher; the
discovery command then picks up new rollout files without per-file registration.
New orchestration lanes still require explicit binding records.
An exact turn registration also covers that turn's nested local test commands,
including commands completed before task completion. It never lends ownership
to sibling or follow-up turns. Command usage stays unknown; only the attested
task envelope receives its native per-turn usage receipt.
Older checkpoints that discarded task-start records need a bounded full backfill
to recover those starts; replay cannot recover discarded bytes. Retain the existing
observation journal when resetting a private source checkpoint. New starts are
retained and imported incrementally.

Manual native task registration is available once the exact session and turn have
a native `turn_context` record. Put the single binding object (the object inside
`turnBindings` above) in a private JSON file, then run:

```sh
bun scripts/build-timeline-register-turn.ts PRIVATE-CONFIG.json ROLLOUT.jsonl OBSERVATIONS.jsonl PRIVATE-BINDING.json
```

Before first use, the operator adds `observationJournal` to that existing private
import config, with the exact absolute journal path already used by its refresh
service. This is a one-time registration setup: retain all existing fields and
bindings, and do not change the service's journal or rewrite observations. The
importer ignores this extra config field, so installed refresh behavior continues
unchanged. A config without the field still imports normally but cannot accept
registration through this command.

Use the existing refresh source's config/rollout pair and its observation journal.
The command derives the refresher/recorder's `OBSERVATIONS.jsonl.lock` from the
trusted config; the supplied journal argument must match exactly and cannot select
another lock. All three writers hold an advisory lock on one permanent mode-0600
marker inode. The kernel releases it after process death without relying on PID
reuse or marker age. A pre-existing empty or foreign marker from the former
create/unlink protocol is refused; during upgrade, fence old writers and confirm
they have exited before removing that marker. Never remove a valid new marker,
even when no writer is active, because replacing its inode would split the mutex.
The command validates
the config's repository allowlist and exact native identity, and atomically writes
the config with mode 0600. Identical registration is a no-op; changing an existing
turn's phase or PR links is refused. A busy lock or partial native JSON record
refuses without changing the config; retry once the writer finishes. The tool
never changes existing observation bytes or guesses usage. The next successful
refresh imports the task once its native start or valid completion receipt is available.

This is an explicit operator seam, not automatic dispatch instrumentation. Repeat
registration for every intended root or child turn, including follow-up turns;
parent linkage does not inherit PR ownership or phase. The separate configured
session-root collector above discovers a newly spawned session's rollout without
per-file registration. This registration tool neither discovers those sources
nor intercepts the native `spawn_agent` tool. An active registered turn appears
when a full scan or complete checkpoint retains its native task-start receipt;
registration time is not a task start. Its missing completion and observed usage
remain explicit, and absence of an end never establishes current liveness.
Unregistered turns remain unknown. An automatic dispatcher producer remains
outstanding under #1313. Successful manual registration does not establish all-PR coverage.

Evidence references identify the opaque source and native receipt ID; session and
turn identities remain separate source fields. Bounded-tail byte offsets belong
to scan coverage, so a growing log does not change an already imported receipt's
provenance or create a second phase on replay.

The implementation does not establish past planning/build/fix intervals where
no producer recorded them. It does not estimate cost or savings. Future Core
installation and identity remain [separate unspecified work](spec-items/build-timeline-core.md).
