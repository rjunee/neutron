## 2026-09-28 — Check the Claude composer before a project dispatch

The same-model route remains a subagent inside the project REPL, as required by
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:96`. The acting turn submitted
through `PtyChild.submitLine`; the Herdr host appends bracketed text and then sends
Enter (`runtime/adapters/claude-code/persistent/herdr-host.ts:616`). The gateway
turn mutex did not establish that an adopted pane's existing composer was empty.

`runtime/workers/claude-acting-turn.ts:285` now requires a guarded submission for
externally addressable panes. Its screen check and submission evidence run inside
the host's actuation queue (`herdr-host.ts:611`), after earlier writes drain. An
occupied, unreadable, unsupported, or unrecognized composer returns the existing
typed blocked outcome, preserving its cause through the build driver. It leaves
the draft untouched and records the existing not-submitted evidence so composition
releases the unused child lease.
`runtime/workers/claude-composer.ts:7` recognizes the last bordered composer and
checks its continuation lines, rather than accepting any historical empty cursor.
The refusal never includes the draft text.

The consuming `open/__tests__/project-build-e2e.test.ts` cases attach a real
HerdrHost to a simulated pane: draft and unreadable states send no input, create
no worker, and retain no native-child lease; an empty composer completes a build
through merge. Focused actor/parser tests also cover cancellation during capture,
missing screen capability, multiline drafts, a draft arriving from an earlier
queued host write, and clearing the composer before a subsequent dispatch. An
actual Bun PTY remains able to dispatch without screen capture: it has no external
pane and retains its existing acknowledged submission behavior, as required by
the supported-backend exception in `SPEC.md`. Both semantic mutations were killed by the consuming tests:
bypassing the predicate submitted the draft, while forcing the predicate blocked
the empty-composer build. Moving the preflight ahead of the queue and applying the
external-pane guard to Bun also failed their respective regression controls.
The final focused actor, parser, dispatch-evidence, and Herdr-key suites passed
167 tests; the three consuming Herdr cases and both root and Trident typechecks
also passed.

CI additionally exercised the identity-environment registry and the adoption
claim suite. The margin extractor now slices before the already-validated rule
glyph: the earlier zero-width whitespace regex matched every identity candidate
in the registry's deliberately conservative regex audit. The registry remains
unchanged. The adoption fixture now supplies guarded input and a rendered screen,
with a draft refusal before its original successful native-result assertions.
The corrected registry, composer, acting-turn, and adoption suites passed 181
tests, plus the three consuming cases and both typechecks. Bypassing the draft
guard, blocking the empty composer, and discarding the margin each failed their
semantic controls.

This is a screen observation, not an editor transaction. It cannot exclude manual
typing from another client between the read and the terminal writes, or prove
hidden editor state from rendered text. Screen text reproducing composer chrome
remains ambiguous, and an input RPC acknowledgement does not prove the CLI has
repainted before capture. The draft check is specific to externally addressable panes,
not a new composer guarantee for the Bun backend. No live pane or deployed process
was modified for this offline verification.
