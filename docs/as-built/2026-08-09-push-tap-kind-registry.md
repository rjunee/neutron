# Every push kind the gateway sends now routes on tap

**Landed:** 2026-08-09 · **ISSUES:** #520 · **Surface:** `wire-types/push-kind.ts`, `app/lib/push-deep-link-dispatch.ts`

## What the owner saw

> "when I tap on a push notification, it opens the app, but it doesn't open in the
> right project and at the unread message marker like it should."

## Why

The gateway picks a `kind` when it builds a push; the mobile client switches on
that string to decide where the tap lands. The two lists were written
independently and had drifted until they were **disjoint except for one entry**:

| SENT by the gateway | KNOWN to the tap resolver |
|---|---|
| `reminder` | `reminder` ← the only overlap |
| `calendar_pre_meeting_brief` | `wow_fired` ← no sender, ever |
| `email_daily_triage` | `agent_message` ← no sender, ever |

So a pre-meeting brief or an email triage hit the resolver's "unknown kind"
branch — warn, return null, nothing routes. Meanwhile two of the three kinds the
client handled carefully could never arrive.

**Neither side's tests could see it.** The dispatcher's tests assert the payload it
builds; the resolver's tests assert the payloads they hand it. Both were green and
their union was broken — the gap lived in the space between two files that never
met.

## The fix

`wire-types/push-kind.ts` owns `PUSH_KINDS` plus a named constant per kind, and
the three senders now import those constants instead of writing string literals.
The resolver learned the two Core kinds. `app/__tests__/push-kind-coverage.test.ts`
walks `PUSH_KINDS` and requires a route for each — **add a kind and forget the
client, and CI reds.** It also asserts the fixture table matches `PUSH_KINDS`
exactly, so a kind cannot be silently skipped by a loop that never sees it.

`wow_fired` and `agent_message` have no senders (grep-verified). Their branches are
LEFT IN PLACE with their tests — removing tested behaviour is a separate cleanup,
not something to slip into a routing bugfix — and both are deliberately absent from
`PUSH_KINDS`, so the exhaustiveness list covers only what is genuinely sent and
cannot be padded by a kind no gateway emits.

A Core push with no `project_id` still warns and refuses rather than falling back
to `project_slug`, which is the OWNER slug: routing to `/projects/<owner>/…` would
open a project that does not exist and read as a routing bug rather than a payload
bug.

`@neutronai/wire-types` had to be added to `gateway`'s dependencies — the senders
could not import the shared list at all without it.

## Not fixed here

The **unread-marker** half of the report. Routing now lands on the right project's
chat; where that chat opens scroll-wise is the chat surface's own behaviour and is
not touched by this change.

Mutants killed: removing the two Core routes reds 4; dropping a kind from the
shared list reds the fixture-coverage assertion.
