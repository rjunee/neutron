## 2026-09-27 — Preserve explicit Codex usage limits at the review gate

Issue #1359. Acceptance lives in
`docs/spec-items/codex-review-provider-limit.md:20`, under the retained review
gates in `docs/plans/harness-orchestrator-pivot-2026-09-11.md:271` and credential
custody boundary in `docs/spec-items/codex-operator-custody.md:9`.

The native review reader reduced every nonzero Codex exit to infrastructure
failure. The consuming source persisted that as deferred, buying the bounded
retry against a request the provider had explicitly rejected for a usage limit.
The measured failure was a native `turn.failed.error.message` beginning with
the provider's usage-limit sentence. Its rollout usage snapshot instead had
`limit_id: premium`, null windows, zero purchased credits and null reached type.
Those usage fields alone cannot establish subscription exhaustion.

`runtime/workers/codex-review.ts:201` now classifies only the terminal provider
message, requiring a complete stream, an owned thread, nonzero exit and no
conflicting completion. Cancellation and timeout retain precedence. The shared
outcome carries a typed `rate-limit` failure; `trident/project-review-source.ts:347`
persists the existing `rate-limited` observation. The existing gate and retry
contract then retain the required review veto without buying another call.
No account pointer, credential custody, quota harvest or global cooldown changes.
The rejection establishes only the eligibility of this review request; it does
not establish the availability of another model or subscription.

Transport controls cover straight/curly provider messages, quoted and generic
errors, conflicting threads/completion, malformed or incomplete output, and a
valid review with zero purchased credits. Source controls exercise durable reuse
and retry refusal after source replacement, alongside an ordinary infrastructure
failure that still receives its bounded retry. The consuming Open E2E controls
observe exactly one Codex call for a usage limit, two for infrastructure failure,
and a merge veto for both; the valid account-custody control still merges.

Two semantic mutations were applied and reverted. Returning infrastructure for
the explicit limit killed the Open limit control (expected one dispatch, observed
two). Classifying every terminal error message as a limit killed the opposite
control (expected two dispatches, observed one). The transport, source, review
panel and generated-index suites passed 179 tests; the complete Open build E2E
file passed 376 tests. Root and Trident TypeScript checks and the repository
lint gate passed. The exact changed-file export plus the LICENSE control passed
the unchanged local leak gate; the whole checkout scan remains noisy from
pre-existing denylist matches and the worktree metadata path. Repository-wide
suite and live capacity claims are outside this local repair; no live account
was probed or rotated.
