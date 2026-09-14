## 2026-09-14 — Scope usage cards to the active credential and require account identity

### Decision and implementation

Issue #587 explicitly permits the single-credential alternative. This change takes
that alternative rather than introducing credential-pool discovery. Both cards
state: “Samples from this install’s active credential only. Other connected
accounts are not probed.” The copy is rendered at `app/app/usage.tsx:222` and
`landing/chat-react/SettingsTab.tsx:1716`.

The monitor resolves one credential at `open/credential-usage-monitor.ts:237`,
probes it at `open/credential-usage-monitor.ts:248`, and persists its label at
`open/credential-usage-monitor.ts:257`. The issue’s resolver citation at line 249
has moved. Its store citations remain accurate: label normalization is at
`persistence/usage-samples-store.ts:441` and grouping at
`persistence/usage-samples-store.ts:512`. Kimi persists the sampled label at
`open/kimi-usage-monitor.ts:168`.

Identity is enforced before projection and pool aggregation at
`app/lib/usage-dashboard-client.ts:727` and
`landing/chat-react/usage-dashboard-client.ts:708`. Missing or blank labels keep
their rows but lose both usage windows. Named readings retain their windows.
The identity explanation is rendered by `accountName` at
`app/lib/usage-dashboard-client.ts:898` and `accountCapacityNote` at
`app/lib/usage-dashboard-client.ts:957`; web equivalents are at
`landing/chat-react/usage-dashboard-client.ts:879` and
`landing/chat-react/usage-dashboard-client.ts:938`.

This joins the existing `CapacityStanding` unknown vocabulary: missing windows
produce unknown at `app/lib/usage-dashboard-client.ts:563`, the pool’s default
branch counts unknown at `app/lib/usage-dashboard-client.ts:677`, and the headline
reports that count at `app/lib/usage-dashboard-client.ts:997`. It does not turn an
unknown row into an available account. Every card render calls projection
(`app/app/usage.tsx:206`, `landing/chat-react/SettingsTab.tsx:1699`), so the
invariant does not depend on the probe or the label writer continuing to work.

### Acceptance and tests

- Both cards explicitly disclose the single-credential scope.
- A null or whitespace label renders an unknown account with usage withheld.
- A named account with real windows still renders its numbers.
- Named rows with unreported windows remain visible as unknown.
- Pool capacity excludes unidentified readings and counts them as unknown.

The render cases are at `app/__tests__/usage-dashboard-reachable.test.tsx:342`
and `landing/chat-react/__tests__/usage-dashboard-web.test.tsx:401`. The shared
projection assertion is at
`gateway/__tests__/usage-dashboard-client-parity.test.ts:1114`.

Existing numeric fixtures now supply an account name; their numeric assertions
are preserved. The old expectation that losing a label double-counts availability
was incorrect under the task’s identity requirement. It now asserts one available
and one unknown, at `gateway/__tests__/usage-dashboard-client-parity.test.ts:803`.
The old unnamed “next up” winner likewise becomes ineligible; the identified
account wins instead. No assertion was loosened or skipped. New DOM absence
assertions compare the null predicate directly to avoid enormous object dumps
when a mutation correctly makes a node appear.

### Mutation evidence

Each mutation ran alone. The exact landed line and `git diff` were printed before
the test. The test named “withholds unidentified numbers while preserving named
and unknown rows” failed on every mutation and passed after every restoration.
Both fixtures contain real windows as well as named controls.

| Guard or claim | Mobile / web landed line | Mutation | Mutated | Restored |
|---|---|---|---|---|
| Identity required | client :727 / :708 | `identified = true` | RED / RED | GREEN / GREEN |
| Named usage permitted | client :727 / :708 | `identified = false` | RED / RED | GREEN / GREEN |
| Blank identity refused | client :727 / :708 | check only non-null | RED / RED | GREEN / GREEN |
| Unknown identity reason | client :957 / :938 | condition replaced with false | RED / RED | GREEN / GREEN |
| Blank display name refused | client :899 / :880 | remove trim and use null-only fallback | RED / RED | GREEN / GREEN |
| Honest scope copy | client :895 / :876 | scope string emptied | RED / RED | GREEN / GREEN |

“client” means `app/lib/usage-dashboard-client.ts` for mobile and
`landing/chat-react/usage-dashboard-client.ts` for web. Twelve mutations total.

### Validation

Targeted files ran in separate processes because the two UI harnesses both
register Happy DOM. Mobile: 25 passed; web: 36 passed; parity: 53 passed.
`bash scripts/ci/lint.sh` and a final ESLint run over the seven changed source/test
files passed. Web leaf typecheck passed. The public-tree leak check reports that
its private PII denylist is unavailable and exits 3 (INCOMPLETE), with zero
findings from the rules that ran. This is not a clean leak-gate result.
`bun run --cwd app typecheck` initially failed on an ambient `@types` lookup.
Restricting lookup to the two local type directories with `--typeRoots
./node_modules/@types,../node_modules/@types` reached an unused directive at
`app/__tests__/support/mount.tsx:17`. Restoring all three changed app files to
HEAD reproduced that exact error; the change was then restored. This is a
baseline failure, not a green mobile typecheck.

Gateway leaf typecheck reports a typed-array assertion mismatch at
`gateway/transcription/__tests__/whisper-install.test.ts:186` and a missing
`crc32` declaration at `onboarding/history-import/__tests__/zip-writer.ts:10`.
Restoring the changed parity test and both clients to HEAD reproduced byte-for-byte
identical gateway diagnostics. All changed files were then restored. No full test
suite was run.

### Scope and deliberately excluded work

The change was enumerated with `git diff --name-only`: the two card components,
the two client helpers, and the three targeted test files, plus this staged record.
No pool-aware credential probe, sidecar writer, schema change, credential
fingerprint, or new outcome enum was added. Historical labelled samples remain
supported; the card’s scope copy describes how samples are collected. This does
not claim that failed probes for other configured credentials are enumerated:
those credentials are explicitly outside the selected single-credential option.

The phrase search was `rg -n 'every connected account|which renders as
"active credential"|null.*active credential'` across the tree, with the known
`app/app/usage.tsx:2` match as its positive control. Live card comments were
corrected. A case-insensitive follow-up also found and corrected the mobile intro
at `app/app/usage.tsx:421`; its positive control was that same known sentence. Other hits were deliberately left: `docs/AS_BUILT.md` is frozen
history; `docs/plans/usage-quota-dashboard-design-2026-08-13.md:864` is a prior
plan; `docs/SYSTEM-OVERVIEW.md:5584` and `open/credential-label.ts:37` retain
older descriptions outside this card change. The older scope claim in
`open/__tests__/usage-dashboard-wiring.test.ts:2` also remains outside the card
tests changed here. Calendar, email and project-account
hits describe different features. These are not evidence of pool-wide probing.

No existing spec-item or SPEC decision was revised: the implementation selects
an alternative already offered by the filed issue. The lane’s explicit as-built
staging path takes precedence over the normal permanent-shard location. The
app guidance asks for online Expo documentation; the lane prohibits network
access, so that lookup was not performed. This change adds no Expo API usage.
