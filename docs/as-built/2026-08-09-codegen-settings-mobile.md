# The build-phase models are settable from a phone

## What this completes

The per-phase model/effort config was built in three layers over two days: the phase
vocabulary and validation, then the store + per-launch resolver + HTTP surface, and
**still no way for a human to set anything**. This is the surface. Chat header ☰ →
Settings → **Code generation**.

Each phase gets a row — Build, Adversarial review, Synthesis and the rest — with model
and effort chips.

## Three decisions

**The phase list is server-supplied.** Labels, descriptions, defaults and the legal
values all arrive in the payload; the screen knows the *shape* of a phase and nothing
about the pipeline. A phase added to the engine appears here without an app release,
and neither client carries its own copy of a list they both have to agree on.

**Choosing the default CLEARS the override rather than pinning it.** Storing `opus` for
a phase already defaulting to `opus` would freeze it against a future change to that
default — the owner would have pinned something they only meant to leave alone. It also
makes "reset" fall out for free: choose the value with the dot. This is the behaviour a
reasonable implementation gets wrong, so it has a named test and a mutant.

**A rejected save keeps the local edits.** The server validates the whole set, rejects
it entire, and names every fault; the banner shows that verbatim, because the owner is
the only one who can fix a bad value and a generic "save failed" hides which row was
wrong. Discarding the edits would punish a typo by throwing away the rest of the work.

Nothing auto-saves: a chip is an edit, Save is a write. Every chip auto-saving would
make a mis-tap a live config change on the next build.

## Reachability is part of the feature

A registered route nothing pushes is the ISSUES #385 defect, and a push at an
unregistered route goes nowhere — **the two fail independently**, so the nav row in
`settings.tsx` and the `<Stack.Screen name="codegen" />` registration each have their
own assertion in `server-editor-reachability.test.ts`. Either alone leaves a dead
control.

## Verification

`app/__tests__/codegen-settings-reachable.test.tsx` — 12 tests that **press the real
chips on the real screen**, plus 2 added to the reachability guard.

**Three mutants, each caught:** choosing the default pinning instead of clearing (1) ·
a rejected save discarding the edits (1) · the effort chips rendered but inert (4).

Also asserted: the complete override set is sent on save (so saving one row cannot
silently clear another), the "Saved" confirmation goes stale on the next edit, and a
failed LOAD says so rather than rendering an empty list — zero phases would read as
"this build has no phases", which is a lie the owner cannot act on.

Typecheck 51/51 · lint clean · byte-scanned.

## Deferred, and named

**The web half.** `landing/chat-react/SettingsTab.tsx` gets the same section against
the same endpoint; it is not in this PR. The endpoint, the validation and the payload
shape are all shared, so the web version is a rendering job with no new server work —
but it is genuinely not done, and the owner uses both surfaces.
