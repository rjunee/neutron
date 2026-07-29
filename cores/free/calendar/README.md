# @neutron/calendar-core

Tier 1 free Calendar Core for Neutron. Wraps Google Calendar v3 and
surfaces five MCP tools:

- `calendar_list` — list events within a time window, ordered
  chronologically ascending from `range_start` (forward-looking)
- `calendar_create` — create an event
- `calendar_update` — patch one or more fields on an event
- `calendar_cancel` — cancel/delete an event
- `calendar_brief` — return a structured pre-meeting brief
  (title, attendees, duration, agenda parsed from description,
  prior-context stub)

Bundled into the public OSS repo at `cores/free/calendar/` per the
locked 2-tier Cores model
(`docs/research/neutron-cores-marketplace-split-2026-05-17.md`).

## Install

The runtime composer installs this Core automatically when the
bundled-Core registry boots from a root that includes `cores/free/*`
(multi-root mechanic shipped in PR #139). On install the lifecycle:

1. Validates the manifest (Sprint 24 `parseManifest`).
2. Prompts for the Google Calendar OAuth access token (manifest
   declares `secrets[0] = { kind: 'oauth_token', label:
   'google_calendar', scope: '...calendar', required: true }`).
   Missing-token abort surfaces as `CoreInstallError(code:
   'manifest_invalid')`.
3. Persists the access token (and optional expiry) via the audited
   platform `SecretsStore`.
4. Allocates a `tables`-layout namespace (the Core has no sidecar —
   persistence delegates to Google; no `.db`-suffixed capability).
5. Registers the five MCP tools, each capability-guarded by Sprint
   31's `CapabilityGuard.wrapToolHandler`.

The launcher icon surface (`ui_components[0]`) is manifest metadata
only at v1; the actual launcher tab lands in P5.3.

## OAuth notes (v1 substrate)

The Core does NOT drive a Google consent screen. It declares the
secret in its manifest and trusts the runtime composer to materialize
a live access token before each request. The production wrapper
(`buildGoogleCalendarClient`) takes a lazy
`accessToken: () => Promise<string | null>` accessor so the composer
can refresh out-of-band. Missing token surfaces as `OAuthMissingError`
— the composer interprets this as "re-prompt for OAuth consent".

Full Google consent + refresh-token plumbing is a follow-up sprint
(blocked by the substrate-side Google OAuth flow the owner flagged as
non-trivial in the brief). For early dogfood, the operator can paste
an access token through the `SecretsPrompter`'s `promptOauthToken`
implementation.

## Behaviour notes

- **Ordering.** `calendar_list` returns chronological ascending from
  `range_start`. Distinct from the Notes / Tasks ordering convention
  (newest-first by `created_at`) — meetings are forward-looking.
- **Recurring events.** Server-side expanded via Google's
  `singleEvents=true`. The Core does not re-implement RRULE.
- **Default `calendar_id`.** `'primary'` — Google's convention for the
  authenticated user's main calendar.
- **Pagination.** The Google list path follows `nextPageToken` up to 20
  pages (bounded to avoid runaway on pathological calendars), so a
  first page saturated with overlap rows that get dropped client-side
  doesn't starve the result set.
- **All-day events.** Google all-day events set `start.date` (calendar-
  LOCAL `YYYY-MM-DD`, no offset). The v1 filter coerces them to
  midnight UTC for the instant-based window compare — calendar-
  timezone-aware filtering is out of scope for v1 and revisited when a
  customer surfaces a non-UTC calendar use-case in onboarding. The
  off-by-up-to-14h edge case is a known imperfection at the timezone
  boundary; the practical hit rate is low (most all-day events
  unambiguously belong to a date that lies entirely inside or entirely
  outside a typical query window).

## Testing

```
bun test cores/free/calendar
```

Tests use the bundled in-memory `CalendarClient`, so the suite never
reaches Google. The production wrapper (`buildGoogleCalendarClient`)
is only exercised by integration tests outside this directory.

## Not wired this sprint

- **Production-side bundled-registry wiring.** `buildBundledRegistry`
  has no production call site yet — adding `cores/free/calendar` to a
  default Open bundled-roots array would have nothing to wire into.
  Wiring lands in the follow-up sprint that boots the registry from
  `gateway/composition.ts`.
- **Full OAuth consent / refresh-token flow.** The Core defers to the
  runtime composer for token materialisation.
- **Push for calendar reminders** (P5.6).
- **Calendar tab UI in app** (P5.4 / P5.5).
- **Non-Google calendars** (Tier 2 paid `@neutron-paid/calendar-private`).
