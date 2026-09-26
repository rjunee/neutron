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

## Blocking the cutover

These are the items the harness-orchestrator cutover is gated on.

- [`host-test-suite-efficiency`](host-test-suite-efficiency.md) — Diagnose early and remove measured host test-suite waste
- [`planner-selected-execution-strategy`](planner-selected-execution-strategy.md) — Let the initial planner select a persisted execution strategy
- [`refreshed-ci-merge-readiness`](refreshed-ci-merge-readiness.md) — Wait for refreshed CI without rebuilding an approved revision
- [`salvage-publication-provenance`](salvage-publication-provenance.md) — Preserve publication ownership when salvaging a failed build
- [`same-run-task-sequence-crash-handoff`](same-run-task-sequence-crash-handoff.md) — Recover an intermediate task checkpoint before reviewing the card
- [`the-orchestrator-owns-the-build-loop`](the-orchestrator-owns-the-build-loop.md) — The project REPL owns the build loop
- [`the-review-loop-must-stop-and-re-plan`](the-review-loop-must-stop-and-re-plan.md) — Stop and escalate a review loop instead of iterating on a bad plan
- [`trident-build-efficiency`](trident-build-efficiency.md) — Avoid repeated build work and measure Trident's time and token costs
- [`repl-model-background-poll-test-stability`](repl-model-background-poll-test-stability.md) — Synchronize the REPL model background-poll race test
- [`a-gateway-restart-keeps-the-project-repls`](a-gateway-restart-keeps-the-project-repls.md) — A gateway restart keeps the project REPLs, conversation and all
- [`durable-reply-sink-coordinates`](durable-reply-sink-coordinates.md) — The sink's coordinates outlive the gateway, and an orphan must not
- [`project-herdr-workspaces`](project-herdr-workspaces.md) — Project-owned Herdr workspaces and sleep lifecycle
- [`project-code-repos-and-vault-split`](project-code-repos-and-vault-split.md) — Split a project into declared code repos and a versioned vault

## Not buildable yet

An open question sits at the top of each body and must be answered before a
branch is cut (standard §3.1, §3.2).

- [`build-timeline-core`](build-timeline-core.md) — Distribute portable PR build observability as a Core after cutover
- [`per-project-context-for-agent-tools`](per-project-context-for-agent-tools.md) — Scope agent tool state to the active project everywhere

## All items

