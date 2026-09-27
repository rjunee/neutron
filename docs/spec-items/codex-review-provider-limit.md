---
title: Preserve explicit Codex provider usage limits at the review gate
group: trident
status: open
priority: P0
cutover: true
---

The native Codex review transport currently reduces an explicit provider usage
limit to an infrastructure failure. The review gate then buys its deferred retry
against the same request. Preserve the provider refusal at that boundary.

This follows the locked pivot's retained review gates
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md` §3.8) and account custody
(`codex-operator-custody.md`). It changes request eligibility only. A premium
snapshot with null windows and zero purchased credits does not establish that
subscription quota is exhausted. No global cooling, rotation, credential read
for diagnosis, account fallback or inferred reset timestamp is authorized here.

## Acceptance

- [ ] An owned, complete native `turn.failed` event whose provider message begins
      `You've hit your usage limit.` (ASCII or typographic quote), with nonzero
      process exit and no conflicting completion, thread or malformed transport,
      becomes a typed request-scoped usage-limit failure.
      Verify: `bun test runtime/workers/codex-review.test.ts`.
- [ ] Generic errors, quoted/nested messages, malformed/incomplete output and
      contradictory completion never establish usage-limit authority. Ordinary
      infrastructure failures retain the bounded deferred retry; a valid verdict
      still completes normally. Verify: the transport suite above and
      `bun test trident/project-review-source.test.ts`.
- [ ] The consuming review source persists `rate-limited`, refuses a duplicate
      retry across source replacement, and retains the required reviewer veto.
      The composed Open build dispatches once for a usage limit, twice for an
      ordinary infrastructure failure, and never merges either failed review.
      Verify: `bun test open/__tests__/project-build-e2e.test.ts`.
- [ ] Semantic mutations that discard the explicit classification or broaden it
      to ordinary errors fail the consuming checks.
