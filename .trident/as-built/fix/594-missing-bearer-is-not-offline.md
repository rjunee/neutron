## 2026-09-14 — Project refresh failures no longer look offline

### What changed

The gateway client already attaches the session header to every project request (`app/lib/projects-client.ts:287-318`) and preserves transport failures as `network` or `timeout` while retaining server-supplied error codes (`app/lib/projects-client.ts:319-350`). The reported header loss occurs when a health probe follows a cross-origin redirect: the platform removes the session header on the later authenticated redirect, which produces `missing_bearer`; the upstream correction stores the health probe's settled origin (`app/lib/server-url.ts:293-297`, `app/lib/server-url.ts:377-394`).

The remaining defect was downstream state handling: the rail refresh sent every rejection through one catch branch and reset the list. It now sends every result through an explicit refresh-state vocabulary (`app/lib/projects-refresh-state.ts:4-8`) and renders a visible notice for retained data or a failure (`app/app/projects/[id]/_layout.tsx:292-311`, `app/app/projects/[id]/_layout.tsx:738`, `app/components/ProjectRail.tsx:341-349`). A successful response replaces the list as `fresh`; a `network` or `timeout` failure with a prior fetched list deliberately retains it as `cached` with “showing saved projects”; all server and unknown failures become `failed`. A missing or rejected credential gets session-specific failure copy and the alert accessibility channel (`app/lib/projects-refresh-state.ts:40-61`, `app/components/ProjectRail.tsx:341-348`).

### Decision and outcome vocabulary

No new client error code was added. The result joins the existing `ProjectsClientError.code` vocabulary: transport failures are created as `network`/`timeout`, and HTTP response codes such as `missing_bearer` pass through from the server (`app/lib/projects-client.ts:319-350`). The rail consumer recognizes only the two transport codes as eligible for cache service; every other code and every untyped error defaults to surfaced `failed` (`app/lib/projects-refresh-state.ts:40-61`). The other complete runtime consumer found by enumerating `fetchProjects(` under `app/app` and `app/lib` is launch routing (`app/lib/entry-route.ts:67-76`); it continues to send failed launch-time discovery to General, where the rail performs its own visible refresh. The same enumeration's positive control found the known rail call at `app/app/projects/[id]/_layout.tsx:302`.

The refresh-state transition continuously maintains the distinction independently of the failing request: only a typed transport code plus non-empty previously fetched data can enter `cached` (`app/lib/projects-refresh-state.ts:43-53`). The rendered state reaches the rail through one pinned mapping (`app/lib/projects-refresh-state.ts:17`, called at `app/app/projects/[id]/_layout.tsx:738`), so the failed requester need not recover before the user can see the outcome.

### Mutation evidence

Every patch was printed with the line it landed on and the file diffed before the run.

| Guard | Mutation | Landed | Red evidence | Restored |
|---|---|---|---|---|
| Cache eligibility — a missing bearer must not be served as offline | dropped the transport-code test from the cache condition | `app/lib/projects-refresh-state.ts:44` | expected `failed`, received `cached` | 5 pass |
| The OTHER direction — a genuine offline must STILL serve cache | `previous.projects.length > 0` -> `false` | `app/lib/projects-refresh-state.ts:43` | expected `cached`, received `failed` | 5 pass |
| The rail renders the distinction | notice element disabled | `app/components/ProjectRail.tsx:341` | both render cases red | 10 pass |
| THE WIRE between the state and the rail | mapping returns `null` for every state | `app/lib/projects-refresh-state.ts:20` | 2 red | 8 pass |
| Cached and failed arrive wearing the same badge | mapping stamps `kind: 'cached'` for both | `app/lib/projects-refresh-state.ts:21` | expected `failed`, received `cached` | 8 pass |

THE FOURTH ROW IS WHY THIS FILE GAINED A FUNCTION. The screen originally computed the
rail's notice with an inline ternary. Severing it — `notice={false ? … : null}` at
`app/app/projects/[id]/_layout.tsx:738` — left the ENTIRE app suite unchanged, 1798
pass / 177 fail before and after: a state no test could prove any component reads. The
mapping now lives at `app/lib/projects-refresh-state.ts:17` and is pinned directly, and
the screen is a one-line call.

