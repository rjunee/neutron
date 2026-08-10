# Usage dashboard — the endpoint and the web card (2026-08-09)

The series landed the day before and nothing read it. This is the read half:
`GET /api/app/usage/dashboard` plus the Model usage card in web Settings.

## The endpoint went into the EXISTING surface, not a new one

`gateway/http/app-usage-surface.ts` now owns two paths — the live meter it always
owned, and the dashboard. A separate surface would have needed its own composition
field, route slot, gate entry, coverage row and snapshot line, and **a second
near-identical surface is how one of them quietly stops being wired.** Same owner
gate, same subject, one file.

That decision has a cost worth naming: the meter's path is a strict PREFIX of the
dashboard's, so a prefix match in either direction serves the wrong body with a
200 — a wrong answer no client can detect. Both directions are pinned by tests,
and a mutant that prefix-matched the meter killed three of them.

The payload is `{ pools: [...] }` — an array even though exactly one pool exists,
so a second subscription can be reported without changing the shape under a
client that has already shipped.

## What the card refuses to say

Three fields are legitimately null and each has a different honest rendering. All
three are places where the wrong choice still renders and still looks plausible:

- **unreachable route** → no bar at all. An older server does not mount it, and a
  0% bar would invent a measurement.
- **`pace: null`** → an em dash, never `0.0×`. Null means the server declined to
  answer (a barely-started window, or an unknown reset); a zero would read as
  "you are burning nothing", the opposite.
- **`exhausts_at: null`** → the row is OMITTED. Null is the common, GOOD case, and
  a permanent "Caps out in —" trains the eye to hunt for a warning that is
  normally absent.
- **`account_label: null`** → "active credential". The credential is swapped by a
  process outside this instance, so nothing here can know which account a reading
  belongs to. It never guesses.

Band colours come from `@neutronai/contracts/credential-usage.ts`, the same three
tokens the 2px divider meter uses, so the card and the hairline above it cannot
disagree about where amber starts.

## Two guards worth keeping

- **The wiring test now checks BOTH halves separately.** The write assertion
  passed for an entire PR during which nothing read the series. Links in a chain
  are independently absent.
- **A test asserts every `cset-usage-*` class the component emits has a rule in
  `chat-react.html`.** This is the `var(--hairline)` shape — a class that renders,
  is correct, and has no paint behind it. It carries a positive control: if the
  scrape finds no classes the assertion would pass vacuously.
