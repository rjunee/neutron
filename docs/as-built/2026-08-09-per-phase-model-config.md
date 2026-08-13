# Which model runs which phase became configuration

## What changed

`trident/phase-models.ts` is new: a stable, owner-facing vocabulary of build phases
(decomposition · build · build-mechanical · rubric review · adversarial review ·
synthesis/arbitration · bookkeeping), each with a default tier + reasoning effort, plus
strict validation. `buildWorkflowArgs` threads validated overrides to the workflow as
`phaseModels`, and the workflow's router applies them over its own table.

Every default is unchanged. An instance that never touches the setting produces
byte-identical args — the key is **omitted**, not sent as `{}`.

## Why the vocabulary is not the agent labels

The workflow's labels are internal and several are dynamic (`forge:fix-round-3`,
`checkpoint:argus-approved`, `head-probe-round-2`). Exposing them as settings keys would
make the configuration surface change shape whenever the workflow's internals did, and
would require the owner to know that "the thing that reviews adversarially" is spelled
`argus:adversarial`. So the settings keys are stable phase names and the label → phase
mapping lives beside them.

## The bug the coverage test found on its first run

**`head-probe-round-N` had escaped the routing table**, so it resolved to the fallback —
the most expensive tier at **high** effort — for a step whose entire job is to run one
`git` command and report the sha it printed, interpreting nothing. It had been that way
since the step was introduced, and **nothing could have caught it: a missing entry and a
deliberate entry are indistinguishable when the fallback is silent.**

That is the argument for the test, not just for the one-line fix. `trident/__tests__/phase-model-coverage.test.ts`
walks every `label:` literal in the workflow source and requires each to be claimed by a
phase or listed in `UNROUTED_LABELS` **with a reason**. The four cross-model reviewer
lanes are listed there: they dispatch an external CLI in a subprocess, so offering a
model control for them would be a lie in the UI.

## Two design decisions worth keeping

**Validation fails LOUD at the boundary and degrades QUIETLY in the workflow**, because
the two need opposite behaviour. At the settings boundary an unknown phase or a bogus
effort is an error the owner sees — silently dropping it is the worst outcome available,
since they would set `xhigh`, observe nothing, and reasonably conclude the feature is
broken. Inside the workflow a bad entry must never abort an otherwise-fine build, so it
logs the entry **by name** and uses the default. The typed layer therefore also drops
invalid entries rather than forwarding them, because a log line in a background run is
not a channel anyone reads.

**The route field is `phaseKey`, not `phase`.** `agent()` opts already carry `phase`,
meaning the workflow's progress group (`Build`/`Review`/`Synthesis`). Two different
concepts under one name in one file is how the wrong one gets read.

## Also in this change: a false claim removed from the tree

`gateway/wiring/resolve-llm-credentials.ts` carried a docblock headed **"KNOWN
LIMITATION … NO FAILOVER"** about the ambient credential pool. **That claim was wrong**,
and it was wrong in the most durable place available — presented as design
documentation, in a permanently public file. The single credential-less pool entry is
the *mechanism*: the child authenticates from the credential file and rotation swaps
that file underneath it, reactively and continuously. The reasoning that produced the
claim skipped checking whether any layer above handled it.

The replacement records the retraction and the generalisable form: **a component that
legitimately holds no state can look broken when reasoned about alone.** A docblock
asserting a limitation is read as design documentation, so it needs the same evidence bar
as a claim about behaviour — arguably a higher one, since nothing executes it and no test
can go red.

## Verification

`trident/__tests__/phase-model-coverage.test.ts` — 31 tests. Trident suite: 577 pass.
Typecheck matrix: 51 tsconfigs, all pass. Lint clean.

**Mutants, killed by different tests:** removing `head-probe` from the phase table reds
the coverage assertion *and* the named regression test; making the router ignore the
override (the "built but never wired" shape) reds the wiring assertion alone.

**The extractor carries a positive control**, because a regex that matched nothing would
have reported perfect coverage. It also needed two fixes found by its own first run: the
scan matched the word `label:` inside *prose*, and its character class then ran past a
newline to a backtick several lines later and swallowed a block of source as a "label".
Comments are stripped and newlines forbidden — the same unscoped-regex mistake that has
now bitten twice in one day, in both directions.
