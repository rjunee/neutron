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
identities and known project/General scopes. Existing adoption verifies the pane
identity and credential before retirement. An adopted helper additionally needs
a fresh rendered empty input prompt without the working indicator. Unknown,
busy, foreign-owned or unreadable candidates are preserved with a logged
refusal. This is not a prefix-based pane sweep, and historical credentials or
deleted project scopes are not silently granted migration authority.

This is the helper-lifetime slice of the 2026-09-23 decision and
`docs/spec-items/project-herdr-workspaces.md`. It does not claim that project
workspace placement or idle project sleeping ships here. No production pane was
closed during development.

Validation: 121 tests passed across the wiring, background-chat isolation,
provider routing, helper retirement and consuming Open reminder suites. The
Open integration test boots both fresh and completed onboarding, fires through
the real reminder dispatcher and persistent adapter into a synthetic local
PTY/dev-channel peer, observes child exit, then proves the next fire creates a
new worker. Retirement tests cover active plus queued turns, successful and
refused identity checks, cancellation isolation, adopted-idle observation and
an in-flight watchdog probe.

Both counterfactual mutations failed the consuming integration test in both
boot states: changing nudge workers back to warm failed the child-exit check;
disabling the nudge substrate failed the worker-spawn check. Both mutations
were restored and the 121-test run passed afterward. Root and Trident
typechecks passed. These are synthetic-process integration checks, not a live
Claude subscription or deployed-pane proof.
