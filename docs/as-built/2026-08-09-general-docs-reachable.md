# General's documents became reachable — on both surfaces

## What changed

A work card's spec-doc chip now opens that document, in **every** scope including
General, on **both** the web shell and the mobile app. General also gained a
Documents tab on the web, ordered `chat → work → docs` to match named projects.

## Why it was broken, and why each half looked fine

The owner reported one symptom — a General work card whose plan link did nothing,
and no documents in General at all — that turned out to be **four independent
gaps**, three on web and one on mobile. None of them was a mistake at the time it
was written, which is what made the whole chain invisible:

1. **Web: General had no `documents` tab.** The engine's global tab set is
   Admin-only, so General received no docs descriptor even though its documents
   are backend-reachable (`doc-store.ts` roots them at
   `<owner_home>/Projects/general/docs`, the same rule every named project
   follows).
2. **Web: `ProjectShell` deliberately suppressed the link for General**
   (`isGeneral ? undefined : onOpenDocLink`). Correct for a tab set with no
   Documents tab — a link there would set a pending doc the resolver could never
   satisfy, i.e. a dead button. The guard encoded a fact about **another module's
   tab set with no mechanical link back to it**, so changing that tab set could
   not fail here.
3. **Web: `docs-client.ts` interpolated the scope id into nine URLs raw.** Even
   with a tab and a handler, General (`''`) would have requested
   `/api/app/projects//docs/…` and taken a 400.
4. **Mobile: nothing ever passed `onOpenDoc`.** `WorkBoardRow` has declared it
   since it was written and keys three behaviours off its presence — the a11y
   role (`button` vs `text`), `disabled`, and the press handler. The sibling
   `onPlay` **is** passed at the same call site, which is the control proving the
   wiring point was reachable all along and the miss was specific to this prop.

**Fixing any one of the four changes nothing observable.** That is the shape worth
remembering: a feature can be dead behind several independently-reasonable
decisions, and each one reviews as correct in isolation.

## The consolidation

`landing/chat-react/general-scope.ts` is new: the ONE place General changes
spelling on the web, mirroring the mobile client's `app/lib/general-scope.ts`.
`work-board-client.ts` already carried a private `'' → 'general'` normaliser and
`docs-client.ts` carried none — which is precisely why one surface worked and the
other 400'd. The work-board helper now **delegates** rather than keeping a second
copy, and a test asserts the two agree for every input.

Routing keeps two ids on purpose. The board client is **scope**-addressed
(General ⇒ `''`); the route is **rail**-addressed (General ⇒ `~general`). A push
built from the scope yields `/projects//docs` — dead, and dead on General
specifically, the one board where this was hit.

## Verification

`landing/chat-react/__tests__/general-docs-reachable.test.tsx` (10) and
`app/__tests__/workboard-doc-link.test.tsx` (5). Both halves were
**mutation-tested and killed by DIFFERENT tests** — reverting the URL
normalisation fails the docs-client assertion; removing the injected tab fails
the tab-order assertion — so neither check is redundant.

The source-level regression check on `ProjectShell.tsx` **caught itself on its
first run**: the rewritten code carries a comment quoting the removed expression
to explain why it went, and a naive substring search flagged the explanation as
the regression. It now strips comments before checking — a check on source text
has to look at code, or it punishes the documentation that makes the change
legible.

Full typecheck matrix: 51 tsconfigs, all pass.
