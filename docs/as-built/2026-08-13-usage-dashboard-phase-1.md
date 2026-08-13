# Usage dashboard Phase 1 — every connected account on one screen, and when capacity comes back (2026-08-13)

Phase 1 of `docs/plans/usage-quota-dashboard-design-2026-08-13.md` (§9): widen the
pool vocabulary, carry window LENGTHS per sample, add the Kimi poller, and render
pool cards with account chips, age chips and the stale-pace fix — on both clients.
Phases 2-6 (the spend ledger, the lane writers, the OTLP intake, the waste metric,
the full surface) are untouched.

Plus the two things the owner added after the design was accepted, which are Phase 1
scope rather than a follow-up: **a countdown to when capacity comes back**, and
**that countdown paired with the utilisation of the window it belongs to.**

## Why a countdown is not the pace we already had

Pace answers "at this rate, when do I hit the cap". The owner's question is the
opposite one — "when does capacity come back" — because he is using it as the input
to a throughput decision: whether to raise build concurrency. Both ship. Neither
replaces the other, and the card renders them next to each other.

The first cut of the countdown had a real defect, and fixing it is the interesting
part of this change. **The two windows reset independently.** An account whose
5-hour window resets in 17 minutes but whose 7-day window is 97% spent has almost no
capacity coming back, and a headline reading "next capacity in 17m" would have told
the owner to push concurrency into a wall. So:

- every window's countdown is rendered beside that window's own utilisation, never
  bare;
- an ACCOUNT's standing is the WORST of its windows, not the soonest reset
  (`accountCapacity`, `persistence/usage-samples-store.ts`);
- the pool line names the binding window and the other window's utilisation:
  `Next capacity in 3d 0h (7d window; 5h window 98% used)`.

The acceptance case is pinned twice — in the store (one account with an imminent
5-hour reset and a spent weekly window, one healthy account: the line points at the
SECOND) and in both screens. A mutant that picks the soonest reset while ignoring
the other window turns those red.

## Never optimistic — the rule every refusal follows

Each of these is a place where the plausible implementation renders fine and states
something false, so each is a named test:

- **An absent reset instant renders "unknown"** — never "0m", never "now", never
  omitted. `CapacityStanding` is a tagged union (`available` / `returns` /
  `unknown`) rather than a nullable number precisely so a client cannot collapse
  the two with `if (!ms)`.
- **A STALE reading that says there is room cannot claim availability.** Usage only
  climbs between samples, so "40% used, three hours ago" does not prove there is
  room now; the honest answer is unknown. A stale reading that says SPENT still
  yields a countdown, because "at least this much used" cannot become less used
  inside one window.
- **A window with under 5% headroom counts as spent.** 1% of a weekly window is not
  capacity to push into. Erring this way costs one build routed elsewhere; erring
  the other way costs a wall.
- **Countdowns round UP.** 16m59s rendered as "16m" reports capacity arriving
  sooner than it will.
- **A cap-out projection that has already passed is OMITTED, not dashed.** It can
  only belong to a stale reading, and the card is already saying that much louder
  (floored figure, age chip, capacity unknown); a "Caps out in —" reads as a failed
  computation. The plain duration formatter is gone with it — one formatter, so
  "unknown" and "already past" cannot collapse into one dash.
- **A failed gauge read writes NO row and logs loudly.** Asserted by count with a
  control write proving the counter can move, so "zero rows" cannot be a test that
  never wired the sink.
- **A percent-named field inside `(0, 1]` is refused as ambiguous.**
  `used_percent: 0.85` is either 0.85% or 85%, a factor of 100 apart, and dividing
  by 100 anyway is the optimistic reading — an 85%-spent window painted as a 1% bar
  labelled "available". Refusing writes no sample, and "no readings yet" is the
  honest card.
- **A sub-hour window is named in minutes.** Rounding one to hours prints
  "0h window" — a fabricated zero, in a feature whose doctrine is that a fabricated
  zero must be structurally impossible. Kimi's endpoint can report a length in
  minutes or seconds, so this is reachable rather than theoretical.
- **Every pool has a FINITE staleness deadline, including the one with no cadence.**
  Codex's gauge is harvested from real runs rather than polled; "no cadence" became
  "never stale" in the first cut, which would have let a three-week-old harvested
  reading claim "available now" beside a "21d ago" chip the moment Phase 3's writer
  landed. It gets a flat 30-minute max age instead. The polled pools get their
  cadence plus ONE missed probe of grace, because a failed probe writes no row and a
  zero-grace deadline blanks an account with headroom over a single flaky request.

## Store the instant, render the delta — and NOTHING on the wire is a delta

