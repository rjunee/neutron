---
title: Cut the owner over and decommission the standalone service
group: email-core
status: open
priority: P3
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

> **CORRECTED 2026-09-12, at the split. The learning-loop claim below is FALSE and
> is struck.** The item said the return-to-inbox learning loop is "live and closed:
> `pipeline/poller.ts:82` reads patterns into the classifier". That line is
> `export const DEFAULT_MAX_POLL_PAGES = 20` — a page budget, not a learning loop —
> and **no learning loop exists anywhere under `cores/free/email/src/`**.
>
> **What is actually true:** the poller re-reads the EXISTING sender rules on every
> tick — `const rules = store.listSenderRules()` feeding `ClassifyDeps`
> (`cores/free/email/src/pipeline/poller.ts:791-792`), consumed by
> `matchRule(input.sender, deps.rules)`
> (`cores/free/email/src/pipeline/classify.ts:171-172`). That is a rules **READ**, so
> a rule edited out of band takes effect on the next tick. Nothing WRITES a rule back
> from an owner returning a message to the inbox. **There is no loop to keep**, so
> "the return-to-inbox learning loop is KEPT" cannot be an acceptance criterion for
> the cutover — either it is built as new work, or the cutover ships without it. Say
> which; do not carry the claim forward.

**P4 — owner cutover.** Hard switch on the WRITES, no parallel mutation:
both systems label the same mail. Old service's crons off → verified interval →
service deleted. Its database is NOT imported — the mail all still lives in
Gmail, so a clean start is correct. ~~The return-to-inbox learning loop is KEPT (live and closed: `pipeline/poller.ts:82` reads
patterns into the classifier).~~ STRUCK 2026-09-12 — no such loop exists; see the correction
above for what the poller actually does.
_Acceptance: the standalone service no longer exists and the owner has had no
gap in briefs or escalations across the switch._

## Acceptance

- [ ] The standalone service no longer exists, and the owner has had **no gap** in briefs or
      escalations across the switch.
- [ ] The switch is hard on the WRITES — no parallel mutation, so both systems never label
      the same mail. Assert the old crons are off and the interval is verified BEFORE the
      service is deleted.
- [ ] The old database is NOT imported. The mail all still lives in Gmail, so a clean start
      is correct.
- [ ] **The return-to-inbox learning loop is DECIDED, not assumed.** It does not exist (see
      the correction above), so this item records either that it is built as new work with
      its own criterion, or that the cutover ships without it. Carrying the old "live and
      closed" claim forward fails this criterion.
