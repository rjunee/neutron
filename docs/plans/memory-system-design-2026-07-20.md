# Neutron Memory System — Full Design

> ## ⚠️ DATA-INTEGRITY REVIEW 2026-07-20 — 4 CORRUPTION BLOCKERS. READ BEFORE THE PLAN BELOW.
>
> A data-integrity review treated the first consolidation pass as the irreversible migration it is
> and found four defects that would silently, permanently corrupt the owner's corpus. Three are not
> mentioned anywhere in the plan below. The reviewer EXECUTED the real dedup code; the orchestrator
> independently reproduced the headline. **None of the memory build ships until all four are fixed.**
>
> ### BLOCKER 1 — auto-merge fuses UNRELATED entities. Reproduced, not hypothetical.
> `scribe/reflect/jaccard.ts:82-126` clusters by connected components over Jaccard ≥ 0.7 on
> `title + compiledTruth` (`reflect-pass.ts:424-427`). A fact-less page gets the boilerplate body
> `# <Name>\n\nMentioned in chat (kind: <kind>).` — so 6 of 7 tokens are boilerplate and the only
> distinguishing token is the name. Running the REAL functions on five fact-less company pages:
> `clusters: [[acme, globex, initech, umbrella, soylent]]` — **all five collapse into one entity in
> a single pass, transitively.** That is exactly the corpus shape that accumulates when dedup has
> never run — i.e. every real install. The §7.2 tripwire (flag merges that share a normalized NAME)
> does NOT catch this: Acme and Globex have different names. **FIX before any mutating pass:** strip
> boilerplate tokens before scoring; require a minimum distinguishing-token count; drop transitive
> closure (require pairwise similarity across the whole cluster); re-measure the false-merge rate on
> Ryan's real corpus; quarantine merge-losers under `entities/.quarantine/` for N passes instead of
> deleting.
>
> > **RESOLVED 2026-07-20 (M2-3, branch trident/memory-dedup-corruption-blockers-v2).** The
> > fusion vectors are closed in `scribe/reflect/jaccard.ts`: (a) `stripBoilerplate` removes ONLY
> > generated boilerplate before scoring — the generated title H1 (label == page title), the
> > generated section headings (`## Relationships`/`## Merged`), and the fact-less `Mentioned in
> > chat (kind: X).` line — and NEVER a hand-authored factual heading (the #415 all-H1 strip
> > over-reach that Codex vetoed is NOT reintroduced); (b) `tokenize` KEEPS numeric/alphanumeric
> > tokens (`2024`, `q1`, `v2`) — this is the numeric-token-drop / ISSUES #373 defect, closed here
> > as part of blocker 1; (c) `clusterNearDuplicates` forms CLIQUES (no transitive closure, greedy,
> > never over-merges) and gates on `MIN_DISTINGUISHING_TOKENS` (= 2). The Jaccard threshold stays
> > 0.7, `deps.jaccardThreshold`-configurable, and is flagged UNVALIDATED (re-measure the false-merge
> > rate on the real corpus before arming). STILL PENDING before arming (unchanged by this PR):
> > quarantine of merge-losers under `entities/.quarantine/` for N passes; AND two known accepted
> > residuals surfaced in review — (i) two DISTINCT fact-less entities sharing an identical ≥ 2-word
> > name still merge (gated behind the §7.2 merge name-tripwire), and (ii) two DIFFERENT-named entities
> > that each assert the SAME ≥ 3 relation targets can reach 0.714 because relation-verb tokens
> > (`works`, `at`) are not stripped and shared targets inflate overlap (e.g. `Bob`/`Carol` each
> > `Works at [[org0]]/[[org1]]/[[org2]]` → 5/7 = 0.714 ≥ 0.7). Neither is a regression (consolidation
> > is NOT armed, threshold UNVALIDATED); the fix before arming is to strip relation-verb tokens and/or
> > gate a merge on a shared name token. Reproduce-then-fix tests:
> > `scribe/__tests__/reflect-jaccard.test.ts` (five fact-less pages do NOT cluster; fiscal-year /
> > v1-v2 / Q1-Q2 stay distinct; factual-heading pair stays distinct; clique-not-transitive;
> > min-token gate; genuine near-duplicates still cluster).
>
> ### BLOCKER 2 — resynthesis silently disables supersede FOREVER.
> `stripSupersededSentences` (`write-to-gbrain.ts:637-644`) drops a sentence only when it
> canon-matches the generated `RELATION_SENTENCE` template. `RESYNTH_PROMPT` (`reflect-pass.ts:628-641`)
> rewrites compiled-truth into natural prose, which never canon-matches. So **once a page is
> resynthesized, every future supersede on it is a no-op** — the page asserts `works_at NewCo` AND
> `works_at OldCo` as current, forever, no error. This design turns both on in the same release.
> **FIX:** resynth must emit relation assertions in template-canonical form (or key the strip on the
> graph triple, not sentence shape); add a test that supersede still works on a resynthesized page.
>
> > **RESOLVED 2026-07-20 (M2-3).** Two linked defects closed:
> > - **2a — supersede survives resynth.** `stripSupersededSentences` (`scribe/write-to-gbrain.ts`)
> >   now keys the strip on the graph TRIPLE (a sentence is retired when its ONLY graph relation is a
> >   superseded target), NOT on canon-matching the `RELATION_SENTENCE` template — so it works
> >   regardless of prose form and supersede is no longer a no-op after resynth. Compound sentences
> >   (more than one relation) are still spared entirely. ACCEPTED RESIDUAL: a single-relation sentence
> >   carrying descriptive prose is dropped IN FULL — the retired relation persists as an additive dated
> >   timeline row (`works_at oldco`), but `stripSupersededSentences` is a pure compiled-truth transform
> >   that writes NOTHING to the timeline, so the sentence's descriptive detail AND any co-located
> >   still-current non-edge fact sharing that one sentence (e.g. `earns $400k`) leave current truth and
> >   are NOT re-recorded (an accepted loss of those non-edge details, isolated behind the flag). Test:
> >   `scribe-temporal-invalidation.test.ts` "a SINGLE-relation PROSE sentence for a superseded
> >   target IS retired (triple-keyed, not template-shaped)".
> > - **2b — resynth cannot mutate a predicate.** `preservesEdges` (`scribe/reflect/reflect-pass.ts`)
> >   now compares extracted (predicate, object) PAIRS, not just wikilink targets, so a rewrite that
> >   keeps a target but changes its verb (`Works at [[acme]].` → `Mentions [[acme]].`) is REJECTED —
> >   the edge cannot silently degrade, and a predicate-scoped supersede can always still retire it.
> >   Test: `reflect-pass.test.ts` "a re-synthesis that MUTATES a predicate on a preserved target is
> >   rejected". (The template-canonical-form alternative in the FIX above was NOT taken — it can't be
> >   deterministically enforced on LLM output and defeats resynth's natural-prose consolidation.)
> > - **Known residual (pre-existing, OUT of scope for this PR).** `preservesEdges` is one-directional
> >   — it rejects any resynth that DROPS or MUTATES a prior edge, but does not reject a resynth that
> >   ADDS a brand-new `(predicate, object)` edge the original never asserted (a hallucinated wikilink
> >   passes the accept-gate). This is unchanged from main (the old target-only gate had the same shape)
> >   and outside blocker-2b (predicate mutation on a preserved target, now correctly rejected). Close
> >   it before arming by also rejecting `after ⊄ before` (no NEW edge) on the resynth accept-gate.
>
> ### BLOCKER 3 — "bounded" is COUNT-bounded, not TOKEN-bounded.
> §6.2 caps dispatches at 200/pass, but `renderPageForResynth` (`reflect-pass.ts:723-728`) inlines
> the page's ENTIRE unbounded timeline with no truncation. The first pass is the one that meets
> months of accreted timeline on every page. The codebase already caps the reserved-kind digest at
> `DEFAULT_MAX_RESERVED_DIGEST_CHARS = 24_000` (`:112`); resynth lacks the equivalent. **FIX:** a
> per-page input budget (most-recent-N rows + compiled-truth) and a per-pass aggregate token ceiling
> that aborts the pass; measure Ryan's largest page BEFORE the first pass, gating step 3.
>
> ### BLOCKER 4 — reversibility is FALSE as sequenced.
> The snapshot argument leans on "GBrain is rebuildable via the doctor (§7.4)" — but the doctor is
> built at §9 step 6, and the first irreversible mutating pass is step 3. **FIX:** move the memory
> doctor to BEFORE the first mutating pass; verify GBrain-embedding rebuild cost (unverified — if
> expensive, the snapshot must cover the brain too); the `entities/` tar snapshot is necessary but
> insufficient alone (the pass also mutates the manifest, nexus, and timeline relation notes).
>
> ### ALSO REQUIRED (verified)
> - **No timestamp ordering on supersede.** `targets` is built from the current extraction against
>   current compiled-truth (`write-to-gbrain.ts:590-599`); timeline dates are never consulted. Step 1
>   arms the calendar/email fan-out over HISTORICAL content, so a backfilled 2024 email naming an old
>   employer can retire the current one. FIX: carry the source turn's observation timestamp; refuse a
>   supersede whose asserted date precedes the newest timeline row for that (subject, predicate); cap
>   the fan-out's historical backfill window.
> - **Watermark can't stamp no-op pages.** `reflect-pass.ts:674` `continue`s before the
>   `writeEntity` at `:688`, so a stable already-consolidated page never gets stamped and is
>   re-dispatched every pass forever. FIX: stamp on the no-op path (frontmatter-only CAS, gate the
>   sync hook on compiled-truth change) or a sidecar watermark store. The `llmCalls === 0` acceptance
>   test is unachievable until this is fixed.
> - **Write-AHEAD logs.** The supersede/merge undo record (the exact stripped sentence / both page
>   bodies) must be durable BEFORE the mutating write, or a crash between loses the only recovery.
> - **The §9 manual-pass report must contain full bodies, not counts** — counts can't tell a correct
>   merge from the Acme/Globex fusion. Every merge: both bodies before + merged after + score +
>   token sets. Every supersede: the exact stripped sentence with context. Every delete: the full body.
>
> ### VERIFIED IN THE PLAN'S FAVOUR
> "Supersede applies to future extractions only, nothing retroactive" is TRUE
> (`write-to-gbrain.ts:518,591-598`) — no batch job scans old data. The blast radius is genuinely one
> sentence. The build order is memory-FIRST (its substrates are toolless, so the security permission
> flip is a no-op for them — see the tool-security doc's revised order).


> **STATUS: COMPLETE (design).** Written by Atlas 2026-07-20. Mandate (Ryan): "design and build the full memory system in a robust way, not hacked together." This doc is the DESIGN only; build order in §9. Every code claim cites file:line, re-verified 2026-07-20 at commit cea2f829.

## Executive summary

The memory subsystem is ~80% built and ~40% alive. Chat extraction runs; everything that makes memory SELF-MAINTAINING (consolidation, supersede, temporal invalidation, the manifest) sits behind a default-off flag that violates the no-feature-flags rule, the Cores fan-out extracts from an empty in-memory calendar/inbox by construction, and consolidation — even if armed — is not idempotent enough to run at the locked 6h cadence without cost churn.

The design: four tiers with ONE canonical store (entity pages; GBrain strictly derived and rebuildable — §1), a three-tier write discipline putting every capability in exactly one of per-turn-LLM / per-save-deterministic / scheduled-batch (§2), a per-page consolidation watermark that makes a pass over unchanged input perform literally zero LLM calls and zero writes (§3), precise supersede/invalidate/delete semantics where the timeline is never touched and every destructive action leaves an audit row (§4), a build-then-arm split (the composer's own reflectLoop pattern) to thread the real Google clients into the fan-out (§5), a snapshot-before-first-pass + manual-first-pass migration story (§6), a deterministic `memory doctor` as terminal recovery for all mirror drift (§7), behavioral tests + real-install probes with "not done until the probe ran" (§8), and a 7-step build order that collapses the flag only after each behavior behind it is individually proven live (§9). Dreaming's uncovered half lands per the tier split: backlink repair event-driven per-save with a deterministic batch sweep, correction promotion in the batch pass, daily-delta as a read-time view over the pass log — no separate ritual (§2, Appendix A).

## 0. Verified current state (evidence log)

_Every claim below was re-verified against the code on 2026-07-20 (branch point: commit cea2f829). All file:line cites are this repo unless noted._

### 0.1 The flag gates four behaviours — CONFIRMED

`NEUTRON_PERFECT_RECALL` (parsed by `runtime/perfect-recall-flag.ts:27-34`, default-off contract stated at :13-15 and :25-26) gates:

1. **The reflect/consolidation loop** — `open/wiring/memory.ts:342` (`if (isPerfectRecallEnabled(env))` wraps the whole `SupervisedLoop` construction at :370-376). Flag off → `reflectLoop` stays `null` (:341) and the composer's arm site at `open/composer.ts:3399-3410` no-ops.
2. **RB4 temporal invalidation** — `scribe/write-to-gbrain.ts:231-233` (`const supersede = deps.supersede === true`), executed in `mergeExistingCompiledTruth` at :518 (`stripSupersededSentences` only when `supersede`).
3. **Supersede-on-extraction (prompt splice)** — `scribe/extract.ts:114-123` (`composeExtractionPrompt` splices `SUPERSEDE_GUIDANCE` only when `opts.supersede === true`); the wiring passes `supersede: isPerfectRecallEnabled(env)` at `open/wiring/memory.ts:230`.
4. Additionally (not in the original brief but confirmed): **RB1 memory-index manifest** (`open/wiring/memory.ts:195-204`) and **RC2 nexus store** (`open/wiring/memory.ts:268`) hang off the same flag.

Note on "scribe lane arming": `scribe/index.ts:78-81` is a comment on the RB3 *reflect* exports — it says the *reflect loop* never arms by default. The chat-turn scribe itself (`scribeOnUserTurn`, `open/wiring/memory.ts:297-298`) runs UNGATED whenever an LLM pool exists — chat extraction is live today. What the flag holds dark is: reflect loop, supersede semantics, memory-index manifest, nexus.

### 0.2 Interval conflict — CONFIRMED

`DEFAULT_REFLECT_INTERVAL_MS = 24 * 60 * 60 * 1000` (`scribe/reflect/reflect-pass.ts:103`, comment says "once per day"). The SPEC decision (see Appendix B) locks 6h ON by default. A test keys on the 24h cadence as the loop's unique signature: `open/__tests__/reflect-loop-arming.test.ts:184-190` (setInterval spy matching `DEFAULT_REFLECT_INTERVAL_MS`). Changing the interval requires updating that spy (it matches the constant symbolically, so a constant change keeps the test coherent — but the test name/comment at :184 says "unique 24h cadence"; the uniqueness assumption must be re-checked at 6h against other loops).

### 0.3 Cores fan-out mounted clientless + ordering problem — CONFIRMED

- `open/wiring/memory.ts:314-323` mounts `mountCoresScribeFanOut({ scribe, project_slug, owner_home })` — **no `calendarClient` / `gmailClient` args**. The wiring comment at :308-313 says exactly this ("the in-memory fallback clients yield an empty calendar/inbox... fan out nothing").
- `gateway/cores/mount-cores-scribe-fan-out.ts:185` and `:206` fall back to `buildInMemoryCalendarClient()` / `buildInMemoryGmailClient()` when the optional clients (declared :144-147) are absent.
- `mountOpenCores` DOES build the real clients: OAuth-gated `calendarClient` at `gateway/cores/mount-open-cores.ts:242-249`, `gmailClient` at :255-262 — but `MountedOpenCores` (:132-149) exposes only `backends`, `chatCommandFilter`, `prompter`, `oauthConfigured`, `cleanup`. The clients are private to the mount.
- Ordering: `wireMemory` is called at `open/composer.ts:1044`; `mountOpenCores` at `open/composer.ts:1147`. Memory (and the fan-out mount inside it) is wired ~100 lines before the real clients exist.
- Established late-binding precedent in this exact composer: `noticeDeliverHolder` (`open/composer.ts:723`) and `recoveredReplyDeliverHolder` (:727), both "populated once it exists" holders resolved lazily at call time. Also `setMemoryIndexWorkHandles` (`open/wiring/memory.ts:76,213-217`) is ALREADY a late-binding setter on WiredMemory for exactly this composition-ordering reason ("the work-board store is constructed AFTER wireMemory").
- ALSO relevant: the email triage LLM. `mountCoresScribeFanOut` defaults `emailLlm` to a throwing stub (`mount-cores-scribe-fan-out.ts:208-212`); `mountOpenCores` builds a real substrate-backed one at `mount-open-cores.ts:291-296`. So the memory-side email scheduler currently has neither client nor LLM. Any client-threading fix must thread the LLM too or email triage inside the fan-out mount degrades to the deterministic fallback.
- DUPLICATION WARNING: the fan-out mount builds its OWN calendar/email schedulers (`mount-cores-scribe-fan-out.ts:199-203`, :230-234) while `mountOpenCores` separately wires calendar/email Cores for MCP tools + chat filters. Two scheduler stacks over the same substrate. The "no duplicate poller" invariant is claimed at :30-32 but the moment both stacks get real clients, both will poll Google. Design must resolve this (see §5).

### 0.4 Tiered-write invariant — CONFIRMED

`scribe/reflect/reflect-pass.ts:19-25`: "deterministic work runs on every save...; the LLM is invoked ONLY inside this batch pass. This module adds ZERO per-save cost." Cost observability via `report.llmCalls` (:182-183, incremented at :902).

### 0.5 Reflect pass mechanics — CONFIRMED (richer than briefed)

`runReflectPass` (`reflect-pass.ts:226-277`): snapshot-enumerate (:243-250) → Step 1 deterministic Jaccard dedup (:264, `dedupPages` :411-461, merge with survivor-first write + CAS-delete of losers :473-629) → Step 2 LLM re-synthesis, edge-guarded (:267-269, rejection unless every prior wikilink survives :669, no-op-write guard :674) → Step 3 reserved-kind extraction (meeting/project/original) additive-merge (:746-826). All writes go through optimistic-concurrency preconditions (`ifBodyEquals`, `runtime/entity-writer.ts:140-157`). Idempotence guards exist per-step (dedup content-idempotent fold :504-516; resynth skips identical output :670-674; reserved skips already-present facts :782-784).

### 0.6 Entity writer / backlinks — CONFIRMED

- `runtime/entity-writer.ts:160-173`: `EntityWriteOutput` carries `newLinks`; the `SyncHook` contract (:217-224) carries `newLinks` + `removedLinks`.
- Unrecovered post-commit drift is explicitly documented at `runtime/entity-writer.ts:202-215`: a failed `MemoryStore.add` is not re-attemptable (writer short-circuits no-op rewrites) and a failed `kg_invalidate` is permanent ("Recovery... is a separate graph-repair / re-index pass, out of scope").
- `runtime/auto-link.ts:214-249`: `extractTypedLinks` parses refs and collapses to one triple per (subject,object) keeping the strongest predicate.

### 0.7 Scheduler ownership — CONFIRMED

`wireMemory` builds the `SupervisedLoop` but does NOT start it (`open/wiring/memory.ts:377-378` note). The composer registers the quiescing `stop()` cleanup early (`open/composer.ts:1046-1059`, before memory cleanups so shutdown quiesces an in-flight tick before GBrain closes) and arms register+start LAST (:3393-3410) so a composition failure can't leak a running interval (test: `open/__tests__/reflect-loop-arming.test.ts:179-201`).

## 1. Memory tiers — what is stored where

One correction to §0.3's duplicate-scheduler warning after further verification: `mountCoresScribeFanOut` is the ONLY production constructor of `buildPreMeetingBriefScheduler` / `buildTriageScheduler` (grep 2026-07-20: the only non-test call sites are `gateway/cores/mount-cores-scribe-fan-out.ts:199` and `:230`). `mountOpenCores` builds clients for MCP tools + chat filters, not schedulers. Threading the real clients into the existing mount keeps the single-poller property.

### T1 — Entity pages: the canonical record

- **What:** `<owner_home>/entities/<kind-dir>/<slug>.md` — frontmatter + compiled-truth (current belief, the ONLY graph-edge source) + append-only dated timeline (history). Kinds: person, company, concept + reserved meeting, project, original (`runtime/entity-format.ts` via `ENTITY_KINDS`).
- **Writers:** chat scribe (`scribe.handleUserTurn` → `writeExtractionToGBrain` → `writeEntity`), Cores fan-out (same path, `extractFromCoresSource`), reflect pass (merge / resynth / reserved), onboarding materializer, Connect mirror imports. ALL writes go through `runtime/entity-writer.ts:writeEntity` — single write seam, per-(kind,slug) lock, CAS preconditions, atomic rename.
- **Readers:** the agent (file reads + search results), RB1 manifest generator, reflect pass, Connect fan-out.
- **Canonical-truth invariant (the load-bearing property of this whole design):** T1 is the ONLY tier whose loss is data loss. Every other tier must be REBUILDABLE from T1 by a deterministic pass. This is what makes supersede/invalidate/consolidation safe to ship: the worst outcome of any downstream bug is a rebuild, not loss.
- **Retention/GC:** compiled-truth is bounded by consolidation (resynth tidies; dedup collapses page-level duplicates). Timeline is append-only and currently UNBOUNDED — accepted for now; the drift-watermark (§3.3) prevents it from driving unbounded LLM cost. A timeline-archival policy (fold rows older than N months into a summary row) is explicitly future work, NOT in this build.

### T2 — GBrain: the recall index (derived)

- **What:** the per-tenant brain — pages + typed edges (+ optional embeddings). Sole memory store per the MM decision (Appendix B.5).
- **Writers:** ONLY the `SyncHook` fired by `writeEntity` on real changes (`runtime/entity-writer.ts:217-224`): page add, `add_link` per new triple, `remove_link` per removed triple (`gbrain-memory/GBrainSyncHook.ts`, incl. the deferred-edge retry queue for not-yet-written targets), plus the reflect pass's kind-qualified `deletePage` for merged-away losers (`open/wiring/memory.ts:366-367`).
- **Readers:** `gbrain_search` (agent recall during conversation — the Vajra "recall" verb, Appendix A.1).
- **Retention/GC:** mirrors T1. Known drift class: post-commit hook failure (`entity-writer.ts:202-215`) — unrecoverable in-band BY DESIGN; recovered out-of-band by the repair pass (§7.4). `gbrain_sync_state` (`open/wiring/memory.ts:173`) is the observability sink that tells an operator drift is happening.

### T3 — Reflection stores: diary + corrections (behavioral memory)

- **What:** `diary/` (agent's own breadcrumbs) + `corrections/` (owner corrections with why) under owner home (`reflection/index.ts:1-21`).
- **Writers:** `onTurnComplete` post-turn hook (deterministic pre-gate → LLM correction-judge → append). Append-only.
- **Readers:** `loadContext()` splices `<learned_corrections>` + `<recent_diary>` into first-turn context; the reflect pass (NEW, §2) reads corrections for pattern promotion.
- **Retention/GC:** stores are append-only; the read path already windows to recent entries. Promotion (§3.4) is the graduation path: a recurring correction becomes a T1 concept page (durable), so the raw log never needs to be the long-term carrier.

### T4 — Derived surfaces (all regenerable, none load-bearing)

- **RB1 memory-index manifest** (`entities/INDEX.md` via `runtime/memory-index.ts`) — cold-turn breadth injection; regenerated on every entity write + boot bootstrap (`open/wiring/memory.ts:195-212`). Backend-neutral: reads T1, never GBrain.
- **`gbrain_sync_state`** — sync-health observability rows in project.db.
- **Nexus sidecar** (`.nexus/`) — learning/decision events for build agents (RC2).
- **NEW in this design: `memory/reflect-log.jsonl`** — one row per reflect pass (the `ReflectReport` + per-action detail), currently DISCARDED (the loop tick at `open/wiring/memory.ts:373-375` drops the report). This becomes the daily-delta substrate, the migration verifier, and the supersede/merge audit trail. See §3.5, §4.4, §7.
- **Retention:** manifests regenerate; logs get a size-capped rotation (deterministic, part of the pass).

### What is deliberately NOT a tier

No MemPalace equivalent, no second structured KG, no separate "patterns" store: the GBrain graph + T1 concept pages carry all of it (MM decision). Vajra's four verbs map onto these four tiers (Appendix A.1) without new stores.

## 2. The tiered-write invariant — capability placement

The invariant as stated at `scribe/reflect/reflect-pass.ts:19-25` is two-tier (deterministic per-save; LLM per-batch). The real system has THREE write tiers — the per-TURN extraction tier is LLM-shaped and already exists, budget-governed. Restated precisely:

- **Tier A — per-turn (LLM, budgeted, fire-and-forget):** judgment about WHAT the turn means. Never blocks chat; governed by the per-instance scribe budget (`scribe/scribe-budget.ts` token bucket) and the reflection judge's pre-gate. Cost scales with usage.
- **Tier B — per-save (deterministic, synchronous with the write):** mechanics of ONE page changing. No LLM ever. Cost is O(page).
- **Tier C — scheduled batch (6h; deterministic steps + LLM steps, capped):** anything needing corpus-wide view or expensive judgment. The ONLY place batch LLM cost is incurred; every dispatch counted (`report.llmCalls`).

Placement of every capability, each in exactly one tier:

| Capability | Tier | Justification |
|---|---|---|
| Entity/relation extraction (chat + cores) | A | Judgment over one turn's text; needs no corpus view. Already built (`scribe/extract.ts`). |
| Correction detection (judge) | A | Same shape: one turn, one judgment (`reflection/detector.ts`). |
| Supersede decision (emit `supersedes` marker) | A | It is part of interpreting the turn ("Alice moved to NewCo") — the extractor is the only component seeing the assertion. Mechanics of ACTING on the marker are Tier B. |
| Render/diff/edge-extraction, `removedLinks`→`remove_link`, temporal invalidation mechanics | B | Pure functions of (old page, new page) (`entity-writer.ts`, `auto-link.ts`, `write-to-gbrain.ts:mergeExistingCompiledTruth`). |
| **Backlink integrity (NEW)** | **B, event-driven — with a C sweep as backstop** | Endorses the architecture-review split over a literal port of Vajra's scheduled task (a). Checking whether `[[target]]` exists is a file-existence check on the page just written — deterministic, O(links-on-page), and the drift is CREATED by a write event (a page renamed/merged/deleted), so the sync hook is the natural place. The C-tier sweep exists because B-tier repair only sees pages being written: a dedup merge that deletes `[[loser]]` breaks links on OTHER pages that may not be written again for months. The sweep is deterministic (no LLM) and cheap. |
| Near-duplicate dedup/merge | C, deterministic | Requires corpus-wide pairwise view; cannot be per-save. Already built (reflect step 1). |
| Compiled-truth re-synthesis (consolidation proper) | C, LLM | Needs the full page history + judgment; the definitional batch-LLM job (reflect step 2). |
| Reserved-kind extraction (meeting/project/original) | C, LLM | Corpus-digest judgment (reflect step 3). |
| **Correction-pattern promotion (NEW)** | **C, LLM** | Endorses the review split: grouping N corrections by root cause is judgment over an accumulation — exactly the reflect shape. Vajra runs it inside dreaming at 6h (dreaming.md task e); here it becomes reflect step 4 (§3.4). |
| **Daily-delta note (NEW)** | **C, deterministic** | The review argued this is "time-anchored, arguably a separate ritual." Evaluated and REJECTED as a separate ritual: the delta is a REPORT OF WHAT THE MEMORY SYSTEM DID, and the memory system does things in reflect passes. Writing the report anywhere but the pass that did the work reintroduces a second scheduler + a second source of truth for "what happened." The pass appends its report to `memory/reflect-log.jsonl` every run (§3.5); the "daily" framing is a read-time rollup (the morning-brief ritual READS the log), not a write-time ritual. This keeps rituals consumers of memory, never co-owners of it. |
| Memory-index manifest regeneration | B (event) + boot bootstrap | Already correctly placed (`wrapSyncHookWithMemoryIndex`). |
| GBrain mirror repair (§7.4 doctor) | On-demand command (+ optionally C-tier drift check) | Not scheduled by default; it's a recovery tool, not a cadence. A cheap C-tier COUNT-level reconciliation (pages on disk vs pages in brain) is included in the pass report to DETECT drift. |

The one rule that must survive every future change: **no LLM call may ever hang off `writeEntity` or its sync hook.** Tier B is the hot path of every chat turn and every batch step; an LLM there makes write latency unbounded and cost proportional to writes. (This is why backlink repair's B-tier half is existence-check + exact/slug-normalized match only — Vajra's fuzzy-match half (dreaming.md:34) lands in the C sweep, and stays deterministic: normalized-string comparison, no LLM.)

## 3. Consolidation at 6h — concrete semantics + idempotence

### 3.1 What one pass does (target state)

Every 6h (`DEFAULT_REFLECT_INTERVAL_MS` changes from 24h to `6 * 60 * 60 * 1000` at `scribe/reflect/reflect-pass.ts:103`; the arming-test spy at `open/__tests__/reflect-loop-arming.test.ts:190` keys on the constant symbolically so it follows, but its "unique 24h cadence" uniqueness assumption must be re-checked against other loops' intervals at 6h), the `SupervisedLoop` tick runs, in order:

1. **Snapshot-enumerate** the corpus (symlink-contained, filename-is-identity — `reflect-pass.ts:295-336`).
2. **Dedup** (deterministic Jaccard, within-kind): survivor-first absorb → CAS-delete losers → kind-qualified brain delete. Existing, keep as-is.
3. **Backlink sweep (NEW step):** corpus-wide `[[wikilink]]` target-existence check; repair by slug-normalized unique match; orphans logged to the report (never auto-created — Vajra rule, dreaming.md:37). Deterministic.
4. **Re-synthesis** (LLM, edge-guarded, CAS) — gated by the drift watermark (§3.3).
5. **Reserved-kind extraction** (LLM, one corpus-digest call, additive-merge).
6. **Correction-pattern promotion (NEW step, §3.4)** (LLM, watermarked).
7. **Report append** to `memory/reflect-log.jsonl` (§3.5) + count-level disk-vs-brain reconciliation check.

Cost ceiling per pass is explicit: ≤ `maxResynthPages` + 1 (reserved) + 1 (promotion) LLM dispatches, each watchdogged (`DEFAULT_REFLECT_WATCHDOG_MS`), all on the dedicated ephemeral `cc-reflect-*` substrate with `tools: []` — off the warm chat session, satisfying the 3h-TTL decision.

### 3.2 Why 6h is safe where 24h was chosen for cost

The 24h default was chosen because "the batch is heavy" (`reflect-pass.ts:100-102`). 4x cadence is safe ONLY with the drift watermark below: today, every page with ≥3 timeline rows is re-synthesized EVERY pass regardless of whether anything changed (`reflect-pass.ts:660-662` gates on `page.timeline.length`, a monotonically-growing number). At 6h that is up to 200 LLM calls × 4/day forever, on a corpus that stopped changing. That is not a cadence problem, it is a missing-idempotence-gate problem — fix the gate, and cadence becomes nearly free on a quiet corpus.

### 3.3 The drift watermark — making idempotence structural

**Requirement (the brief's #3): a second pass over unchanged input must be a no-op.** Today that holds only step-by-step and only partially:

- Dedup: structurally idempotent (a merged cluster is gone; content-idempotent fold at `reflect-pass.ts:514-516` guards retained-loser re-merges). ✅
- Re-synthesis: behaviorally idempotent AT BEST — the no-op guard (`reflect-pass.ts:674`) only fires if the LLM returns byte-identical text. LLM nondeterminism means a quiet page can churn (rewrite + timeline row + sync-hook fan-out) on any pass, and even the no-op case COSTS an LLM call per page per pass. ❌
- Reserved kinds: skip-if-fact-present (`reflect-pass.ts:782-784`) makes repeats cheap, but the corpus-digest call is spent every pass and a wording-variant fact accretes a near-duplicate sentence. Partially ✅.

**Design: a per-page consolidation watermark, stored in frontmatter.** On a successful (accepted, written) resynth, the writer stamps `consolidated_rows: <timeline.length at consolidation>` (alongside the existing frontmatter merge). The step-4 gate becomes: resynthesize only when `timeline.length - (consolidated_rows ?? 0) >= resynthMinTimelineRows`. Consequences:

- A page nobody touched since its last consolidation is SKIPPED — zero LLM calls. A second pass over an unchanged corpus dispatches step-4 zero times, structurally.
- The LLM-nondeterminism churn window shrinks from "every pass" to "once per ≥3 new rows" — bounded by real activity.
- The stamp rides the SAME atomic CAS write as the resynth itself (no separate write, no new race).
- MIGRATION NOTE: existing pages have no `consolidated_rows` → `?? 0` means the FIRST pass considers every ≥3-row page drifted. That is correct (months of unconsolidated accretion SHOULD consolidate once) but is exactly why the first pass is cost-bounded and gated (§6).

Step 5 gets the cheap version: skip the reserved-kind dispatch entirely when zero pages changed since the previous pass (derivable from the report log's last-pass page-count/mtime watermark). Step 6 has its own high-water mark (§3.4). With those three gates, **the whole pass over unchanged input performs 0 LLM calls and 0 writes** — the acceptance test in §8.2.

**Adopted Vajra discipline, adapted (Appendix A.2 #1):** full MemGPT skeleton-only regeneration is NOT adopted (Neutron's edge-guard + CAS + no-op guard already block the worst outcomes, and skeleton-only requires structured compiled-truth we don't have). Adopted instead: (a) the resynth prompt gains Vajra's churn rule — "if the current compiled-truth is already an accurate consolidation, return it EXACTLY unchanged; never rephrase for style" (turns LLM nondeterminism from a coin-flip into an instructed no-op); (b) the freeform-churn REJECT: if the rewrite's wikilink set AND sentence count are unchanged and the diff is wording-only (deterministic check: normalized token overlap > threshold), skip the write. Cheap approximation of Vajra's additive/corrective/freeform classifier without an extra LLM call.

### 3.4 Correction-pattern promotion (new step 6)

Reads the T3 corrections store (`reflection/corrections-store.ts` read surface), windowed by a high-water mark persisted in the reflect log (last promoted correction timestamp — Vajra's cross-day marker discipline, dreaming.md:171-178). One LLM dispatch: group new corrections by root cause; a cause reaching ≥3 occurrences (across history, not just the window — Vajra rule, dreaming.md:79) emits a pattern. The pattern is WRITTEN AS A T1 CONCEPT PAGE (kind `concept`, slug `pattern-<cause-slug>`, `source: reflect:promotion:<slug>`) through the standard `writeEntity` path — so it lands in GBrain, the manifest, and first-turn recall like any other knowledge, with the correction ids in the timeline row as provenance. Temporal validity (Vajra's permanent/90d/30d, dreaming.md:95-101) is a frontmatter `valid_until` field; the manifest generator and reflection context reader learn to omit expired patterns (deterministic read-time filter — nothing is deleted; expiry is a read policy, T1 stays append-only).

### 3.5 The reflect log — consolidation becomes observable

The tick currently discards the `ReflectReport` (`open/wiring/memory.ts:373-375` awaits and drops). Every pass now appends one JSONL row: `{ts, scanned, merged, resynthesized, reservedWritten, promoted, backlinksRepaired, orphans, llmCalls, supersedes: [...], merges: [{survivor, losers}], durationMs, diskPages, brainPages}`. This is: the §8 behavioral test surface, the §6 migration verifier, the §7 audit trail, and the daily-delta substrate (a morning ritual reads the last 4 rows — Vajra's "Brain delta" (dreaming.md:54-71) becomes a read-time view). Size-capped rotation, deterministic.

## 4. Supersede vs temporal invalidation vs delete — semantics

Four distinct operations, from weakest to strongest. The unifying rule: **compiled-truth is current belief; timeline is immutable history; the graph mirrors compiled-truth only.** Nothing in this section touches a timeline row, ever.

### 4.1 The operations, precisely

| Operation | Trigger | Effect on compiled-truth | Effect on timeline | Effect on GBrain | Reversible? |
|---|---|---|---|---|---|
| **Accrete** (default) | any extraction | sentence appended (dedup on exact sentence) | dated row appended | `add_link` | n/a — additive |
| **Edge invalidation** (mechanical) | compiled-truth diff drops a triple: predicate upgrade collapse (`write-to-gbrain.ts:485-509`), resynth that legitimately restructures prose, or a supersede strip | (is the cause, not the effect) | untouched | `remove_link` via `removedLinks` (`entity-writer.ts:190-196`) | yes — re-assert the sentence; edge re-extracts |
| **Supersede** (semantic, RB4) | extraction emits `supersedes` on a relation: SAME (subject, predicate), NEW object replaces prior object (`scribe/extract.ts:41-55` — deliberately NOT renames or ended-without-replacement) | prior object's sentence(s) STRIPPED (`mergeExistingCompiledTruth` → `stripSupersededSentences`, `write-to-gbrain.ts:511-518`); new sentence appended | untouched; old belief survives as its own earlier dated row; new belief lands as a new dated row | old edge `remove_link`'d, new edge `add_link`'d — one mechanism (the diff), no special graph op | yes, from history: the dated rows record both beliefs. See 4.2 for the flag-off-era caveat. |
| **Delete** (page-level) | dedup merge only | loser's compiled-truth ABSORBED into survivor BEFORE deletion (`reflect-pass.ts:496-519`) | loser's timeline UNIONED into survivor (`reflect-pass.ts:522-524`) | loser page deleted, kind-qualified + sibling-checked (`reflect-pass.ts:582-614`) | partially — content survives in the survivor; the page identity does not. Un-merge is manual (from audit log / snapshot). |

**Meaning assigned:** a superseded fact is *"no longer current; historically true"* (recall must stop returning it as current; history keeps it). An invalidated edge is a graph-hygiene event with no independent meaning (it always follows from a compiled-truth change). A deleted page never loses content — only identity. There is NO operation meaning "this was never true"; a wrong fact is corrected by superseding or editing compiled-truth, and history honestly records that we once believed it. That matches Vajra's append-only correction rule (RESOLVER.md:70).

### 4.2 Two gaps in the current supersede implementation

1. **The transition is not recorded in history.** `relationNotes` (`write-to-gbrain.ts:438-450`) records `<pred> <obj>` for the NEW assertion but drops the `supersedes` field, so the dated history shows OldCo… NewCo… with the replacement relationship unrecorded. Since `r.supersedes` is part of the extraction, including it keeps `timelineBody` a pure function of the extraction (the replay-idempotence property argued at `write-to-gbrain.ts:405-420` is preserved). Change: note format becomes `works_at newco (supersedes oldco)`. Now the timeline alone reconstructs both the old belief AND when/why it was retired.
2. **Flag-off-era rows can't back a reversal.** Every timeline row written while the flag was off is fact-text only (`timelineBody` returns `base` — no relation notes). For those pages the ONLY structured record of the old relation is the compiled-truth sentence that supersede strips. Reversal is then manual-from-snapshot, not mechanical-from-timeline. This is a migration property, not a code bug — mitigated by the §6 pre-first-pass snapshot, and it decays: every post-collapse write records relation notes.

### 4.3 First-live-run verification (these paths have NEVER run on a real install)

Supersede + invalidation change what recall RETURNS, silently. The first live run is verified in three layers (§9 gates): (a) unit/behavioral per §8; (b) on the real install, a planted-fact probe: assert `works_at OldCo` recallable → plant "Alice moved to NewCo" in chat → assert recall returns NewCo AND NOT OldCo-as-current, page shows the stripped sentence gone + both dated rows + the supersede note; (c) every supersede event is a row in the reflect/audit log (§4.4) reviewed manually for the first week of live operation (count expected ≈ real job-change-like statements, i.e. LOW; a spike = extractor over-triggering).

### 4.4 Audit: every destructive-ish action leaves a row

Supersede strips, dedup merges (survivor + losers + byte-counts), and brain deletes each append a structured row (supersedes to a `memory/supersede-log.jsonl` written at Tier B; merges into the reflect log at Tier C). This is the answer to Vajra's "never auto-merge" discipline (dreaming.md:52): Neutron DOES auto-merge — justified because unlike Vajra's flag-for-Ryan model there is no daily human reviewing flags on a thousand installs, and the CAS + absorb-first construction makes a wrong merge recoverable — but every merge is loudly logged, surfaced in the delta view, and reversible from the audit trail + snapshot. Detection of a BAD merge (Jaccard false positive on two same-named people) is §7.2.

## 5. Scribe email/calendar fan-out — threading the real clients

### 5.1 The constraint set

- Real `calendarClient` / `gmailClient` are built inside `mountOpenCores` (`mount-open-cores.ts:242-249`, :255-262) at `composer.ts:1147` — after `wireMemory` (:1044) has already mounted the fan-out with in-memory fallbacks baked in.
- The schedulers CLOSE OVER their client at construction (`mount-cores-scribe-fan-out.ts:185-203`, :206-234) and `start()` immediately (:245-250) — so a setter-style late-bind into an already-started scheduler is not possible without invasive scheduler changes.
- The email path ALSO needs `emailLlm` + `emailModel` (currently a throwing stub in the fan-out mount, :208-212, vs the real substrate-backed one at `mount-open-cores.ts:291-296`) and should share `userTz`.

### 5.2 Options

**A. Reorder the composer** (mountOpenCores before wireMemory). Rejected. The span between :1044 and :1147 threads `wireMemory` outputs (scribeOnUserTurn, gbrainSyncHook, reflection, …) into intermediate wiring; the composer's carve history (`open/wiring/memory.ts:1-18` — "behavior-preserving extraction", "SIGTERM ordering byte-identical") shows ordering here is load-bearing. A reorder risks silent lifecycle/teardown regressions across unrelated subsystems for a memory-local problem. Blast radius: the whole composition.

**B. Holder/proxy clients** (wrap a mutable holder in a delegating CalendarClient/GmailClient, fill after :1147). Workable but rejected: it hides a temporal gap INSIDE the client (calls before fill must no-op or buffer — a new, subtle state machine), duplicates what the schedulers' own start already does, and the initial tick at mount time (:236-244) would run against the empty holder — reintroducing "runs harmlessly, fans out nothing," the exact silent-deadness this design exists to kill.

**C. RECOMMENDED — defer the MOUNT, not the clients: split build from arm.** `wireMemory` stops mounting the fan-out; instead it returns `armCoresFanOut(clients: {calendarClient, gmailClient, emailLlm, emailModel, userTz}) => cleanup` (closing over `scribe`, `project_slug`, `owner_home`). The composer calls it right after `mountOpenCores` (:1147+), passing the REAL clients, and pushes the returned cleanup. `MountedOpenCores` gains `calendarClient`, `gmailClient`, `emailLlm` fields (additive interface change at `mount-open-cores.ts:132-149`; the instances already exist as locals).

Why C: it is the composer's OWN established pattern for exactly this ordering problem — build-in-wireMemory / arm-by-composer-later is precisely how `reflectLoop` works (`open/wiring/memory.ts:377-378` + `composer.ts:3393-3410`), and late-binding via the wiring return surface is how `setMemoryIndexWorkHandles` works (`memory.ts:69-76`). No proxy state machine, no reorder, no window where schedulers run with fake clients. The scheduler start moves ~100 lines later in composition — no behavioral loss (nothing between :1044 and :1147 needs the schedulers running; their first real fire is timer-driven).

Risks of C, named: (i) if the composer forgets to call `armCoresFanOut`, the fan-out is dead again — closed by making the §8.3 composition test assert client identity end-to-end (the test fails if arm is never called); (ii) a composition failure between wireMemory and the arm call must not leak — the arm-last + cleanup-registered-early discipline already solved this for reflectLoop, copy it; (iii) LLM-less boxes: `scribe === null` → `armCoresFanOut` is a no-op returning a no-op cleanup (mirrors today's `if (scribe !== null)` gate at `memory.ts:314`).

OAuth-less boxes keep the in-memory fallback SEMANTICS but now by the composer's explicit choice: `mountOpenCores` already builds in-memory clients when OAuth is unconfigured (:249, :262), and those same instances get passed — one construction site, no dual path. When the owner connects Google later: the clients resolve tokens lazily per-call through the credential resolver (accessor thunks, `mount-open-cores.ts:207-216`), so a mid-session grant goes live without re-mounting — EXCEPT the oauthConfigured branch itself (:242-249) picks in-memory vs Google at boot; a grant on a box booted OAuth-unconfigured needs a restart. That restriction exists today for MCP tools/chat filters too; acceptable, noted.

## 6. Migration — flag-off installs meeting consolidation for the first time

### 6.1 What actually changes for an existing install

An install that has accreted for months with the flag off has: entity pages (chat extraction was always on), NO manifest, NO nexus, timeline rows WITHOUT relation notes (§4.2.2), never-deduped/never-consolidated pages, an unread corrections store. On upgrade to the collapsed build: the manifest bootstraps at boot (already handled — `memory.ts:206-210` regenerates from the existing corpus), supersede semantics apply to FUTURE extractions only (nothing retroactive — the extractor emits markers from new turns; no batch job invents supersedes over old data), and the reflect loop arms with first tick ONE interval away (`immediate:false`, `memory.ts:338-340` — a fresh boot never fires LLM work synchronously).

### 6.2 Is the first pass over months of memory safe? Bounded? Reversible?

**Bounded — yes, structurally:** enumeration is O(corpus) file reads; dedup is deterministic CPU; LLM cost ≤ `maxResynthPages` (200) + 2 dispatches per pass regardless of corpus size, each watchdogged. A 5,000-page backlog does NOT mean a 5,000-call first pass — it means up to 200 resynths per pass, worst-case ~25 passes (~6 days at 6h) to drain, which is the correct shape: a rate-limited backlog drain, not a thundering herd. (First-pass wall-clock and token spend on RYAN'S actual install size: unverified — measured at the §9 gate before arming the loop.)

**Safe — yes, with the §3.3 watermark:** every mutation is CAS-guarded against concurrent writes; resynth is edge-guarded; dedup absorbs before deleting. The dangerous first-pass behavior is VOLUME of legitimate change (many merges + many resynths in one pass), which is a review problem, not a correctness problem — hence the log + snapshot.

**Reversible — yes, by construction, one addition:** before the FIRST-ever pass mutates anything, the pass writes a one-time snapshot: `tar` of `entities/` to `memory/pre-consolidation-snapshot-<ts>.tar.gz` + a marker file; skipped ever after. Deterministic, cheap (text corpus), and it converts every §7 recovery story from "reconstruct from timeline" to "restore/diff against snapshot." GBrain needs no snapshot — it is rebuildable from T1 (§1.T2) via the doctor (§7.4).

**Rollout sequencing (not a flag — an operational gate):** the build ships consolidation ON, but the §9 order puts a MANUAL single pass (a CLI/admin invocation of `runReflectPass` with the report printed) on Ryan's install BEFORE the release that arms the loop. Same code path, human-reviewed first output. That is the "verify the loop actually consolidates" acceptance in SPEC M2-3, made concrete.

## 7. Failure modes and recovery

Ordered by user-visible severity. Common infrastructure: the reflect log + supersede log (§3.5, §4.4), the pre-first-pass snapshot (§6.2), and the doctor (§7.4).

### 7.1 Bad supersede (the flagship risk — changes what recall returns)

- **User's side:** a still-true fact silently stops being recalled as current. "Where does Alice work?" → only NewCo, when the user never said she left; worst case the extractor hallucinates a `supersedes` on an unrelated object and an unrelated fact vanishes from current belief.
- **Blast radius, bounded by construction:** ONE sentence in ONE page's compiled-truth + its edge. Timeline untouched; no cascade (strip is sentence-exact, `stripSupersededSentences` keyed on the prior object's sentence).
- **Detection:** every strip logs `{page, strippedSentence, newSentence, sourceTurnId, ts}`. Weekly-review during bake-in (§4.3); a rate alarm (supersedes per 100 extractions above threshold) in the pass report. The extractor prompt's own guardrails (`SUPERSEDE_GUIDANCE`, `extract.ts:105-112` — "Never guess", explicit non-cases) are the first line.
- **Recovery:** mechanical — the log row contains the exact stripped sentence; re-append it to compiled-truth (restores the edge via re-extraction on the next write) and the false new belief is itself superseded or edited out. No data was lost at any point (timeline + log both held it).

### 7.2 Bad merge (Jaccard false positive — two real entities blended)

- **User's side:** one page describing two people/companies; recall mixes their facts. (Classic: two "John Smith"s — same-name pages have high title similarity.)
- **Detection:** every merge is a log row with survivor/losers + similarity score; merges surface in the delta view. Heuristic tripwire in the pass: flag (log loudly, still merge — or optionally require-review, see open question §9) any merge where the two pages share a slug-normalized NAME but have disjoint relation-object sets — the same-name-different-person signature.
- **Recovery:** the survivor's absorbed `## Merged` sections + unioned timeline (rows carry per-page provenance sources) allow a manual split; the snapshot allows a clean restore of both pages for the first-pass era. GBrain follows via doctor re-index.
- **Prevention lever:** `jaccardThreshold` is already injectable; the bake-in period tunes it on real data before we consider auto-merge settled.

### 7.3 Reflect churn / cost runaway

- **Symptom:** token spend every 6h with no corpus change (the §3.3 pre-watermark behavior), or a page ping-ponging between two LLM phrasings.
- **Detection:** `llmCalls` + `resynthesized` per pass in the log; the §8.2 no-op invariant test guards the code path; an operational alarm on N consecutive passes with `resynthesized > 0` on an idle install.
- **Recovery:** the watermark caps it structurally; a stuck page is visible by slug in the log.

### 7.4 GBrain drift (post-commit hook failures, the documented unrecoverable class)

- **Symptom:** disk says X, recall says Y (stale edge survives, new page missing from search).
- **Detection:** `gbrain_sync_state` failure rows (already wired, `memory.ts:167-178`); the pass report's disk-vs-brain page-count reconciliation (§3.5).
- **Recovery — the `memory doctor` command (NEW):** deterministic full re-derivation of T2 from T1 — enumerate pages (same hardened scan as reflect), for each: brain-add page + reconcile edges to exactly the compiled-truth triples (add missing, remove extra), then delete brain pages with no disk counterpart. Idempotent, no LLM, safe to run any time. This ONE tool is the terminal recovery for every mirror-drift failure in this doc, and it exists because of the §1 canonical-truth invariant. Exposed as CLI + admin action; NOT scheduled (detection is scheduled; repair is deliberate).

### 7.5 Crash mid-pass

Every step is per-item try/caught (`runReflectPass` never throws, `reflect-pass.ts:222-224`); a process death mid-pass leaves: survivor-written-losers-not-yet-deleted (safe — content duplicated, next pass re-collapses via content-idempotent fold), or a written page whose sync hook never fired (T2 drift → 7.4). No compensation logic needed beyond what exists; the next pass converges. The `SupervisedLoop` + quiescing-stop composition (§0.7) already handles shutdown-during-tick.

## 8. Test strategy — behaviour, not arming

The repo's documented failure shape: subsystems wired, tested, green, doing nothing (the fan-out itself, `mount-cores-scribe-fan-out.ts:8-11` — "its only callers were tests"; the parity audit's 12 partial ports, SPEC.md 2026-07-19). Rule for this build: **every capability ships with (a) a behavioral test asserting the memory ARTIFACT changed, and (b) a real-install probe asserting the capability end-to-end, and the work is not DONE until (b) has run.** Arming/wiring tests are kept but never count as done.

### 8.1 Behavioral test suite (bun test, temp owner dir, fake substrate — the reflect-pass harness pattern, `reflect-pass.ts:29-31`)

1. **Consolidation consolidates:** seed 2 near-dup company pages + 1 distinct → pass → loser FILE gone, survivor compiled-truth contains the loser's unique fact + edge, fake memory store received the kind-qualified delete, report `{merged:1}`.
2. **Idempotence is total:** run the SAME pass again on the result → assert `llmCalls === 0`, zero writes (dir byte-identical via hash), report all-zero deltas. This is the §3.3 acceptance and the single most important new test.
3. **Superseded fact is no longer recalled:** through `writeExtractionToGBrain` with a supersedes extraction over an existing page → assert compiled-truth lost the old sentence + gained the new, sync hook received `removedLinks=[old triple]` + `newLinks=[new triple]`, BOTH dated timeline rows present, supersede-log row written. Then the recall-shaped assertion: a fake store that indexes compiled-truth returns the page for "NewCo" and the page's current-truth section no longer contains "OldCo".
4. **Backlink actually repaired:** page A links `[[bob-smith]]`; page exists as `bob_smith` variant → sweep rewrites the link in A's file; orphan `[[nobody]]` is NOT auto-created and IS reported.
5. **Correction promotion:** seed 3 same-root-cause corrections → pass → concept page exists with provenance timeline row; re-run → no duplicate (watermark); 2 occurrences → no page.
6. **Fan-out reaches the writer with REAL clients:** composition-level test (existing pattern in `open/__tests__/`) asserting the SAME client instance built by `mountOpenCores` is the one inside the armed fan-out (identity assertion), and a fake calendar event flows scheduler → scribe → `writeEntity` (extends the existing fan-out tests that currently prove the path only with injected in-memory clients).
7. **Watermark migration:** page with no `consolidated_rows` + 5 timeline rows → consolidated on first pass, stamped; second pass skips it.
8. **Doctor:** seed disk/brain divergence (extra brain page, missing edge, stale edge) → doctor → fake store exactly mirrors disk; run twice → second run zero ops.

### 8.2 Real-install probes (the (b) gates — scripted, run on Ryan's install, results pasted into the PR)

- **P1 (fan-out):** connected Google account → within one scheduler cycle, ≥1 entity page whose timeline row source is the calendar/email core, and the row's content matches a real event/mail. (SPEC M2-1 acceptance verbatim.)
- **P2 (consolidation):** manual pass invocation → reflect-log row with real `scanned/merged/resynthesized` numbers; spot-check one merged pair and one resynthesized page by eye.
- **P3 (supersede):** the planted-fact probe of §4.3 — plant, converse, assert recall flip + page state + log row.
- **P4 (recall regression):** before/after the first consolidation pass, a fixed 10-question recall script (facts known to be in memory) answers identically or better — the guard that consolidation didn't LOSE anything user-visible.

### 8.3 What we deliberately do NOT test-gate

Real-gbrain-binary integration in CI (fail-soft contract already covers absence; the probes cover presence), LLM output quality of resynth prose (edge-guard + churn-reject bound the damage; quality is reviewed via the log during bake-in).

## 9. Build order with verification gates

Order chosen so each step lands value alone, is verifiable before the next, and the flag collapse happens only when every behavior behind it is individually proven. All steps in neutron-open; each is one PR-sized unit with its §8.1 tests; gates in **bold** are §8.2 probes on the real install.

1. **Fan-out clients (M2-1, smallest fix largest effect):** §5.2-C split build/arm + `MountedOpenCores` exposure + emailLlm/userTz threading. Tests 8.1.6. **Gate: P1.** No flag interaction (the fan-out was never flag-gated).
2. **Observability substrate:** reflect-log JSONL + supersede-log + report persistence + disk-vs-brain count in report. Pure additive. (Everything after this is verifiable; do it before the behaviors it observes.)
3. **Reflect hardening:** `consolidated_rows` watermark + churn-reject + prompt no-op rule + reserved-kind skip-gate + backlink sweep step + correction-promotion step + pre-first-pass snapshot + 6h interval constant. Tests 8.1.1-5, 7. **Gate: P2 (manual pass, human-reviewed report) + P4.**
4. **Supersede history note** (§4.2.1) — small, rides with 3 or alone. Test 8.1.3.
5. **Flag collapse (M2-3 + the no-feature-flags rule):** delete `NEUTRON_PERFECT_RECALL` + `runtime/perfect-recall-flag.ts`; the four gated behaviors (reflect loop, RB4 supersede both halves, RB1 manifest, RC2 nexus) become the unconditional single path; update the default-off tests to default-on assertions; delete flag-conditional branches (`memory.ts:195/230/268/342`, `nexus-emit` re-export site). **Gate: P3 on the post-collapse build + one full observed 6h loop cycle on Ryan's install (reflect-log shows a scheduled — not manual — pass with sane numbers).** This step is LAST-but-one deliberately: collapsing first would arm unproven behavior on every fresh install.
6. **Memory doctor:** the §7.4 re-derivation command + test 8.1.8. Can land any time after 2; sequenced here so the collapse ships with its recovery tool in the same release. **Gate: run doctor on Ryan's install once; assert idempotent second run.**
7. **Bake-in week:** supersede/merge log review cadence (§4.3, §7.1-7.2), threshold tuning, then close the M2-3 SPEC item with the incident-verification structure (baseline / observation window / result).

Explicitly OUT of this build (recorded so they don't creep): timeline archival policy (§1.T1), nudge-preference learning (Appendix A.2 g), Vajra-data one-time migration (M2 cutover machinery — a separate import, not this subsystem), OAuth-grant-without-restart for the boot-time client branch (§5.2 note), scheduling the doctor.

Open question for Ryan (only one): §7.2 — when the same-name-different-relations tripwire fires, should the pass (a) merge anyway + loud log (my recommendation: keep memory self-maintaining, the log + snapshot make it recoverable), or (b) hold the pair as review-required in the delta view (Vajra's never-auto-merge instinct, at the cost of a human queue)? Default if unanswered: (a).

---

*Doc complete — sections 0-9 + appendices. Written incrementally with per-section commits on branch `memory-system-design-2026-07-20`.*

## Appendix A: Vajra reference architecture (read-only study)

Read 2026-07-20 from `~/vajra` (strictly read-only). What matters for Neutron is the SEMANTICS, not the mechanism — Vajra's mechanisms (MemPalace MCP, `claude -p` dreaming agent) are explicitly NOT ported (GBrain is the sole store; rituals run in-process).

### A.1 The verb test (`~/vajra/entities/RESOLVER.md:9-22`)

Four verbs → four stores:

| Verb | Vajra store | Neutron equivalent |
|---|---|---|
| **Recall** during conversation | MemPalace (structured, fast lookup) | GBrain search (`gbrain_search` keyword+graph, optional embeddings) |
| **Read** before conversation | `entities/` (compiled truth + timeline) | entity pages under `<owner_home>/entities/` + RB1 memory-index manifest injected on cold turns |
| **Derive** a pattern across interactions | MemPalace drawer tunneled → entities page | reflect pass (correction-pattern promotion → entity/concept page) — the gap this design fills |
| **Preserve** verbatim thinking | `entities/originals/` | the reserved `original` kind (`scribe/reflect/reserved-kinds.ts`) — reflect step 3 writes it |

Other RESOLVER rules that carry over: volatile project state NEVER goes in memory (RESOLVER.md:22, :30-31); dedup before page creation (:67); "a page with no timeline entries has no business existing" (:68); provenance mandatory (:69); timeline append-only, corrections are new entries not edits (:70).

### A.2 The dreaming ritual (`~/vajra/prompts/dreaming.md`)

Runs every 6h, silent, one-shot. Its tasks, with the Neutron mapping this design assigns (justified in §2):

| Dreaming task (Vajra) | Nature | Neutron placement |
|---|---|---|
| (a) Fix broken wiki-link backlinks on recently-touched pages | deterministic (existence check + fuzzy match) | per-save sync hook tier (event-driven) + reflect-pass sweep as backstop |
| (b) `last_verified` frontmatter update | deterministic bookkeeping | folded into whichever pass touched the page |
| (c) Flag near-duplicates, never auto-merge | deterministic (alias/email cross-product) | reflect pass step 1 ALREADY auto-merges via Jaccard + CAS — stricter than Vajra; see §4.4 for why auto-merge is retained with guardrails |
| (d) Daily-delta note ("Brain delta") | deterministic report of the run | reflect-pass report writer (scheduled, time-anchored) |
| (e) Correction-pattern scan (≥3 same-root-cause → promote) | LLM-shaped grouping | reflect pass (batch LLM tier), reading the reflection package's corrections store |
| (f) Promote patterns with temporal validity (permanent/90d/30d) | write with TTL semantics | entity/concept page + frontmatter validity — see §1.4 retention |
| (g) Nudge-preference learning | Vajra-specific (no Neutron nudge system yet) | OUT OF SCOPE — noted as future work |

Two Vajra disciplines worth importing verbatim:

1. **MemGPT State-rewrite discipline** (dreaming.md:146-169): the model regenerating a compiled-truth section must NOT see the old prose — only a field skeleton + fresh timeline evidence — to prevent "edit war drift" (each rewrite eroding fidelity). Neutron's resynth prompt (`reflect-pass.ts:633-641`) currently SHOWS the old compiled-truth. Vajra also diffs the output and REJECTS freeform wording churn. §3.3 adopts a hybrid.
2. **Idempotency-by-marker** (dreaming.md:171-178): re-run within the window is a cheap no-op; corrections scanning uses a cross-day high-water mark so the midnight fire doesn't rescan. Neutron needs the same watermark for correction promotion (§3.4).

Also notable: Vajra's dreaming NEVER creates pages to satisfy broken links (dreaming.md:37 — "Creation is the scribe's job, not yours") and never merges automatically (dreaming.md:52 — merging is Ryan-only). Neutron's reflect pass already crosses the second line (deterministic Jaccard auto-merge with CAS guards); the design keeps that but adds an audit trail (§4.4).

## Appendix B: Locked decisions honored (from neutron-managed SPEC.md)

Verified in `~/repos/neutron-managed/SPEC.md` Decisions Log, 2026-07-20 entries (line refs from the 2026-07-20 read):

1. **6h consolidation ON by default; flag collapsed** (SPEC.md:400-402): "memory consolidation runs at the VAJRA CADENCE — every 6h — and ships ON by default. The NEUTRON_PERFECT_RECALL env flag gating it is an unapproved feature flag on core behaviour; collapse to the single live path per the no-feature-flags rule."
2. **Dreaming's uncovered half goes INTO the core memory system** (SPEC.md:360-364): backlink repair, daily-delta notes, correction-pattern promotion built alongside consolidation, not as an `entity-upkeep` ritual. (The brief asks this design to evaluate the tier-split counter-argument — see §2.)
3. **3h idle TTL on per-project CC sessions** (SPEC.md:380-393): memory work must run off the warm chat session. The reflect loop already does (dedicated `cc-reflect-*` ephemeral substrate, `open/wiring/memory.ts:343-356`).
4. **M2 parity items** (SPEC.md:427-439): M2-1 scribe email/calendar clients (smallest fix, largest effect), M2-3 consolidation-on-by-default + "verify the loop actually consolidates."
5. **GBrain is the sole per-tenant memory store** (SPEC.md:74, MM decision 2026-06-06; notes-core removal 2026-07-01 at SPEC.md:531): no second memory backend may be introduced by this design.
6. **No feature flags / no dual code paths** (restated throughout, e.g. SPEC.md:194, :401): the design must specify ONE live path.
7. **Scheduled executors get restricted, per-project tool scope** (SPEC.md:395-398) — relevant boundary for any LLM-driven memory batch: the reflect pass's substrate has `tools: []` (`scribe/reflect/reflect-pass.ts:907-908`), which already satisfies this.