Reset times are persisted and served as absolute epoch-MS instants; the countdown is
subtracted at paint time against the client's own clock, which ticks every 30
seconds. A stored duration is wrong the moment after it is written, and a cached
"17m" rendered an hour later is a confidently precise lie — the same class of bug as
a stale gauge rendering as fresh.

**The countdown is not the only delta, and the first cut of this branch got the rest
wrong.** The AGE of a reading, whether it is STALE, whether a gauge is a FLOOR and
what CAPACITY an account has are all functions of "now" too, and all four were being
computed when the response was built. Both clients fetch once and hold the payload
between fetches while their own render clocks tick, so a poller dead for six hours
painted as "just now, available" with a live countdown running beside it — the exact
confident-fresh number the brief forbids, and the killed-poller acceptance criterion
defeated in the render even though the store had the right data.

The fix is structural rather than careful. The wire now carries only facts that do
not age — `measured_at`, each window's length and reset instant, the pace and
projection anchored at the measurement, and `stale_after_ms`, a THRESHOLD rather
than a verdict — and `summariseWindow` takes no `now` parameter at all, so the
server cannot bake a delta because it cannot see the clock
(`persistence/usage-samples-store.test.ts`: the same series summarised nine days
apart is identical, with `prune` as the positive control that the clock really did
move). The capacity policy moved WITH the clock into the two clients' `projectPool`,
which the card calls on every paint; it is executed on both copies over the same
payload by `gateway/__tests__/usage-dashboard-client-parity.test.ts`, so every
policy case there is a parity case too. `open/__tests__/usage-dashboard-wiring.test.ts`
greps the SERIALISED composed response for `age_ms` / `stale` / `floor` / `capacity`
(with a positive control on the fields that should be present), because "the store
does not compute it" is a different claim from "the wire does not carry it".

Two consequences worth naming. `CapacityStanding`'s `returns` arm carries an `in_ms`
computed at projection and strictly positive by construction — a window whose reset
has passed is not returning, it has rolled — which makes "capacity in ‹countdown›"
unable to render "capacity in available now" once a card outlives the countdown it
was showing. And an absent `stale_after_ms` decodes to a CAUTIOUS five-minute
default rather than to "never stale": a missing field must make a card more careful,
never less, which is the inverse of the `age_ms ?? 0` this branch used to carry.

Pace moves the other way for the same reason: it is now computed **as of
`measured_at`**, not as of the render clock. Dividing a stale fraction by
elapsed-since-now reports a calmer and calmer burn the longer a writer has been
dead, which is exactly backwards.

## The window LENGTH is data, not a constant

`summariseWindow` used to divide by a hardcoded 5h/7d. That is true of Anthropic and
false in general: Codex changed regime (300 → 10,080 minutes, observed 2026-07-12),
and a historical series straddles it. Migration 0121 adds `session_window_ms` /
`weekly_window_ms`, each sample is summarised with its OWN length, and a pool with no
length reported and no documented default refuses to report a pace rather than
borrowing another provider's constant. Window LABELS follow the same rule — the card
prints "5h window" / "7d window" derived from the length, not a fixed string.

## Per-account retention, and why the key moved

The owner asked, of one specific account, "when it resets in 17m, how much WEEKLY
capacity is left at that time" — and it was unanswerable from stored state. The
hosting layer's rotation state persists a
per-account cooldown instant plus a single `lastProbe` for whichever account was
probed most recently. So Phase 1's store keeps BOTH windows PER ACCOUNT, and a card
can render a non-active account's headroom (with its age) without a live probe.

That required the primary key to carry the account. Under `(ts, pool)` two accounts
of one pool measured in the same millisecond collapsed into one row, and the
`ON CONFLICT DO UPDATE` that makes a double-write idempotent then served the second
account's numbers under the first one's name. 0121 is the standard SQLite
table-rebuild onto `(ts, pool, account_label)`, with `account_label NOT NULL` and an
empty-string sentinel for "nothing can name this account" — a nullable column in a
primary key is not a key (SQLite compares NULL to NULL as unequal), so every
unlabelled row would have been distinct and the idempotency would have silently
stopped working on the ordinary case. The store maps the sentinel back to `null` at
the boundary; nothing above it ever sees an empty string, and it is not a guess — it
is the absence of one, spelled so a key can compare it.

**One known limitation, handled honestly:** multi-account credential rotation does
not exist in this repo (it lives in the hosting layer). So an install here holds one
Anthropic credential and renders one Anthropic card. The surface renders N cards
correctly and N happens to be 1 — no pool is faked, and the single-account path is
not special-cased.

## The Kimi poller, against an endpoint nobody has published

