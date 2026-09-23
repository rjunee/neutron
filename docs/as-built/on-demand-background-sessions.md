## 2026-09-23 — On-demand background workers and onboarding helper retirement

The setup helper was prewarmed on every Open composition, and timer-driven
reminders, rituals and work-board wakeups left their isolated compose worker
resident after a turn. Several post-onboarding utility callers also used the
setup substrate. Removing prewarm alone would therefore not have fixed its
lifetime.

`open/wiring/substrates.ts` now constructs setup lazily, retains its transcript
through onboarding, and gives each background compose or toolless utility job a
disposable worker. `open/composer.ts` routes proactive briefs, document watchers
and board classification through the utility substrate. Completion stops setup
admission and retires its exact served identities. A completed/failed onboarding
row on boot triggers the same retirement; it does not prewarm setup again.
OpenAI helpers omit the conversation continuation ledger, while setup and live
chat retain it. The separate per-project onboarding-document compose lifecycle
is unchanged.

`runtime/adapters/claude-code/persistent/pool.ts:395` implements exact-key
retirement. Active and queued turns finish before teardown. Registry generation,
session and claim must match under the ownership lock; confirmed child exit
precedes registry removal. Transcripts remain on disk. Supervision is fenced
both before and after asynchronous probing, so intentional retirement neither
respawns the helper nor reports it as a crash.

Legacy helper discovery derives keys from this owner's authorized credential
identities and known project/General scopes. It does not call ordinary boot
adoption: that path can terminate a child on failed health or reuse evidence
before establishing idleness. Cleanup can retire only an identity already owned
by this process in the same registry, with no active or queued turn and a fresh
rendered empty input prompt without the working indicator. Registry-only,
unknown, busy, foreign-owned or unreadable candidates are preserved with a
logged refusal; refusal before termination restores any temporary admission fence.
Registry generation, session and claim are checked again before termination.
This is not a prefix-based pane sweep, and historical credentials or deleted
project scopes are not silently granted migration authority. In particular,
restart does not automatically remove unowned legacy helper panes: safe
acquisition of those survivors is not delivered by this change.

This implements the owner's requested on-demand helper lifetime, within the
2026-09-23 workspace decision and `docs/spec-items/project-herdr-workspaces.md`.
The workspace ownership/placement foundation landed separately in #1231. This
change does not claim production project placement or idle project sleeping.
No production pane was closed during development.

Validation: 156 tests passed (728 assertions) across the wiring, background-chat
isolation, provider routing, helper retirement, legacy cleanup and consuming
Open reminder suites, plus workspace ownership and placement controls after
rebasing onto #1231. The
Open integration test boots both fresh and completed onboarding, fires through
the real reminder dispatcher and persistent adapter into a synthetic local
PTY/dev-channel peer, observes child exit, then proves the next fire creates a
new worker. Retirement tests cover active plus queued turns, successful and
refused identity checks, cancellation isolation, adopted-idle observation and
an in-flight watchdog probe. Direct factory cleanup tests forbid ordinary
adoption, preserve registry-only survivors regardless of health/evidence/host
metadata, and prove both owned-idle retirement and refusal for active, unknown,
unreadable or changed-identity helpers while preserving a live-chat control.

Both counterfactual mutations failed the consuming integration test in both
boot states: changing nudge workers back to warm failed the child-exit check;
disabling the nudge substrate failed the worker-spawn check. Both mutations
were restored. Reintroducing ordinary adoption in cleanup also failed its direct
factory guard. Root and Trident typechecks passed. These are synthetic-process
integration checks, not a live Claude subscription or deployed-pane proof.
