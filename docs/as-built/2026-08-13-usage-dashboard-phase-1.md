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
  (`accountCapacity`, in both clients: `landing/chat-react/usage-dashboard-client.ts`
  and `app/lib/usage-dashboard-client.ts` — it is a function of the RENDER clock, so
  it lives with the clock and not in the store; see "Store the instant" below);
- the pool line names the binding window and the other window's utilisation:
  `Next capacity in 3d 0h (7d window; 5h window 98% used)`;
- and it names WHICH account it is about (`nextAccountNote`), on a pool with more
  than one, because "when" without "whose" is not yet a routing decision.

The acceptance case is pinned twice — in
`gateway/__tests__/usage-dashboard-client-parity.test.ts`, which runs it through BOTH
clients at once (one account with an imminent 5-hour reset and a spent weekly window,
one healthy account: the line points at the SECOND), and in both screens. A mutant
that picks the soonest reset while ignoring the other window turns those red.

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
- **Countdowns round UP; AGES round DOWN.** 16m59s of countdown rendered as "16m"
  reports capacity arriving sooner than it will. An age is the opposite kind of
  claim — about the past, and exact — so a 61-second-old reading is "1m ago". An
  earlier cut had `formatAge` delegate to the countdown formatter, which printed
  "2m ago" at 61 seconds and skipped "1m ago" entirely.
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

**And the payload is REFETCHED, which is the other half of the same rule.** Moving
the deltas to the paint fixes the lie; on its own it does not fix the data. A screen
that only advanced its clock would walk a perfectly HEALTHY install into staleness:
the Anthropic pool's deadline is two and a half minutes (`60_000 × 2 + 30_000` — the
constant, not a round number in prose), so that soon after the screen opened the card
would floor its gauges to "≥", drop capacity to "unknown"
and stay there for as long as the owner left it up — while the poller behind it wrote
a fresh row every 60 seconds. Ageing a held payload is right across a DEAD poller and
wrong across a live one, and a screen that paints a working install as broken is the
same defect as one that paints a broken install as working. Both screens therefore
poll on `USAGE_POLL_MS` (30s), on the SAME interval that advances the render clock so
the data and the clock it is measured against cannot drift. The parity test bounds
the RELATIONSHIP rather than the number — `USAGE_POLL_MS × 2 < min(POOL_STALE_AFTER_MS)`,
importing the store's own deadlines — so a pool cannot be given a tighter deadline
than the screens can keep up with. Each screen also has a mutation-checked test: a
tick that advances the clock and does not refetch turns them red.

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

**A second, smaller one, pinned by a test rather than hidden.** The label is resolved
by a sidecar outside this process. If it stops resolving, the SAME credential begins
writing rows that name no account, and the series then holds two account keys for one
physical credential — a chip for each, until the older one falls out of retention.
Nothing in the store can tell that from a second account genuinely appearing, so it
does not guess.

**What it costs, stated exactly**, because an earlier draft of this paragraph claimed
the ghost "can never add availability that is not there" and that is FALSE while the
ghost is still fresh. Inside `stale_after_ms` the older row is projected like any
other reading, so one physical credential briefly counts twice and the headline can
read "2 available now" on a pool holding one account. The window is BOUNDED by
`stale_after_ms` (150 s for Anthropic) and closes on its own: past the deadline the
reading floors, its standing falls to `unknown`, and from then on the ghost only ever
subtracts confidence (a "(1 unknown)" suffix). Both halves of that — the transient
double count and the bound that ends it — are pinned by name in
`gateway/__tests__/usage-dashboard-client-parity.test.ts`.

A recency cut-off was considered and refused — it would delete exactly the
non-active-account headroom this store exists to retain, and "no readings yet" about
an account that has readings is a worse sentence than an honest old one.

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

**That plausibility bound is ASYMMETRIC, and it took two cuts to get right.** The
first accepted any instant within ±400 days of now. Downstream, a reset that has
already passed means "the window rolled, this account is free", so a year-old instant
on a 99%-spent window rendered as capacity — the optimistic answer the whole feature
exists to refuse. The second narrowed the past side to ONE WINDOW LENGTH, which was
still too loose by a whole window: a 5-hour window whose reported reset was four
hours in the PAST passed the check, and a 99%-spent account rendered "1 available
now". Against an unpublished schema that is exactly what a `reset`/`reset_time` field
carrying the window's START would produce.