### trident

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`a-retry-must-resume-from-the-checkpoint`](a-retry-must-resume-from-the-checkpoint.md) | Carry a dead run's checkpoint and task iteration into its retry | P0 | yes |
| [`a-terminal-cause-on-every-terminal-path`](a-terminal-cause-on-every-terminal-path.md) | Emit a terminal cause on every terminal path, and report it | P0 | yes |
| [`host-test-suite-efficiency`](host-test-suite-efficiency.md) | Diagnose early and remove measured host test-suite waste | P0 | yes |
| [`planner-selected-execution-strategy`](planner-selected-execution-strategy.md) | Let the initial planner select a persisted execution strategy | P0 | yes |
| [`refreshed-ci-merge-readiness`](refreshed-ci-merge-readiness.md) | Wait for refreshed CI without rebuilding an approved revision | P0 | yes |
| [`resolve-the-review-diff-base`](resolve-the-review-diff-base.md) | Rev-range base: the pinned sha, else a ref nobody can mistake | P0 | yes |
| [`salvage-publication-provenance`](salvage-publication-provenance.md) | Preserve publication ownership when salvaging a failed build | P0 | yes |
| [`same-run-task-sequence-crash-handoff`](same-run-task-sequence-crash-handoff.md) | Recover an intermediate task checkpoint before reviewing the card | P0 | yes |
| [`the-orchestrator-owns-the-build-loop`](the-orchestrator-owns-the-build-loop.md) | The project REPL owns the build loop | P0 | yes |
| [`the-review-loop-must-stop-and-re-plan`](the-review-loop-must-stop-and-re-plan.md) | Stop and escalate a review loop instead of iterating on a bad plan | P0 | yes |
| [`trident-build-efficiency`](trident-build-efficiency.md) | Avoid repeated build work and measure Trident's time and token costs | P0 | yes |
| [`a-changed-literal-must-not-leave-new-prose-stale`](a-changed-literal-must-not-leave-new-prose-stale.md) | Refuse newly added prose that asserts a constant's replaced literal | P1 | — |
| [`a-fake-cannot-be-silently-incomplete`](a-fake-cannot-be-silently-incomplete.md) | Require output-capable hosts at merge construction | P1 | — |
| [`a-run-whose-head-does-not-resolve-must-refuse-to-commit`](a-run-whose-head-does-not-resolve-must-refuse-to-commit.md) | A run whose HEAD does not resolve must refuse to commit | P1 | — |
| [`absence-is-a-question-about-the-ref`](absence-is-a-question-about-the-ref.md) | An absence claim about a tracked file is a question about the ref | P1 | — |
| [`blocked-is-not-slow`](blocked-is-not-slow.md) | Distinguish blocked workers from slow and unclassified work | P1 | — |
| [`build-fleet-process-census`](build-fleet-process-census.md) | Count the local build fleet from live processes | P1 | — |
| [`checkpoint-write-contention`](checkpoint-write-contention.md) | Checkpoint writes survive build-load contention | P1 | — |
| [`codex-work-runs-headless-per-call-on-a-reused-thread`](codex-work-runs-headless-per-call-on-a-reused-thread.md) | Run cross-model codex work headless per call on a reused thread | P1 | — |
| [`dead-lane-process-reaping`](dead-lane-process-reaping.md) | Reap child processes left by dead build lanes | P1 | — |
| [`launcher-crash-report-precedence`](launcher-crash-report-precedence.md) | Prefer the better-informed launcher death report | P1 | — |
| [`premerge-session-trailer-admission`](premerge-session-trailer-admission.md) | Independently scan reviewed commit messages before merge | P1 | — |
| [`publish-only-resume-without-re-running-forge`](publish-only-resume-without-re-running-forge.md) | Re-publish a built commit after a credential blink, without rebuilding | P1 | — |
| [`run-head-hash-width`](run-head-hash-width.md) | Accept full SHA-1 and SHA-256 run heads and checkpoints | P1 | — |
| [`trident-install-disk-admission`](trident-install-disk-admission.md) | Admit dependency installation only with measured disk headroom | P1 | — |
| [`codex-control-socket-path-fits-sun-len`](codex-control-socket-path-fits-sun-len.md) | Keep Codex control sockets within Linux sun_path | P2 | — |
| [`codex-project-directory-names-its-owner`](codex-project-directory-names-its-owner.md) | Codex project credential directories name their owning project | P2 | — |
| [`surface-infra-retries-to-the-owner`](surface-infra-retries-to-the-owner.md) | Surface infrastructure retries to the owner | P2 | — |
| [`trident-phase-accounting`](trident-phase-accounting.md) | Store per-phase token and cost accounting for every Trident run | P2 | — |

### deploy

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`a-deploy-must-not-kill-builds-in-flight`](a-deploy-must-not-kill-builds-in-flight.md) | Stop a deploy from killing the builds still in flight | P0 | yes |

### work-board

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`a-card-pulse-must-be-gated-on-a-real-heartbeat`](a-card-pulse-must-be-gated-on-a-real-heartbeat.md) | Gate a card's pulse on the shipped heartbeat, never on a proxy | P1 | — |
| [`plan-docs-must-land-somewhere-versioned`](plan-docs-must-land-somewhere-versioned.md) | Land a card's plan doc somewhere durable and versioned | P1 | — |
| [`a-card-must-show-both-build-counters`](a-card-must-show-both-build-counters.md) | Show task progress and review round explicitly on the card | P2 | — |

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
| [`repl-model-background-poll-test-stability`](repl-model-background-poll-test-stability.md) | Synchronize the REPL model background-poll race test | P0 | yes |
| [`message-rejection-correlation`](message-rejection-correlation.md) | Attribute explicit send rejections to the originating message | P1 | — |
| [`native-crash-visibility-for-the-mobile-app`](native-crash-visibility-for-the-mobile-app.md) | Make a native process-start crash diagnosable without a cable | P3 | — |

