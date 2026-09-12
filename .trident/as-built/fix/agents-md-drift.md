## 2026-09-12 — the root `AGENTS.md` lands, and three documents stop asserting the ban it removed

#512 un-banned a root `AGENTS.md` from the leak gate's `FORBIDDEN_EXACT` list and
said the file itself would follow. It does, here. What also shipped with #512, and
should not have, was three documents left asserting the rule it had just removed.

A **Codex cross-model review** found them, on the first run of that gate in this
session, against a diff that had already merged:

- `docs/process/work-tracking.md` said, as a parenthetical in the standard's own
  opening section, that *"this repository reserves the root `AGENTS.md` path as a
  leak-gate tripwire, so it uses the latter shape."* Simply false the moment #512
  landed — and worse than a stale comment, because that file is the standard other
  repositories copy verbatim.
- `SPEC.md`'s K10 clause names all four paths as staying banned. That one is
  **correct as history and misleading as current state**, which is a different
  defect with a different fix: the Decisions Log is immutable, so it is superseded
  by a new dated entry rather than edited.
- `scripts/ci/leak-gate-selftest.test.ts` explained its 60s budget as *"Four full
  gate runs in one case."* The loop had become three. Restated as "one per
  retained entry" so the rationale moves with the list instead of going stale
  again the next time the list changes.

The rule this earns, now written into `AGENTS.md` where an agent meets it before
making the same mistake: **a change that narrows or removes a guard must grep for
every document asserting the old rule and fix them in the same PR.** This tree's
own architecture notes (`docs/agent-legible-architecture.md` § 1) name prose-only
guards as the failure mode, with `docs/INVARIANTS.md` — 894 lines, evaluated by no
CI step — as the cautionary example. The change documenting that principle
committed the thing it warns about, which is the most useful possible way to
learn it.

The new root `AGENTS.md` is deliberately a POINTER, not a fifth copy of the rules.
It names the binding standard, the one queue, the immutable-log discipline, and
the four hard rules a new agent most often violates here: the leak gate scans
commit messages as well as files and is fail-closed; there are no feature flags or
dual code paths; every claim carries a `file:line` and every absence claim needs a
positive control; and a guard must be delivered rather than published. The three
still-reserved root paths are named with their reason, so the next reader does not
have to grep the gate to find out why `CLAUDE.md` cannot live here.

Also recorded in the same Decisions Log entry: the owner's slug is **not
sensitive** — ruled 2026-09-12 after being filed 2026-08-17 as a public-exposure
question and deliberately left open rather than guessed. 17 tracked files stay as
they are, no gate rule is added, and the CI-log exposure is accepted rather than
mitigated. The entry's own open question is settled in the unflattering direction:
`purity` was green because nothing looked for the slug, not because something
waved it through.

Verified: the selftest is 56 pass / 0 fail, and the leak gate reports **0 findings
on a materialized tree that now contains a real root `AGENTS.md`** — which is the
un-ban proven end to end rather than asserted.