Each side is now measured in the thing that actually bounds it:

- the PAST side is CLOCK SKEW and nothing more (`RESET_PAST_TOLERANCE_MS`, five
  minutes). For a rolling window of length L the current window's reset is in
  `(now, now + L]`, so the only legitimate past instant is the one that rolled
  moments ago — bounded by latency and skew, which do not grow because the window is
  longer. Scaling that allowance with the window is precisely what let five hours
  absorb four hours of "skew";
- the FUTURE side is ONE WINDOW LENGTH, scaled, because that is where window length
  genuinely applies — a rolling window resets within its own length. Window length is
  not a constant, so the same instant that is implausible for a 5-hour window is
  ordinary for a 7-day one, and a test pins both directions. `RESET_FUTURE_PLAUSIBILITY_MS`
  survives only as the backstop for an absurd reported length.

A refused instant leaves `reset_at` null, which renders as "unknown" — the honest
answer, and the one the acceptance case pins.

**A PARTIAL read is a refusal, not a smaller answer.** An earlier cut dropped the
entries it could not parse and returned `ok` with whatever it understood — which is
the confident-zero failure wearing a different hat, because nothing downstream can
tell a sample carrying one window from a provider that only HAS one window. An
account whose weekly figure was dropped would render as an account with no weekly
limit, so a 99%-spent week became "Next capacity in 40m (5h window)". So a single
unreadable entry — an unmodelled shape, a missing length, or a second window landing
in an already-filled slot — makes the WHOLE response `unrecognised`, no row is
written, and the key names go out so one real response corrects the alias list.
`observedKeys` reports every element of the list rather than the first, because the
entry that fails to parse is rarely the first one.

**And "all" means BOTH SLOTS, which the first version of that rule missed.** A
response listing ONE window read cleanly: nothing was unreadable, so it returned `ok`
with `weekly: null` — byte-for-byte the wire shape the dropped-window case produces,
and the same wall. `{session: 20%, weekly: null}` rendered "1 available now" with zero
unknowns; `{session: 99%, resets in 40m, weekly: null}` rendered the bare "Next
capacity in 40m (5h window)" — the verbatim failure string this document already
named as the thing the design prevents. The endpoint reports both standings, so one of
them is a shape this parser does not model, and `KimiUsageSample.session`/`weekly` are
now NON-NULLABLE: the invariant is a type rather than a habit, and no caller holds
half a reading or needs a branch for one.

**The clients refuse the same reading independently**, which is the half that does not
depend on any one writer being right — see "half a reading buys no standing" below.

Per-key attribution is not offered: the endpoint is account-wide (two keys on one
subscription return identical numbers), so the card is titled "Kimi (account-wide)"
and a response that names no account carries a null label.

## What the surface says, and what it refuses to

Three pools are served every time, in `USAGE_POOLS` order, each with a `connection`
of `connected` / `not_connected` / `no_meter` / `unreadable` resolved from the SAME
functions the rest of the product uses. Codex has no writer until Phase 3 and renders
"Not connected." rather than a row of zeros — a connected-and-idle account and an
unconfigured one are different problems with different fixes. A per-token Anthropic
API key is `no_meter`, not "not connected", because telling the owner to reconnect a
working account sends them to fix the wrong thing.

Per provider, in its own unit, never summed: the three meter different things, so a
combined headline would be a number about nothing. **No dollar value appears
anywhere** — the subscription is flat, so a currency figure would assert a marginal
cost the owner does not incur. (The design's cost-weighted column uses list prices
as unrendered WEIGHTS and is Phase 6.)

## Half a reading buys no standing

`accountCapacity` (both clients) refuses to project ANY capacity for an account with
only one of its two windows measured. "The worst of the windows I can see" is only
safe when what is absent is nothing, and `weekly: null` is not a measured zero — it
is the absence of a measurement, indistinguishable from a provider with no weekly
limit, a parser that dropped the entry, or a sample predating the column.

The two shapes it was reproduced in: `{session: 20%, weekly: null}` rendered
"1 available now" with `unknown: 0`, and `{session: 99%, resets in 40m, weekly: null}`
rendered the bare "Next capacity in 40m (5h window)". That is the same defect as
naming the soonest reset while ignoring the other window, reached by the other road —
not by mis-ranking two windows, but by ranking one and reporting it as the pair.

