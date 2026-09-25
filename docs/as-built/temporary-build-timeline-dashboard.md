## 2026-09-25 — Temporary PR wall-clock dashboard

Added a standalone, read-only Bun dashboard covering PRs from every configured
GitHub repository and observed work from Trident and direct orchestration. The
catalogue is inclusive and paginated; the page shows fifty cards at a time with
an explicit total and lifecycle/work window controls. Latest recorded activity
determines reverse chronology, so a retry on an older PR remains visible.

`trident/build-timeline.ts` reads SQLite without migrations or writes, grouping
complete PR run lineages. Attempt timestamps and host stage identities preserve
parallel reviews, repeated test suites and CI waits. Open ends remain dashed;
uncovered time remains unattributed. `trident/build-timeline-catalogue.ts` adds
manual/direct PRs and explicitly linked phase observations, models and shared
multi-PR span labels. Phase totals are separate from attempt projections; unknown,
partial, explicit zero and all-five-metric complete coverage remain distinct.

`scripts/build-timeline-sources.ts` provides the GitHub catalogue/current-head CI
collector and validated append-only phase recorder. The native Codex importer
uses command receipt timestamps and explicit bounded PR attribution, exports
safe labels, and leaves command token counts unknown. A bounded tail import
declares its missing-history coverage. Earlier CI heads, ambiguous operations
and uninstrumented historical phases remain unknown.

`scripts/build-timeline-server.ts` binds loopback with mandatory Basic credentials
and protects the page, HTML fragment and JSON equally. Browser refresh is thirty
seconds, with failed-refresh and stale-source notices. Source failures preserve
other readable inputs. Rendering escapes titles and labels, and the CSP permits
only the known refresh script. Host-specific HTTPS/service configuration remains
outside this public tree. See `docs/build-timeline-dashboard.md` for operation.

Local verification on this branch: the integrated focused/source/importer/HTTP
and generated-index tests passed **71 tests, 581 assertions**. Both root and
Trident TypeScript checks passed. Six deliberate semantic mutations were killed:
anonymous-auth bypass, refusal of valid auth, unknown tokens changed to zero,
explicit zero changed to unknown, orphan stage ends admitted, and valid paired
stage ends refused. Each failed on behavior assertions, then was restored.

Independent cross-model review found no blocking runtime, authentication or
attribution defect in the integrated projection, renderer and server. The review
specifically checked shared spans, escaping/CSP, credential gates and stale/unknown
coverage. The local whole-tree leak scan encountered existing denylist matches;
publication still requires the normal purity check.

The complete shared-host suite is deferred while the live build lane owns host
validation; no concurrent full suite was started. Full CI and
external HTTPS served verification remain publication/deployment gates. Local
loopback HTTP tests establish auth and data consumption, not public deployment.
The temporary spec remains open until its operational evidence exists; the
future portable Core remains a separate `needs_spec` item.
