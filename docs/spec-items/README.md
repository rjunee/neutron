<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: bun run scripts/spec-items-index.ts
     `scripts/__tests__/spec-items-index.test.ts` fails when this drifts. -->

# Spec items — the queue

One file per work item, per the Neutron work-tracking standard
(`docs/process/work-tracking.md` §5 step 1). This index is **generated** — add a
file and re-run the script; never edit the table by hand.

A **slug is immutable once merged**: identity is the filename, so renaming
destroys one item and creates another while every external reference still points
at the old name. Retitle through the `title:` frontmatter instead.

**26 items.** 6 block the harness-orchestrator cutover; 1 still needs a spec.

## Blocking the cutover

These are the items the harness-orchestrator cutover is gated on.

- [`a-retry-must-resume-from-the-checkpoint`](a-retry-must-resume-from-the-checkpoint.md) — Carry a dead run's checkpoint and ralph round into its retry
- [`a-terminal-cause-on-every-terminal-path`](a-terminal-cause-on-every-terminal-path.md) — Emit a terminal cause on every terminal path, and report it
- [`resolve-the-review-diff-base`](resolve-the-review-diff-base.md) — Rev-range base: pinned sha, else the ref verified, never a shorthand
- [`the-review-loop-must-stop-and-re-plan`](the-review-loop-must-stop-and-re-plan.md) — Stop and escalate a review loop instead of iterating on a bad plan
- [`a-deploy-must-not-kill-builds-in-flight`](a-deploy-must-not-kill-builds-in-flight.md) — Stop a deploy from killing the builds still in flight
- [`durable-reply-sink-coordinates`](durable-reply-sink-coordinates.md) — The sink's coordinates outlive the gateway, and an orphan must not

## Not buildable yet

An open question sits at the top of each body and must be answered before a
branch is cut (standard §3.1, §3.2).

- [`per-project-context-for-agent-tools`](per-project-context-for-agent-tools.md) — Scope agent tool state to the active project everywhere

## All items

### trident

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`a-retry-must-resume-from-the-checkpoint`](a-retry-must-resume-from-the-checkpoint.md) | Carry a dead run's checkpoint and ralph round into its retry | P0 | yes |
| [`a-terminal-cause-on-every-terminal-path`](a-terminal-cause-on-every-terminal-path.md) | Emit a terminal cause on every terminal path, and report it | P0 | yes |
| [`resolve-the-review-diff-base`](resolve-the-review-diff-base.md) | Rev-range base: pinned sha, else the ref verified, never a shorthand | P0 | yes |
| [`the-review-loop-must-stop-and-re-plan`](the-review-loop-must-stop-and-re-plan.md) | Stop and escalate a review loop instead of iterating on a bad plan | P0 | yes |
| [`a-run-whose-head-does-not-resolve-must-refuse-to-commit`](a-run-whose-head-does-not-resolve-must-refuse-to-commit.md) | A run whose HEAD does not resolve must refuse to commit | P1 | — |
| [`codex-work-runs-headless-per-call-on-a-reused-thread`](codex-work-runs-headless-per-call-on-a-reused-thread.md) | Run cross-model codex work headless per call on a reused thread | P1 | — |
| [`publish-only-resume-without-re-running-forge`](publish-only-resume-without-re-running-forge.md) | Re-publish a built commit after a credential blink, without rebuilding | P1 | — |
| [`surface-infra-retries-to-the-owner`](surface-infra-retries-to-the-owner.md) | Surface infrastructure retries to the owner | P2 | — |

### deploy

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`a-deploy-must-not-kill-builds-in-flight`](a-deploy-must-not-kill-builds-in-flight.md) | Stop a deploy from killing the builds still in flight | P0 | yes |

### work-board

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`a-card-pulse-must-be-gated-on-a-real-heartbeat`](a-card-pulse-must-be-gated-on-a-real-heartbeat.md) | Gate a card's pulse on the shipped heartbeat, never on a proxy | P1 | — |
| [`plan-docs-must-land-somewhere-versioned`](plan-docs-must-land-somewhere-versioned.md) | Land a card's plan doc somewhere durable and versioned | P1 | — |
| [`a-card-must-show-both-build-counters`](a-card-must-show-both-build-counters.md) | Show both build counters on the card as <ralph_round>.<round> | P2 | — |

### email-core

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`email-p2-5-classification-setup-by-survey-and-interview`](email-p2-5-classification-setup-by-survey-and-interview.md) | Set up classification by inbox survey and owner interview | P3 | — |
| [`email-p2-twice-daily-brief-delivered-as-email`](email-p2-twice-daily-brief-delivered-as-email.md) | Deliver the twice-daily brief as email, with an on/off setting | P3 | — |
| [`email-p3-retire-the-dead-scheduled-digest`](email-p3-retire-the-dead-scheduled-digest.md) | Retire the Core's dead scheduled digest onto the new poller | P3 | — |
| [`email-p4-owner-cutover`](email-p4-owner-cutover.md) | Cut the owner over and decommission the standalone service | P3 | — |

### app

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`native-crash-visibility-for-the-mobile-app`](native-crash-visibility-for-the-mobile-app.md) | Make a native process-start crash diagnosable without a cable | P3 | — |

### platform

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`durable-reply-sink-coordinates`](durable-reply-sink-coordinates.md) | The sink's coordinates outlive the gateway, and an orphan must not | P0 | yes |
| [`live-agent-turn-must-know-the-owner-timezone`](live-agent-turn-must-know-the-owner-timezone.md) | Give the live agent turn the owner's timezone and local time | P1 | — |
| [`project-code-repos-and-vault-split`](project-code-repos-and-vault-split.md) | Split a project into declared code repos and a versioned vault | P1 | — |
| [`per-project-context-for-agent-tools`](per-project-context-for-agent-tools.md) | Scope agent tool state to the active project everywhere | P2 | — · needs-spec |
| [`start-the-comments-agent-watcher-loop`](start-the-comments-agent-watcher-loop.md) | Start the dormant comments AgentWatcher loop | P2 | — |
| [`start-the-project-backup-scheduler-loop`](start-the-project-backup-scheduler-loop.md) | Start the dormant per-project backup scheduler loop | P2 | — |
| [`hitl-prompt-user-enforcement-policy`](hitl-prompt-user-enforcement-policy.md) | Lock the HITL prompt-user enforcement policy | P3 | — |

### security

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`a-build-process-must-not-decrypt-secrets-it-was-not-given`](a-build-process-must-not-decrypt-secrets-it-was-not-given.md) | Stop a build process reading the owner's encryption keyfile | P1 | — |
| [`merge-message-pii-and-a-deterministic-leak-window`](merge-message-pii-and-a-deterministic-leak-window.md) | Keep denylisted identities out of merge commit messages | P1 | — |