### platform

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`a-gateway-restart-keeps-the-project-repls`](a-gateway-restart-keeps-the-project-repls.md) | A gateway restart keeps the project REPLs, conversation and all | P0 | yes |
| [`durable-reply-sink-coordinates`](durable-reply-sink-coordinates.md) | The sink's coordinates outlive the gateway, and an orphan must not | P0 | yes |
| [`herdr-host-implements-ptyhost-over-the-socket-api`](herdr-host-implements-ptyhost-over-the-socket-api.md) | HerdrHost implements PtyHost over the herdr socket API | P0 | yes |
| [`project-herdr-workspaces`](project-herdr-workspaces.md) | Project-owned Herdr workspaces and sleep lifecycle | P0 | yes |
| [`an-abandoned-dispatch-cannot-actuate-later`](an-abandoned-dispatch-cannot-actuate-later.md) | An abandoned dispatch cannot actuate later | P1 | — |
| [`configured-models-for-review-and-chat`](configured-models-for-review-and-chat.md) | Configure models once for review and project chat | P1 | — |
| [`instance-project-provider-resolution`](instance-project-provider-resolution.md) | Resolve the model provider per instance and project | P1 | — |
| [`live-agent-turn-must-know-the-owner-timezone`](live-agent-turn-must-know-the-owner-timezone.md) | Give the live agent turn the owner's timezone and local time | P1 | — |
| [`observable-pane-adoption`](observable-pane-adoption.md) | Require observable pane adoption and bounded pane-loss recovery | P1 | — |
| [`project-code-repos-and-vault-split`](project-code-repos-and-vault-split.md) | Split a project into declared code repos and a versioned vault | P1 | yes |
| [`start-the-project-backup-scheduler-loop`](start-the-project-backup-scheduler-loop.md) | Start the dormant per-project backup scheduler loop | P1 | yes |
| [`temporary-build-timeline-dashboard`](temporary-build-timeline-dashboard.md) | Observe PR wall-clock phases in a temporary authenticated dashboard | P1 | — |
| [`build-timeline-core`](build-timeline-core.md) | Distribute portable PR build observability as a Core after cutover | P2 | — · needs-spec |
| [`owner-installable-mcp-servers`](owner-installable-mcp-servers.md) | Owner-installable MCP servers | P2 | yes |
| [`per-project-context-for-agent-tools`](per-project-context-for-agent-tools.md) | Scope agent tool state to the active project everywhere | P2 | — · needs-spec |
| [`stale-approval-is-re-raised`](stale-approval-is-re-raised.md) | Re-raise forgotten ritual approvals at a bounded daily cadence | P2 | — |
| [`start-the-comments-agent-watcher-loop`](start-the-comments-agent-watcher-loop.md) | Start the dormant comments AgentWatcher loop | P2 | — |
| [`hitl-prompt-user-enforcement-policy`](hitl-prompt-user-enforcement-policy.md) | Lock the HITL prompt-user enforcement policy | P3 | — |

### security

| Item | Title | Priority | Cutover |
|---|---|---|---|
| [`a-build-process-must-not-decrypt-secrets-it-was-not-given`](a-build-process-must-not-decrypt-secrets-it-was-not-given.md) | Scope build credential reads to the bound project | P1 | — |
| [`connect-auth-session-nonce`](connect-auth-session-nonce.md) | Bind connect callbacks to the initiating login session | P1 | — |
| [`merge-message-pii-and-a-deterministic-leak-window`](merge-message-pii-and-a-deterministic-leak-window.md) | Keep denylisted identities out of merge commit messages | P1 | — |
| [`persisted-secret-staging-identity`](persisted-secret-staging-identity.md) | Persist secrets despite staging remnants after PID reuse | P1 | — |