`trident/kimi-usage-probe.ts` reads `GET {KIMI_BASE_URL}/v1/usages`;
`open/kimi-usage-monitor.ts` polls it every 10 minutes on a `SupervisedLoop` armed
unconditionally beside the credential probe, reading the key PER TICK from the
credential store the Settings pane writes (a key that only took effect on the next
restart is the shape that looks broken).

The endpoint's schema is not published and no live response has been printed into
this repo, so **the parser is built to be wrong loudly rather than right by
accident**: a written-down alias set per field, and `unrecognised` — carrying the KEY
NAMES it saw, never values — for anything else. That log line IS the "print a real
value before keying logic on it" step, performed in production instead of skipped:
one occurrence corrects the alias list against reality. An unrecognised payload
writes no row, so the card ages visibly instead of showing a confident zero.

Units are checked rather than trusted, because both slips render as plausible
numbers: a `*_percent` above 100 and a fraction-named field above 1 are refused
rather than clamped, and every reset instant is plausibility-checked against the
clock AFTER conversion — so a seconds value read as ms (1970, which would render as
"available now") and an ms value converted again (year 57,000) both fail loudly.
Window SLOTS are chosen by reported length, never by array position.

Per-key attribution is not offered: the endpoint is account-wide (two keys on one
subscription return identical numbers), so the card is titled "Kimi (account-wide)"
and a response that names no account carries a null label.

## What the surface says, and what it refuses to

Three pools are served every time, in `USAGE_POOLS` order, each with a `connection`
of `connected` / `not_connected` / `no_meter` resolved from the SAME functions the
rest of the product uses. Codex has no writer until Phase 3 and renders
"Not connected." rather than a row of zeros — a connected-and-idle account and an
unconfigured one are different problems with different fixes. A per-token Anthropic
API key is `no_meter`, not "not connected", because telling the owner to reconnect a
working account sends them to fix the wrong thing.

Per provider, in its own unit, never summed: the three meter different things, so a
combined headline would be a number about nothing. **No dollar value appears
anywhere** — the subscription is flat, so a currency figure would assert a marginal
cost the owner does not incur. (The design's cost-weighted column uses list prices
as unrendered WEIGHTS and is Phase 6.)

## What the tests assert, and where

- `persistence/usage-samples-store.test.ts` — the pace maths and every refusal; the
  reset instant travelling as DATA (two reports of the same window 8s apart differ
  by exactly those 8s, and a jittered instant survives the round trip unrounded, so
  nothing rounds it away or keys a decision on equality); a series straddling a
  window-regime change summarised per sample; pace as of measurement; per-account
  retention; the killed poller whose last reading and instant survive; and the
  summary being identical nine days apart, which is the structural form of "nothing
  here is a delta". The capacity policy is NOT tested here any more, because it is
  not computed here any more.
- `trident/__tests__/kimi-usage-probe.test.ts` — the modelled shape, and every
  refusal including both unit slips.
- `open/__tests__/kimi-usage-monitor.test.ts` — gauge-failure-is-loud, by count,
  with a control write.
- `open/__tests__/usage-dashboard-wiring.test.ts` — **against the production
  composer's output.** It boots the real Open composer, takes the handler the
  composition actually carries in `app_usage_surface`, and issues a real request:
  three pools in store order, two cards with windows/pace/countdowns/age, the Codex
  card honestly empty, the connection states, and `kimi-usage` present in the loop
  registry. The composed bytes are then decoded and projected by the SHIPPED web
  client at the render clock, so the assertion is on the sentence the card paints
  ("1 available now") rather than on a restatement of the server's shape — a field
  the client does not read falls to "unknown" there. It also pins `POOL_CADENCE_MS`
  and `POOL_STALE_AFTER_MS` against the pollers' own intervals — constants in two
  packages that cannot import each other, where a poller slowed down without moving
  its cadence would silently mark every reading stale.
- Both screens (`landing/chat-react/__tests__/usage-dashboard-web.test.tsx`,
  `app/__tests__/usage-dashboard-reachable.test.tsx`) press the real components with
  payloads that carry NO verdicts — a stale card is produced by backdating
  `measured_at`, the same lever a dead poller pulls — and
  `gateway/__tests__/usage-dashboard-client-parity.test.ts` executes the twin
  formatters AND the twin projections side by side, including the killed poller
  ageing off one payload.

## Wire-shape change worth naming

`PoolSummary` moved its windows from the pool level onto `accounts[]` and gained
`connection` and `stale_after_ms`. It deliberately does NOT carry `age_ms`, `stale`,
`floor`, `binding`, `capacity` or `resets_in_ms`: every one of those is a delta, and
the section above is why. There is no dual path and no flag: the two clients ship in
this PR. A client older than this one decodes zero accounts and renders its honest
empty state rather than a fabricated reading.
