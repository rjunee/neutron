# The per-phase model config gets a producer

## What was wrong

`trident/phase-models.ts` (the owner-facing vocabulary + validation),
`InnerLoopInput.phase_models` (the workflow argument) and the workflow's own router
were all built, tested and correct — and **nothing ever supplied a value.** The
orchestrator did not pass one when it fired a workflow, and no surface wrote one.

A complete seam with no producer: **every run silently used the defaults no matter
what was configured, and nothing could go red, because every piece worked in
isolation.** That is the built-but-never-connected shape `SPEC.md` names as this
repo's repeat offender — and it was found by an independent design review a few hours
after the config landed, not by a test.

## What changed

- **Migration 0118** adds `trident_phase_models` to `instance_metadata` — the
  documented home for instance-level settings, whose own docblock says future fields
  land as additive columns on that row (`transcription_backend` is the precedent).
  Instance-level rather than per-project: which model runs a build is a property of
  the owner's quota and subscriptions, not of the thing being built.
- **`readTridentPhaseModels` / `writeTridentPhaseModels`** in
  `gateway/storage/owner-metadata.ts`.
- **A per-launch `resolve_phase_models` resolver** on the orchestrator, threaded
  through the composition layer and supplied by the composer — read per launch for the
  same documented reason as its two siblings: a setting changed after boot must reach
  the next run, not the next restart.
- **`GET`/`PUT /api/app/trident/phase-models`**, registered in the composition input,
  the route-slot table, the composer, and the route-slot coverage inventory.

## Three decisions worth keeping

**The write fails whole; the read degrades quietly.** A `PUT` with any invalid entry
is a 400 that stores *nothing* and names every problem. The read path and the workflow
do the opposite — drop the bad entry, keep going. The asymmetry is the design: at the
settings boundary the owner is present and can be told, so a silent partial write is
the worst outcome available (they set `xhigh`, see nothing, and conclude the feature is
broken). Deeper in, nobody is listening, and aborting a build over config is worse.

**Re-validated on read**, so a row written by an older or hand-edited build cannot
reach the workflow — where the only available response is a log line in a detached
background run.

**`PUT` replaces rather than merges**, and an absent `overrides` key is a 400 rather
than a wipe. A merge would leave no way to *clear* a pin: sending `{}` for a phase
would mean "change nothing", and the owner would need a second verb to undo. Replacing
makes clearing an omission, which is what a settings pane naturally does when a control
returns to its default. But an absent key is ambiguous between "clear everything" and
"the client forgot the field", and clearing every pin by accident is not a mistake
worth making possible.

## Verification

`gateway/__tests__/trident-phase-models-producer.test.ts` — 17 tests, weighted toward
the CHAIN rather than the parts, because each link was independently absent.

**Three mutants, one per link, each caught by exactly one test:** the orchestrator not
passing the value · the composition layer not copying the resolver · the composer not
reading the store. Any one of them alone restores the original bug, and before this
none of the three would have failed anything.

The wiring assertions read the real source, comment-stripped and **scoped to the
construct** — an unscoped match on a symbol name passes on an unrelated mention
elsewhere in the file, which bit this repo twice in one day.

Typecheck 51/51 · composition-wiring gate clean · route-slot coverage green ·
migration snapshot regenerated and the runner's expected list extended to 118 (the
first attempt appended a duplicate `117`, caught by the runner test) · lint clean ·
byte-scanned for control characters.

## Still missing

**The UI.** This is the producer, not the pane — an owner still cannot set a phase from
the app. That is the next PR, and it now has a real endpoint to talk to rather than a
seam that would have silently done nothing.
