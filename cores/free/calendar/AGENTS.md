# AGENTS.md — cores/free/calendar

This directory is the Tier 1 free Calendar Core (`@neutron/calendar-core`).
It surfaces a launcher icon + five MCP tools (`calendar_list`,
`calendar_create`, `calendar_update`, `calendar_cancel`,
`calendar_brief`) wrapping Google Calendar v3, per the locked 2-tier
Cores model
(`docs/research/neutron-cores-marketplace-split-2026-05-17.md`).

It must NOT:

- Re-implement OAuth consent / token exchange. The Core declares the
  `google_calendar` `oauth_token` secret in its manifest; the runtime
  composer drives the prompt at install time and resolves a live
  access token via the per-Core `SecretsAccessor` at request time.
- Make real network calls in tests. The bundled
  `buildInMemoryCalendarClient` is the only backend the test suite
  uses; `buildGoogleCalendarClient` is the production wrapper and is
  exercised only by integration tests outside this directory.
- Add a top-level `googleapis` dependency. The v3 REST surface the
  Core uses is small; a hand-rolled `fetch`-based wrapper avoids
  pulling the ~5MB transitive `googleapis` tree into Tier 1.
- Reach into other Cores' namespaces. The Core has no sidecar SQLite
  (capabilities are `read:/write:calendar_core.events`, not
  `.db`-suffixed) — persistence lives at Google.
- Promote launcher UI beyond manifest metadata. The actual React/RN
  icon component ships in P5.3.

Out-of-scope this sprint:

- Tier 2 Calendar-Private variant (Outlook / iCloud / open-weight
  alternatives) — separate `@neutron-paid/calendar-private` Core.
- Push notifications + reminder scheduling — P5.6.
- Calendar tab UI in app — P5.4 / P5.5.
- Calendar ↔ Task auto-sync — separate sprint.
- Recurring-event expansion logic (we pass `singleEvents=true` to
  Google and rely on server-side expansion).
- Conflict-detection / scheduling-assistant features.
- Real OAuth consent screen plumbing. The wrapper accepts a lazy
  `accessToken: () => Promise<string | null>` accessor; the runtime
  composer (P3+) wires it to the SecretsAccessor. The OAuth flow
  itself (Google consent, refresh-token exchange) is a follow-up
  sprint when an end-to-end onboarding test needs it.

Cross-refs:

- `SPEC.md § Phases→Steps` — Tier 1 Cores buildout
- `cores/sdk/SDK-CONTRACT.md` — author-facing API
- `cores/runtime/` — install / capability gating / audit log
- `cores/free/notes/AGENTS.md`, `cores/free/tasks/AGENTS.md` —
  sibling Tier 1 Cores; same scaffolding pattern.
