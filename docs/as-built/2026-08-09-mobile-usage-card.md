# Model usage on the phone (2026-08-09)

The web card shipped a day earlier and the phone had nothing. ☰ → Settings →
**Model usage**: the same two windows, the same pace, the same refusals.

## Two wiring points that fail independently

A screen needs BOTH a nav row in `settings.tsx` AND a `<Stack.Screen>` in
`_layout.tsx`. A registered route nothing pushes is the ISSUES #385 defect; a
pushed route nothing registers is a dead tap. Both are present and the screen test
presses the real controls.

## What the twin does NOT duplicate

A first draft re-declared `usageBand` and `clampFraction` on the phone, with a
docblock justifying it by bundle independence. **`app/components/UsageMeter.tsx:20`
already imports both from `@neutronai/contracts/credential-usage.ts`**, so that
justification was false and the copy bought a drift risk for nothing — the phone
could have called something amber that the web still drew green for the same
reading. Both are now taken from the contract, and the parity test asserts neither
client exports its own.

The FORMATTERS are still twinned, and that is correct: production code in `app/lib`
never imports `landing`. Only the mirror-parity tests cross that line.

## The parity test is where the product decisions live

`gateway/__tests__/usage-dashboard-client-parity.test.ts` executes both copies over
the same inputs — nulls first, because that is where a divergence hides. Both "—"
and "0.0×" render perfectly and only one is true.

Mutants killed: drifting the phone's band threshold by 0.01, changing its duration
rounding from round to floor, and making it treat an empty pool list as unreachable.

## The refusals, mutation-tested one at a time

- unreachable → **no bar**. The faithful mutant makes `DASHBOARD_UNREACHABLE` a
  zero reading, which is exactly the "a 0% bar invents a measurement" bug; it fails
  both no-bar tests.
- `pace: null` → an em dash, no note. Rendering `0.0×` fails.
- `exhausts_at: null` → the row is **omitted**. Always rendering it fails.
- `account_label: null` → "active credential", never a guess.

A first mutation attempt here was NOT faithful — it made the unreachable branch
fall through to a pools branch with no pools, which renders nothing rather than
rendering a false bar. A mutant that does not reproduce the real bug proves nothing
about the test.

## Not built

The band rides on an `accessibilityLabel` as well as a colour, because a test that
can read only a style cannot tell amber from red on a 6px bar.
