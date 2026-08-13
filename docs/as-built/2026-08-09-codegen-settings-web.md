# The build-phase models are settable on the web too

## Closing what #163 deferred

#163 shipped the mobile screen and named the web half as deferred. **Deferred work that
exists only in a PR body is work that quietly doesn't happen**, so this closes it. Same
endpoint, same payload, no new server work — a Code generation section in the web
Settings tab with the same per-phase chips.

## The three decisions are mirrored, deliberately and identically

Server-supplied phase list · **choosing the default clears the override** rather than
pinning it · **a rejected save keeps the edits** and shows the server's message
verbatim. Nothing auto-saves.

## The interesting part: a parity test, and where it had to live

`effectiveRow` and `applyRowEdit` now exist **twice** — once per client — because each
bundle is deliberately free of the other's workspace. That duplication is the right
call and it is also the risk: **these two functions encode product decisions, not
transport.**

A divergence is the failure nobody reports. Each surface stays self-consistent, so
neither looks broken; the owner just gets a different answer about their own settings
depending on which device they opened. And the decision most likely to drift —
whether choosing the default clears or pins — differs only in what happens *months
later*, when a default changes.

So the two copies are **executed side by side** over ten edit shapes and seven display
shapes.

**Where it lives matters and was not my first attempt.** The test began in `landing/`,
importing the mobile client by relative path. The lint rule caught it (`no relative
import from another package`), the workspace specifier then failed to resolve — and the
reason was the point rather than an obstacle: **`landing` does not declare
`@neutronai/app` as a dependency and must not start**, since that independence is
exactly why the helpers are duplicated. `gateway` is the one package declaring both, and
it is where `runtime/__tests__/doc-links-parity.test.ts` already puts the same kind of
mirror check for the same reason. Moved there.

## Verification

`landing/chat-react/__tests__/codegen-settings-web.test.tsx` (11) and
`gateway/__tests__/phase-models-client-parity.test.ts` (20).

**Four mutants, each caught:** the web copy pinning where the phone clears — a real
cross-client drift, caught by the parity test (2 tests) · a `PUT` body missing the
`overrides` key, which the server would 400 · a rejected save discarding the edits and
hiding the server's message · the Save button rendered but inert.

**Two of those last mutants survived the first pass.** The web component's error
behaviour was untested, which a mutation run found and a reading of the code did not.
The guard added for it is a *scoped source* assertion rather than a press — said plainly
in the test, because rendering `SettingsTab` means standing up five other clients it
constructs on mount, and the mobile screen already has the real behavioural version.

The parity suite carries a **positive control**: two functions that both returned their
input unchanged would otherwise pass every comparison in it. It also asserts neither
copy mutates its input — a copy that mutated in place would still "agree" on the
returned value while corrupting the caller's state, which is an agreement test missing
the actual divergence.

**A CSS token was wrong and would have shipped invisible.** The chips used
`var(--hairline)`, which is not a token in this stylesheet (it appears only with an
inline fallback elsewhere). The real one is `--border`, defined for **both** the dark
and light themes — so the border is now correct in each rather than absent in one.

Typecheck 51/51 · lint clean · byte-scanned · neighbouring settings-tab suites green.
