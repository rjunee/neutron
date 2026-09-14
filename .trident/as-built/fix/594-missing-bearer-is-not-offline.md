## 2026-09-14 — Project refresh failures no longer look offline

### What changed

The gateway client already attaches the session header to every project request (`app/lib/projects-client.ts:287-318`) and preserves transport failures as `network` or `timeout` while retaining server-supplied error codes (`app/lib/projects-client.ts:319-350`). The reported header loss occurs when a health probe follows a cross-origin redirect: the platform removes the session header on the later authenticated redirect, which produces `missing_bearer`; the upstream correction stores the health probe's settled origin (`app/lib/server-url.ts:293-297`, `app/lib/server-url.ts:377-394`).

The remaining defect was downstream state handling: the rail refresh sent every rejection through one catch branch and reset the list. It now sends every result through an explicit refresh-state vocabulary (`app/lib/projects-refresh-state.ts:4-46`) and renders a visible notice for retained data or a failure (`app/app/projects/[id]/_layout.tsx:285-311`, `app/app/projects/[id]/_layout.tsx:729-744`, `app/components/ProjectRail.tsx:339-349`). A successful response replaces the list as `fresh`; a `network` or `timeout` failure with a prior fetched list deliberately retains it as `cached` with “showing saved projects”; all server and unknown failures become `failed`. A missing or rejected credential gets session-specific failure copy and the alert accessibility channel (`app/lib/projects-refresh-state.ts:29-46`, `app/components/ProjectRail.tsx:341-348`).

### Decision and outcome vocabulary

No new client error code was added. The result joins the existing `ProjectsClientError.code` vocabulary: transport failures are created as `network`/`timeout`, and HTTP response codes such as `missing_bearer` pass through from the server (`app/lib/projects-client.ts:319-350`). The rail consumer recognizes only the two transport codes as eligible for cache service; every other code and every untyped error defaults to surfaced `failed` (`app/lib/projects-refresh-state.ts:25-46`). The other complete runtime consumer found by enumerating `fetchProjects(` under `app/app` and `app/lib` is launch routing (`app/lib/entry-route.ts:67-76`); it continues to send failed launch-time discovery to General, where the rail performs its own visible refresh. The same enumeration's positive control found the known rail call at `app/app/projects/[id]/_layout.tsx:301`.

The refresh-state transition continuously maintains the distinction independently of the failing request: only a typed transport code plus non-empty previously fetched data can enter `cached` (`app/lib/projects-refresh-state.ts:29-38`). The rendered state is passed directly to the rail notice (`app/app/projects/[id]/_layout.tsx:734-740`), so the failed requester need not recover before the user can see the outcome.

### Mutation evidence

| Guard | Mutation | Red evidence | Restored evidence |
|---|---|---|---|
| Cache eligibility at `app/lib/projects-refresh-state.ts:29-33` | Added `error.code === 'missing_bearer'` to the printed condition at line 32 | `bun test app/__tests__/projects-refresh-state.test.ts` failed: expected `failed`, received `cached` at `app/__tests__/projects-refresh-state.test.ts:46` | Restored the two transport codes; 5 pass, 0 fail |

The state suite also proves a real network failure retains the identical prior list, an initial offline failure cannot invent an empty cache, success replaces old data, and unknown failures take the surfaced default (`app/__tests__/projects-refresh-state.test.ts:29-61`). The real rail render proves cache and failure notices are visible and that failure uses the alert role (`app/__tests__/rail-idle-dot-not-painted.test.tsx:86-110`).

### Verification

- `bun test app/__tests__/projects-refresh-state.test.ts app/__tests__/projects-fetch.test.ts app/__tests__/rail-idle-dot-not-painted.test.tsx` — 17 pass, 0 fail.
- `bun run --cwd app typecheck` — green.
- Targeted Expo lint for the five touched source and test files — green.
- Package-wide Expo lint reaches one unchanged base-branch error at `app/app/projects/[id]/cores/dtc-analytics.tsx:279`; the file has no diff from `origin/main`, and `git show origin/main:app/app/projects/[id]/cores/dtc-analytics.tsx` shows the same line.

### Deliberately not changed

The settled-origin fix was not duplicated or altered because it is already upstream of the request and covered at `app/__tests__/server-url.test.ts:733-793`. Launch-time offline routing remains General (`app/lib/entry-route.ts:62-76`), and the existing project-list endpoint, header attachment, timeout, and server error vocabulary were not changed (`app/lib/projects-client.ts:229-243`, `app/lib/projects-client.ts:287-360`). No product decision in `SPEC.md` or a spec item changed.