**The rest of the card is untouched.** The measured window keeps its figure, its bar,
its pace and its own countdown; the missing one already rendered "not reported". Only
the capacity CLAIM is withheld, because that is the single output that requires both.
And the withholding is LOUD rather than merely quiet: the chip reads
"capacity unknown — one window not reported", so "capacity unknown" beside a
full-looking bar cannot be mistaken for a glitch.

This is deliberately redundant with the Kimi parser's both-slots rule. One is a
refusal at the writer and one at the renderer, and neither depends on the other being
right — the store's shape cannot express "measured as absent", so the renderer has to
be safe against any writer, present or future.

## Three smaller honesty fixes in the same pass

**The staleness deadline now budgets for the client's poll hold.** The deadline is
checked on the CLIENT against a payload it refetches every `USAGE_POLL_MS` (30 s), so
a written row can be up to one poll away from being on screen. Budgeting cadence × 2
alone spent the grace twice: rows at t=0, t=60 and t=180 (one missed probe at t=120)
against a 120 s deadline painted the card stale from t=181 until the next fetch landed
the t=180 row — ~29 s of "stale" on an install that had already recovered, falsifying
the property the arrangement exists for. `POOL_STALE_AFTER_MS` is now
`cadence × 2 + CLIENT_POLL_BUDGET_MS`; `persistence` cannot import a client, so the
budget is held equal to `USAGE_POLL_MS` by the wiring test rather than by an import.
Two consecutive misses still cross it, which is the half a bigger grace would give
away.

**The client's fallback staleness deadline is tighter than every real one.** It is
used only on version skew, when the payload omits the threshold, and it was five
minutes — 2.5× LOOSER than Anthropic's real 120 s, so the "cautious" default was the
loosest number on the screen and a five-minute-old reading painted fresh and
non-floored. It is now 60 s: below the tightest deadline the store ships, and still
twice the poll interval, with the relationship pinned by the parity test rather than
the number.

**`formatCountdown` and `formatAge` fold a non-finite input into their absent arm.**
Every production caller was traced and none can produce one today, but these are
exported policy functions and the failure would be silent and total: `NaN` walks
through every comparison and prints "NaNd NaNh", which is neither a countdown nor an
admission that there is none. One comparison makes the bad render unreachable rather
than merely unreached.

## "Asked and refused" is not "no readings yet"

A fourth `connection` value, `unreadable`, and it is the one that does not resolve
itself. "No readings yet." promises a first reading is coming; when the gauge has
been asked and its answer refused — a rejected key, a non-auth 4xx from a path this
build has wrong, or a payload shape it does not model — none is. Kimi's usages schema
is unpublished, so that is the realistic first-install failure, and without this the
card would say "No readings yet." forever while the poller logged the key names to a
file nobody is watching.

**It is decided by the live probe, never by a credential file, and on BOTH pools that
have a writer.** `resolveActiveCredential` answers "is a credential present", which is
a different question from "does upstream still accept it" and performs no validity
check — so a revoked Anthropic token resolved as present forever while its 401 dropped
the cache and wrote no sample, leaving the ONE pool with a shipping writer stuck on a
sentence promising a reading that could never arrive. So the composer reads
`CredentialUsageMonitor.readStanding()` for Anthropic and
`KimiUsageMonitor.readStanding()` for Kimi, PER REQUEST and never latched into a
sample, so a card recovers the moment a tick succeeds. A transient failure — dropped
packet, timeout, 5xx — stays `connected` on both, because the next tick retries and a
dropped packet must not repaint the card as broken.

**The sentence is a banner above the rows, not a replacement for them.** Samples are
retained thirty days, so the refusal that actually happens is not an empty pool — it
is a pool that read fine for a week and then had its key rotated or its schema shift
underneath it. Gated on the card being empty, that card kept its figures, kept ageing
its chips, and said nothing about the fact that no reading would ever replace them.
The last known values keep rendering with their age chips beside the note; an empty
refused card still shows NO number: loud and empty, never a zero.