The state suite also proves a real network failure retains the identical prior list, an
initial offline failure cannot invent an empty cache, success replaces old data, and
unknown failures take the surfaced default (`app/__tests__/projects-refresh-state.test.ts:29-61`).
The real rail render proves both notices are visible, that failure uses the alert role,
and — the control that must survive alongside them — that a FRESH refresh renders
neither testID (`app/__tests__/rail-idle-dot-not-painted.test.tsx:86`). Without that
control, a rail that had stopped rendering notices at all would still satisfy every
other assertion in the file.

### Verification

- `bun test app/__tests__/projects-refresh-state.test.ts app/__tests__/projects-fetch.test.ts app/__tests__/rail-idle-dot-not-painted.test.tsx` — 24 pass, 0 fail.
- Running the whole of `app/__tests__/` in ONE process fails 177 tests on this branch and 175 on `origin/main`; the rail render files fail wholesale there in both. That instrument is not measuring this change — CI shards through `scripts/run-tests.sh`, which is the run that counts.
- `bun run --cwd app typecheck` — green.
- Targeted Expo lint for the five touched source and test files — green.
- Package-wide Expo lint reaches one unchanged base-branch error at `app/app/projects/[id]/cores/dtc-analytics.tsx:279`; the file has no diff from `origin/main`, and `git show origin/main:app/app/projects/[id]/cores/dtc-analytics.tsx` shows the same line.

### The strip has to be able to SHOW it

The first draft rendered the whole sentence into the rail. The rail is 72 points wide
(`app/components/ProjectRail.tsx`, `RAIL_WIDTH = 72`) at caption size 11
(`app/lib/theme.ts:219`) — about eleven characters a line. "Projects could not refresh
because your session was not accepted. Sign in again." would have rendered as a tower of
two-letter lines above the project list, on the device the owner uses daily. The render
test could not see it: `textContent` contains the sentence whether it lays out as one
line or as thirty.

So each outcome now carries a LABEL the strip can render on one line — `Offline`,
`Sign in`, `No refresh` — and the sentence travels on `accessibilityLabel`, where the
length is free. A rejected session and an unreachable server keep different words,
because the remedies differ. The bound itself is a constant, `MAX_RAIL_LABEL_CHARS`
(`app/lib/projects-refresh-state.ts:17`), asserted for every outcome — a bound that only
lives in a reviewer's head is not a bound.

| Mutation | Landed | Red evidence | Restored |
|---|---|---|---|
| the strip renders the sentence again | `app/components/ProjectRail.tsx:353` | both render cases red | 9 pass |
| every outcome shares one label | `app/lib/projects-refresh-state.ts:76` | the differing-labels case red | 11 pass |
| a label too long for the strip | `app/lib/projects-refresh-state.ts:76` | the one-line bound red | 11 pass |

### Symptom site or root cause — plainly

THIS IS A FALLBACK-SITE CHANGE, and that is the right place for it. The root cause of the
reported failure — the platform dropping the Authorization header across a cross-origin
redirect, so the server answered `missing_bearer` while the client held a valid token —
was already fixed upstream and is on `main` (`app/lib/server-url.ts:293-297`,
`:377-394`, covered at `app/__tests__/server-url.test.ts:733-793`). What was NOT fixed is
that the screen could not tell the owner which of three things had happened. A refresh
that could not find out was rendered identically to one that had an answer, and the
filed issue says in its own words that no static read can settle whether the upstream fix
was the cause. This change does not claim to settle it either; it makes the next
occurrence legible on the device instead of silent, which is the only thing that can.

### Not verified, and worth its own issue

There is NO persisted projects list across app launches — `grep -rn 'AsyncStorage|persist'`
over `app/lib/projects.ts` and `app/lib/projects-rail-live.ts` finds nothing, and nothing
under `app/lib/` remembers a list. `cached` is therefore reachable only WITHIN a session,
after at least one successful fetch. A cold launch with no network shows `No refresh`,
never `Offline — showing saved projects.` That is not a regression — nothing was persisted
before either — but the state's name promises more than the app can currently deliver.

The filed issue's own acceptance is a live sign-in on the reporter's device. Nothing here
establishes that, and this record does not claim it.

### Deliberately not changed

The settled-origin fix was not duplicated or altered because it is already upstream of the request and covered at `app/__tests__/server-url.test.ts:733-793`. Launch-time offline routing remains General (`app/lib/entry-route.ts:62-76`), and the existing project-list endpoint, header attachment, timeout, and server error vocabulary were not changed (`app/lib/projects-client.ts:229-243`, `app/lib/projects-client.ts:287-360`). No product decision in `SPEC.md` or a spec item changed.
