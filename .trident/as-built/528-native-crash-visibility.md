## Issue #528 — Native Android process-start crash visibility

### What changed

Expo prebuild now registers an unexported initializer provider at maximum init
order (`app/plugins/with-native-crash-reporting.js:7-22`) and generates its Kotlin
implementation (`app/plugins/with-native-crash-reporting.js:24-120`). The provider
installs an uncaught-exception handler before ordinary providers, synchronously
stages a bounded envelope in app-private storage, and then delegates to the
previous handler (`app/plugins/with-native-crash-reporting.js:35-80`).

On the next JS-capable launch, the app waits for server configuration hydration,
binds the destination gateway, and imports the staged envelope before mounting the
application tree (`app/app/_layout.tsx:187-203`). The importer builds a redacted
`native_crash` report through the existing report builder
(`app/lib/native-crash-import.ts:20-61`). The diagnostics runtime deduplicates the
stable native report id, persists it into the existing queue, re-reads that queue,
and only then removes the native file (`app/lib/diagnostics.ts:165-199`). The next
authenticated diagnostics sync uses the existing bearer and endpoint
(`app/components/DiagnosticsSync.tsx:24-44`).

The outcome joins the existing `ReportReason` union
(`app/lib/diagnostic-report.ts:45-52`). The gateway's existing inbound vocabulary
stores a bounded sanitized reason string without a reason-specific switch
(`gateway/diagnostics/client-report-redaction.ts:224-252`), so the default is the
ordinary authenticated diagnostics storage path rather than a new endpoint or
error policy.

### Decisions and invariants

`Application.onCreate` was rejected as the installation seam because the defect
to observe is an earlier content-provider failure. A separate maximum-order
initializer provider maintains the invariant independently of the provider that
fails (`app/plugins/with-native-crash-reporting.js:12-18,77-87`). A native handler
does not attempt network delivery or authentication while the process is dying;
durability is maintained by app-private staging followed by the already-bounded
queue (`app/lib/native-crash-import.ts:68-94`, `app/lib/diagnostics.ts:178-198`).

The product decision and living architecture were updated at `SPEC.md:294-306`
and `docs/SYSTEM-OVERVIEW.md:938-955`. A whole-tree phrase sweep used one pattern
for both obsolete limitation text and the known-present replacement; its positive
control found `Native process-start capture` at
`docs/SYSTEM-OVERVIEW.md:944`, while none of `JavaScript errors ONLY`, `does not
catch native crashes`, or `What is NOT covered: native crashes` remained outside
frozen historical records.

### Mutation evidence

| Guard | Mutation and landed line | RED | Restored GREEN |
|---|---|---|---|
| Provider runs before other process-start providers | Changed init order `2147483647` to `1`; printed `app/plugins/with-native-crash-reporting.js:16` | `registers a highest-priority initializer before other process-start providers` failed | Same test passed after restoring maximum order |
| Native evidence is removed only after durable handoff | Inverted `if (!persisted)` to `if (persisted)`; printed `app/lib/diagnostics.ts:192` | Successful handoff and refused-storage cases both failed | Both passed after restoring the condition |

The restored focused run was 45 passing tests across
`app/__tests__/native-crash-reporting.test.ts`,
`app/__tests__/android-fcm-config.test.ts`,
`app/__tests__/diagnostic-capture.test.ts`,
`app/__tests__/diagnostic-queue.test.ts`, and
`app/__tests__/diagnostic-redaction-invariant.test.ts`. The new test file exercises
the pre-JS manifest seam, generated handler properties, report redaction, and both
sides of the durable handoff (`app/__tests__/native-crash-reporting.test.ts:21-143`).

Expo config resolution included the local plugin, and a disposable SDK 54 prebuild
produced the provider manifest row and Kotlin source. App lint completed with zero
errors and 21 warnings in untouched files. App typecheck stopped before source
analysis with TS2688 because the installed dependencies expose an invalid implicit
`@types` entry; `app/tsconfig.json:1-20` does not declare it.

### Deliberately not changed

No unauthenticated endpoint, third-party crash service, feature flag, or alternate
delivery path was added. Native code never reads or carries a bearer. iOS native
crashes remain outside this Android mechanism, as documented at
`docs/SYSTEM-OVERVIEW.md:955`. The spec-item checkboxes remain open because this
repository verifies them against the merged tree rather than a branch.