Two wiring tests prove it end to end against the production composer, each with a
positive control that a pool nobody asked is not reported unreadable —
`open/__tests__/usage-dashboard-unreadable-wiring.test.ts` against a loopback server
answering 200 with an unmodelled body, and
`open/__tests__/usage-dashboard-lapsed-wiring.test.ts` against one answering 401 with
a subscription token on disk. A hand-built `connection: 'unreadable'` literal would
prove only that a test file can write one.

## The one thing this phase still cannot demonstrate

**The Kimi alias list has never been checked against a real response**, and no
mechanism inside this repo can check it: the endpoint is undocumented upstream and no
live body has been printed here. The direction is safe — every unmatched field yields
`unrecognised`, which writes no row — but the honest reading of Phase 1's stated
acceptance ("two populated cards") is that the Kimi card will most likely render an
empty state on a real install until the alias list is corrected.

What this build does about it, given it cannot fix it:

- the refusal carries the KEY NAMES it saw (never values) into a log line, so ONE
  real response is enough to correct the list — the "print it before keying logic on
  it" step performed in production instead of skipped;
- the empty card now says the gauge was asked and refused, rather than implying a
  first reading is on its way, so the owner discovers it at a glance instead of
  waiting on it;
- nothing is fabricated in the meantime.

Correcting the alias list from that log line is a one-line follow-up and is
deliberately NOT guessed at here.

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
  refusal including both unit slips, both sides of the asymmetric reset bound (a
  four-hour-old reset refused on a 5-hour AND a 7-day window; a two-day-out reset
  refused on the 5-hour one and believed on the weekly one, with a positive control
  so the pair cannot pass on a parser that refuses everything), and a one-window
  response refused in both directions.
- `open/__tests__/kimi-usage-monitor.test.ts` — gauge-failure-is-loud, by count,
  with a control write; and the read standing, including a permanent non-auth 4xx
  reported as a refusal and the control that a transport error is NOT.
- `open/__tests__/credential-usage-monitor.test.ts` — the Anthropic standing the card
  reads: null before the first tick, `healthy` on a good read, `lapsed` on a 401, and
  `indeterminate` on a dropped packet, plus the case that a throwing standing observer
  does not cost the card the fact that the credential was rejected.
- `auth/__tests__/credential-usage-probe.test.ts` — the reset plausibility bound, on
  both sides, with the control that an instant a minute in the past (a window that
  just rolled) is still believed.
- `open/__tests__/usage-dashboard-lapsed-wiring.test.ts` — **against the production
  composer's output.** A subscription token on disk and a loopback server answering
  401: the composed payload reports `unreadable` for the Anthropic pool, still with no
  accounts and no `measured_at`, and the sentence comes from the shipped client. The
  mutant it kills is deriving "connected" from the credential file.
- `open/__tests__/usage-dashboard-unreadable-wiring.test.ts` — **also against the
  production composer's output.** The sibling wiring test points the poller at a
  CLOSED port, so it can only ever produce a transport error; this one boots the real
  composer against a loopback server that ANSWERS with an unmodelled body and asserts
  the composed payload's `connection`, the empty accounts beside it, the sentence the
  shipped client renders from it, and a positive control that a pool nobody asked is
  not reported as unreadable.
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
  ageing off one payload, the half-measured account refused in both directions with a
  positive control, and the lapsed-label ghost counted twice INSIDE the staleness
  window and only subtracting after it. It also pins the two headroom tie-breaks (the
  roomier of two AVAILABLE accounts headlines the pool, asserted with the payload in
  both orders so a fix that simply took the last account goes red), the spent boundary
  at exactly 95%, and a window that rolled between measurement and paint rendering
  "just reset" rather than at its pre-roll percentage. Both screens additionally assert
  that a REFUSED pool which already has readings shows the figures AND the sentence,
  with a control that a healthy pool carries no banner.

## Wire-shape change worth naming

`PoolSummary` moved its windows from the pool level onto `accounts[]` and gained
`connection` and `stale_after_ms`. It deliberately does NOT carry `age_ms`, `stale`,
`floor`, `binding`, `capacity` or `resets_in_ms`: every one of those is a delta, and
the section above is why. `connection` gained a fourth value, `unreadable`; an older
client decodes an unknown value as `connected`, which is the honest degradation — it
says nothing rather than blaming the owner's setup. There is no dual path and no flag: the two clients ship in
this PR. A client older than this one decodes zero accounts and renders its honest
empty state rather than a fabricated reading.
