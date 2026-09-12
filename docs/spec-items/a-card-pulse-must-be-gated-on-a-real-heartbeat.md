---
title: Gate a card's pulse on the shipped heartbeat, never on a proxy
group: work-board
status: open
priority: P1
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

> **UNBLOCKED 2026-09-12, at the split.** The prerequisite SHIPPED. The build and
> review wrappers stamp `codex-exec-alive` / `codex-review-alive` into
> `code_trident_stage_events` every 5 minutes and the hang watchdog stands down on
> an event newer than its own threshold — `trident/run-driving.ts:82-88` says so in
> the code (*"That heartbeat shipped"*), and the cadence is pinned as
> `STAGE_HEARTBEAT_CADENCE_MS` at `trident/liveness.ts:81-88`. **The "BLOCKED ON
> #534, do not start before it lands" instruction in the title is struck; the item
> is startable.** Its two constraints on the heartbeat's output (distinguish ALIVE
> from PROGRESSING; re-point the hang reaper onto the heartbeat clock) survive as
> acceptance on the consumer side.
>
> **The condemned proxy is still in the tree, verbatim.** `itemRunning` at
> `landing/chat-react/work-activity.tsx:43-46` still derives liveness from the
> ABSENCE of data — `return rp === undefined || !TERMINAL_PHASE_LABELS.includes(rp.phase_label)`
> — which is the exact construct reviewers rejected. That is what this item replaces.

**A card's PULSE must be gated on a real heartbeat** (owner-directed 2026-08-13;
the #534 block is struck — see the correction above). This is the deferred half of the Work Board row-state card, split out
after run `36b95167` spent ten review rounds failing to build it. The other half — the durable failed
colour and the ▶/↻ retry control — is keyed on `status='failed'`, which the terminal reconcile already
writes (`work-board/store.ts`), needs no new signal, and ships separately.
WHY IT CANNOT BE BUILT YET. A pulse is a claim that something is MOVING. The only durable facts on the
surface are the run's `phase` and `last_advanced_at`, and both advance only ON HARVEST — so a run that
dies WITHOUT a terminal transition (a deploy SIGTERMing the warm REPL, which is exactly how this card's
own attempt `bb3c8c8e` died) leaves `phase = forge-init` forever and the card pulses forever. There is
no fact to check. Every fix round of `36b95167` therefore invented a PROXY for liveness — `undefined`
run progress read as "running" (`isLinkedRunning`, `rp === undefined || !terminal` — liveness inferred
from the ABSENCE of data), then an out-of-spec `!inline_active` suppressor whose own commit comment
concedes it creates "a permanent pulse+no-▶ state ... the same unrecoverable-card defect on a narrower
path". Reviewers rejected each in turn and were right to. **A proxy for a missing signal is not a
smaller version of the signal; it is a new defect wearing the fix's name.**
PREREQUISITE: governance tracker **#534** (*"a long build phase reports NOTHING until it ends, so a
working run is indistinguishable from a hung one"*, P1, escalated 2026-08-11) — the heartbeat. Its
recommended route is a periodic write through `trident/checkpoint.sh`. Nothing here should re-design it.
TWO CONSTRAINTS THIS ITEM PLACES ON #534's OUTPUT, from evidence #534 does not have:
(i) it must distinguish ALIVE from PROGRESSING. On 2026-08-13 the orchestrator read agent-transcript
    mtimes, called run `36b95167` "going well", and it was at that moment alive and converging on
    nothing. A heartbeat proving only "an agent is writing" would ship that mistake into the product.
(ii) the 90-minute hang reaper must be re-pointed onto the heartbeat clock rather than the harvest
    clock. It judges `last_advanced_at` today, which is why `eca83d1f` — this same card's FIRST
    attempt — was killed for "no progress" with nothing establishing it was hung.
Acceptance: a run killed by an instance restart, with no terminal transition written, stops pulsing on
the card within one heartbeat interval and offers ↻; and no code path derives liveness from the absence
of data. Kill the heartbeat writer and the test must fail.

## Acceptance

- [ ] A run killed by an instance restart, with no terminal transition written, STOPS
      pulsing on the card within one heartbeat interval and offers ↻.
- [ ] **No code path derives liveness from the absence of data.** The condemned construct
      at `landing/chat-react/work-activity.tsx:43-46` (`rp === undefined || !TERMINAL…`) is
      gone, not merely narrowed.
- [ ] **Kill the heartbeat writer and the test must fail.** A test that passes with no
      heartbeat being written is asserting nothing.
- [ ] The pulse distinguishes ALIVE from PROGRESSING. A run that is writing transcripts
      while converging on nothing must not read as healthy — assert that case directly, since
      a heartbeat proving only "an agent is writing" passes any naive liveness test.
- [ ] The 90-minute hang reaper judges the HEARTBEAT clock, not the harvest clock
      (`last_advanced_at`), so a run in a long build phase is not reaped for "no progress".
