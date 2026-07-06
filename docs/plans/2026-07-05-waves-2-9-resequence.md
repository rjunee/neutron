# Waves 2–9 Resequence — dependency-pinned execution order (post-audit)

**Date:** 2026-07-05 · **Author:** Fable 5 (principal-engineer planning pass)
**Inputs:** `docs/research/fable-refactor-audit-2026-07-05.md` §1–§4 (20-agent re-audit),
`docs/plans/2026-07-02-world-class-refactor-plan.md` (§1.3 lanes, §16 waves, §17 checklist, D-decisions),
`docs/plans/refactor-orchestration-STATUS.md`.
**State pin:** main HEAD `fd814d9` (#224). Merged: G1–G10, W0, W8 #197, W7-crash #200, F9 #194;
wave 1 K1 #217, K2 #215, K3 #216, K4a #219, K5 #218, K7 #224, K8 #221, K9 #220. **Parked:** K6 (PR #225 open).
**Deferred:** K4b, M0, K10, K11, D-11 audit-dir tracking. This doc folds the audit's ten §3
sequencing findings into ONE ordered ready-set and lists the §16/§17 plan edits a follow-up
docs unit should apply. It does not change any unit's internal scope except where noted.

---

## 0. Verified drift (audit anchors vs HEAD `fd814d9`)

16+ PRs merged mid-flight (#194–#224) moved text under the plan's cited anchors. Confirmed by
direct grep during this pass — these are FACTS the ready-set below already accounts for, and
they are why finding #5 (anchor re-grep) is promoted to a mandatory per-unit gate:

| Cited in plan | Reality at `fd814d9` |
|---|---|
| K11 deletion list includes "acceptChoice 1721-1988" | **Already deleted by K4a (#219)** — only comments remain (engine.ts:14, :1320, :1612). Every K11 engine.ts range is stale (file now 9,810 lines, was 10,078). |
| `open/composer.ts` = 3,220 lines; splice at :1616-1626 (S0, C3c); P6 re-arm :3248-3272; F8 :3236-3309; F9 substrate :3705-3706 | File is now **4,058 lines** (post #178–#200); the `/chat-react.js` splice sits at ~:1730. ALL composer anchors (C3a–C3d, S0, P6, F8, F9-adjacent) drifted. |
| `chat-bridge.ts` D3 partitions :2511-3043 / :3044+ | File is now **2,594 lines** (post-K2 −510). D3 partition ranges are stale. |
| trident `merge.ts` anchors (F6/F7/P10/K8-class) | Rewritten by #193 (per-run worktree isolation + self-heal). Re-grep before any trident unit. |
| §17 shows K7 unticked | K7 **merged** (#224) — the checklist drifted within hours of the bookkeeping PR (#223 landed before #224). |
| §16 wave-2 row lists "W8 F9" as wave-2 units | Both merged in Step 0 (#197, #194). Row is stale. |
| STATUS.md "main HEAD b3bdc63, entering WAVE 1" | Stale — wave 1 is complete except K6 (parked #225) + K11 (restructured below). |
| Audit §2 K11 target files (`llm-router.ts`, `interaction-mode.ts`, `resume-cron.ts`, `engine-slug.ts`, `personality-character-suggester.ts`, `build-llm-router.ts`) | All still present at HEAD — audit §2 findings remain live and are folded in below. |
| `reminders/outbound.ts` imports | Confirmed: `ChatOutbound` from `landing/server.ts` (:24) **and** `WebChatSenderRegistry` type from `chat-bridge.ts` (:25) — the file sits on BOTH the L1 edge and the K11a/L2 extraction. See finding #2/edge-#4 resolution. |

---

## 1. Per-finding resolutions (audit §3, findings 1–10)

### F1 — M0 pulled early; M-spine `M0 → {C1, K11b-accept}` and `M1 → {C2, C4}`
M0 (Managed CI, `sonnet`, S, lane `managed`, zero Open coupling) is **ready-set item #1 —
dispatch immediately**. It gates: (a) the entire C-wave (C1/C2/C3/C4 touch the 8 pinned
`open-contract.ts` surfaces with no Managed CI to trip today); (b) **K11b's acceptance**
("Managed vendored-tenant boot green" — plan §K11 accept line, audit §2 gates). Hard edges:
**M0 → C1**, **M0 → K11b(acceptance run)**, **M1 → C2**, **M1 → C4**.

**C1 contradiction, resolved before C1 dispatch:** plan §C1 says "One `config/` leaf" (repo
top-level), but Managed's contract gate pins `ENV_READ_DIRS` to `open/` + `gateway/` (M1c is
the extension mechanism). A top-level `config/` satisfies C1's letter and breaks the gate.
**Resolution (pick A):**
- **(A — default)** Home the BootConfig leaf at **`gateway/config/`** — inside the pinned dir
  set, no gate change, Managed stays green with zero coordination. Layering is unaffected
  (it's still a node-free leaf; depcruise bands don't care about the top-level dir).
- **(B — fallback)** If the build agent hits a real reason for top-level `config/`, C1 ships
  with the **M1 ENV_READ_DIRS extension in the same wave** (M1c) + M3 rider, and C1 does not
  merge before that Managed PR is green.
This is an orchestrator call, not an owner stop (no behavior/scope change). Write the choice
into the C1 build brief at dispatch.

### F2 — "Lane labels lie": corrected lanes from file-intersection
Re-derived from actual file lists in each unit spec (verified against HEAD):

| Unit | §1.3 label | TRUE intersection (files → lanes) | Corrected serialization |
|---|---|---|---|
| **L2** | `none` | `onboarding/interview/phase.ts`, `engine-internals.ts`, `final-handoff-config.ts`, `phase-spec-resolver.ts` (**engine**); `chat-bridge.ts:162` (**bridge**); `app-ws-surface.ts` (**transport**); `runtime/.../mcp-shim.ts`, `runtime/onboarding-conversational-flag.ts` (**substrate**); `trident/delivery.ts` (**trident**); `connect/agent-engagement.ts`, `gateway/proactive/sink.ts` | Multi-lane: needs engine+bridge+transport+trident+substrate ALL free. **Hard dep: K11b MERGED (not parked)** — L2 relocates types out of files K11 deletes/splits (`WebChatSenderRegistry`, `LlmCallFn` home, engine-internals). If K11 parks, L2 parks with it (or re-scopes to the non-engine cuts only, orchestrator decision). |
| **L5** | `none` | Repo-wide autofix (795 escapes, per-package batches) | **EXCLUSIVE barrier** — while an L5 batch is in flight, nothing else dispatches in ANY lane touching that package; run batches at wave boundaries / quiet points. |
| **L7** | `clients` | `chat-core/*` (~22 files) + `app/metro.config.js` | **clients+transport.** Collides with W5 (chat-core edits). Pin **W5 → L7 → L6** (L6 imports the renamed scope). |
| **L1** | `transport` | `landing/server.ts` + consumer flips in `chat-bridge.ts:45` (**bridge**), `reminders/`, `open/composer.ts:214` (**composer**), `proactive/` | transport, but the one-line consumer flips brush bridge+composer — serialize L1 against K11a (chat-bridge surgery) and never concurrent with a composer-lane unit. Order: **K11a → L1**. |
| **L3** | `composer+data` | Also `gateway/cores/mount-open-cores.ts`, `reminders/outbound.ts` (move), `migrations/`, `connect/`, `onboarding/`, agent-settings | Multi-lane (composer+data+transport+engine-adjacent). Runs alone in its slot, **after L2**, with the SCC re-derive gate (F4 below). |
| **W3a** | `transport` | `app_chat_messages` migration + `channels/adapters/app-ws/adapter.ts` | **transport+data** (migration). Serialize vs data-lane units. |
| **S0** | `transport` | `app-ws-surface.ts` + the composer bootstrap splice (`open/composer.ts` ~:1730) | **transport+composer(touch)** — fine early (composer lane idle), but never concurrent with a C-unit. |
| **K11a/K11b** | `engine` | Also `chat-bridge.ts` (bridge), `gateway/realmode-composer/build-llm-router.ts` + `open/composer.ts:94,~1108` repoints (composer-touch), `landing.registry` (transport-touch) | engine+bridge, with composer/transport touches — schedule with those lanes quiet. |
| **FX1** (new, audit §1.A1) | — | `gateway/boot-helpers.ts:641-642` + gateway test | **composer** lane (boot-helpers is a composer-lane file). |

Everything else's label held up under file-intersection review (D3 bridge; D8 transport;
C-wave composer-serial; D9 engine; P-wave data; F4/F6/F7/P7/P10 trident; O/X/N as labeled).

### F3 — Pinned spines (the serialization the waves must respect)
- **Kill→leaf→config spine:** **K11a → K11b → L1 → L2 → L3 → C1**, with **L3(c)
  (`resolveOpenDbPath` out of `open/owner-identity.ts`) merged BEFORE C1** — either L3 lands
  whole before C1, or L3c is split out and pulled ahead (it has NO pinning test today and
  wrong resolution order is a live-data hazard: `open/server.ts:58-73` env-mutation contract,
  both entrypoints). C1's build brief must state the exact resolution-order contract and add
  the pinning test L3c currently lacks. (Note: L1 before L2 also because L2's shims sit in
  files L1 flips; K11a before L1 because K11a's chat-bridge extraction moves L1's :45 anchor.)
- **Transport spine:** **S0 → W3a → W5 → L7 → L6**, with **L1 between W5 and L6**
  (full transport order: **S0 → W3a → W5 → {L1, L7} → L6 → D8-eligible**). The dev:owner
  hole (S0) and the half-open-socket fix (W5) are live P1s and must not queue behind
  mechanical extractions; S0 and W5 both touch `app-ws-surface.ts`/chat-core so the order is
  also a file-conflict necessity. **S0 additions (from audit):** reconnect re-fetches token
  on auth-reject; prefer per-INSTALL over per-boot token (a per-boot token strands connected
  clients on restart); verify the Expo client path explicitly.
- **Edge #4 (`reminders → landing`) is owned by L1, exactly once.** L1 flips
  `reminders/outbound.ts:24` (`ChatOutbound`) to the chat-protocol leaf → the reminders→landing
  edge dies there. **L2 drops edge #4 from its accept line** (its remaining touch on that file
  is the `WebChatSenderRegistry` TYPE import at :25, whose extraction is owned by **K11a**, and
  which L2 merely ratifies/re-homes). L3(b) later moves `reminders/outbound.ts` delivery
  wholesale into gateway composition — a third serialized touch: **L1 → (K11a already done) → L3b**.

### F4 — Mandatory evidence-refresh gates
1. **Per-unit anchor re-grep (EVERY unit, plan stage):** the Fable plan stage re-greps every
   file:line cite in the unit spec against HEAD before writing the build brief; any mismatch
   is reconciled in the brief; if the anchored CODE is gone/moved beyond recognition →
   **park-and-flag**, don't improvise. (§0 table above is the proof this is load-bearing:
   K11 cites already-deleted code.)
2. **Depcruise SCC re-derive before L2 and again before L3:** the 11-edge cut list predates
   #178–#224 (#184 touched the mcp↔runtime cut-#11 territory; K1–K9 deleted edge sources).
   Run `scripts/ci/depcruise.sh` + regenerate the SCC/cycle list vs HEAD; re-scope L2's cut
   list (#1,7,9,10,11 minus edge #4 per F3) and L3's (a)–(f) against the fresh graph. L3's
   accept ("no-cycles flips to hard-error, SCC = ∅") is only meaningful against the fresh
   baseline; the ratchet-growth guard (G8) already enforces shrink-only.
3. **L1 accept restated as grep-enforced:** L1's in-package staging (`landing/chat-protocol.ts`
   module, not a workspace package) is invisible to depcruise's package-level rules — restate
   L1's accept as a grep gate (zero direct imports of the moved names from `landing/server.ts`
   outside the shim) or add a depcruise sub-path rule for `landing/chat-protocol.ts`; the
   workspace-promotion decision stays deferred to L6.

### F5 — Trident self-surgery protocol (F4, F6, F7, P7, P10, RT1, any trident-lane unit)
These units modify the machinery that executes the window (K8-class risk). Protocol, enforced
by the orchestrator for every trident-lane merge:
1. **Concurrency cap = 1 window-wide** from the moment a trident-lane PR merges until its
   canary is green — no new unit dispatches (any lane) in that gap, because dispatch itself
   rides the modified machinery.
2. **No-op canary:** immediately post-merge, dispatch a trivial known-good run (docs-touch
   unit or a scripted no-op build) through the full pipeline; green canary reopens dispatch.
3. **Instant-revert readiness:** the orchestrator holds the staged
   `git revert <merge-sha>` + redeploy command before merging; a red canary executes it
   without deliberation, then re-parks the unit.

### F6 — W3 one-way door: staged three-PR shape (locked)
W3 stays wave 9 and becomes THREE serialized PRs — never one:
1. **W3-1 write-both:** widen `app_chat_messages` schema (nullable options/prompt_id/
   citations/doc_refs — W3a already added the meta column; G2 noted real schema work needed),
   keep the button_prompts double-write, add the new-column writes. Reversible.
2. **W3-2 read-flip:** point HTTP history + rail + staging at `app_chat_messages`; **G2 parity
   suite flipping pinned-divergent → full-parity IS the merge gate**; **file-level DB backup
   (`project.db` + sidecars) taken immediately before deploy of the flip.**
3. **W3-3 delete:** kill the double-write (`build-live-agent-turn.ts` + adapter) only after a
   **multi-day live soak** of W3-2 on the dogfood box.
**Window-end rule:** if wave 9 runs late, ship W3-1 (+optionally W3-2) and defer W3-3 past the
window — write-both is indefinitely safe; the delete is the one-way door.

### F7 — Wave-5 reorder + P6 pulled forward
**P6 (paid-synthesis data-loss, the plan's own P0) is pulled OUT of wave 5** to the front of
the data+engine queue — it needs nothing from L/C (its files: `build-synthesis-import-runner.ts`,
import_jobs sweep, composer re-arm), so it dispatches as soon as K11b frees the engine lane
(ready-set #10 below, i.e. late "wave 2" — even earlier than the audit's wave-4 suggestion).
Within the remaining wave-5 data/engine queues: **P6(done early) → RA1 → D9a→d
(decomposed against POST-P6+POST-K11b code, anchors re-grepped) → P4 → P11 (strictly last,
after P4)**. P1→P2/P3 stay wave 4 and don't conflict (db.ts vs import-runner files), but P2's
sweep re-touches P6's files → **P6 before P2**. F8 (composer, after P6) can then pull into
wave 5-6 whenever the composer lane is free.

### F8 — Ralph/SPEC.md tripwire (new unit RT1) before K10; K10 strictly last
**RT1 (new, S, lanes ci+trident):** (a) a leak-gate/CI rule that FAILS any PR adding a root
`SPEC.md` or `IMPLEMENTATION_PLAN.md` unless the PR carries an explicit
`ralph-governed-mode-ack` marker (protects against any agent "helpfully" creating one
mid-window — detectRalphMode triggers on existence, git-mode.ts, with force-ON and no
force-OFF); (b) inject **`resolveRalph: () => false`** at the window's dispatch point
(code-command.ts:159 — re-grep) for all window unit runs. Land RT1 EARLY (it's cheap; it is
itself trident-lane → F5 protocol applies). **K10 is strictly the last unit of the window**,
after X6 (D-12) AND after every parked/slipped unit is merged-or-formally-deferred, and K10's
own PR removes/updates the RT1 rule + carries the ack marker.

### F9 — Smaller pins (all adopted)
- **N4:** the rename map CARVES OUT the gate-pinned literals — the healthz `project_slug`
  response field and `NEUTRON_INSTANCE_SLUG` (both pinned by Managed's contract gate; the
  latter is persisted in per-tenant systemd `Environment=` lines). Either exclude them
  outright (rename everything around them; the literals get the secrets-store-style frozen
  header) or run a dedicated **N4-ABI slice EARLY (wave 3–4, while tenant-count == 1)** with
  its M3 rider + per-tenant systemd unit regeneration. Recommendation: **exclude from N4;
  schedule N4-ABI as its own decision-gated rider** — renaming a live-ops contract for
  vocabulary hygiene is optional; flag to Ryan (owner-flag ①).
- **S3:** add an acceptance line — **restore-drill required**: from a backup taken AFTER the
  key exclusion, a scripted restore (key from its new escrow location + ciphertext from the
  remote) round-trips a secret BEFORE the exclusion merges; document the key-escrow location.
  Otherwise S3 converts "backup remote can decrypt" into "owner can't restore".
- **Served-by-path accept lines** (the K1/connect-accept trap, memory
  [[refactor-deletion-served-by-path-trap]]) added to **L6, D8, P8, C2** — grep-zero-importers
  is NOT sufficient for URL/route-served or bundler-graph-reached files; each of these units'
  accept gains: "for every deleted/moved file, verify not served-by-path (route tables,
  Bun.build entrypoints, bundler graph, `open-contract.ts` surfaces) — evidence in PR body".
  Same line is mandatory in K11b (audit §2 already requires it).
- **§16/§17 truth:** mark W8/F9/W0 done in §16's rows; tick K7 in §17 — full edit list in §3.

---

## 2. The ordered ready-set (execution sequence, waves 2–9)

Legend: **dep =** must be merged first. Lane = corrected lane (F2). Gates listed are IN
ADDITION to the standing per-unit gates (§2.1). Concurrency cap 3 (distinct corrected lanes),
except where F5 (trident cap-1) or L5 (exclusive) says otherwise.

### 2.1 Standing per-unit gates (every unit, no exceptions)
1. Anchor re-grep at plan stage; park-and-flag on dead anchors (F4.1).
2. `bash scripts/ci/typecheck-all.sh` on rebase (44-tsconfig matrix; root+leaf tsc is not enough).
3. Cross-package consumer tests ([[refactor-orchestrator-gate-crosspackage]]) — shell/HTML/
   contract changes run the consumers' suites too.
4. Served-by-path check on every deletion (F9).
5. Depcruise ratchet (shrink-only) + leak-gate on a clean checkout for docs-touching units.
6. Codex cross-review; P1+ fixed or declined-with-rationale.
7. `bun install` after any main-merge before trusting tsc.

### 2.2 Block A — dispatch NOW (parallel; lanes disjoint)
| # | Unit | Model/size | Corrected lane | Deps | Unit-specific gates / notes |
|---|---|---|---|---|---|
| 1 | **M0** — Managed CI | sonnet · S | managed | — | Runs in `~/repos/neutron-managed`. Gates C1 + K11b-accept (F1). |
| 2 | **FX1** — K8 regression: narrow the `/code` unrecognized pre-check | sonnet · S | composer | — | Audit §1.A1: `gateway/boot-helpers.ts:641-642` → add `&& parsed.reason === 'not_a_code_command'`; seam pin test for `/code status` → reject. One line + test; restores the K8 lost coverage. |
| 3 | **FX2** — K3 lost coverage: re-port import-resilience wiring tests | sonnet · S | none (tests only) | — | Audit §1.A2 (+fold A3): port the deleted BLOCKER #2/#3 pins onto `buildLandingStack`/`buildOnboardingEnginePieces` (probe non-null, resume POST mounted, 404 unknown job); add units for relocated `import-payload-resolvers.ts` SSRF guards; decide/record the A3 `rate_limit_paused` question (test it or queue its deletion in the D9 brief). |
| 4 | **K11-pre** — re-anchor live import-subsystem integration tests | opus · M | engine | — | Audit §2 test re-anchoring gate: import-resume-button / hard-timeout / running-cron / analysis-presented suites re-anchored on `notifyImportUpload`/`pollImportRunningTick`/stateStore instead of engine.start/advance. **Merged + green BEFORE K11b; never same-PR.** |
| 5 | **RT1** — Ralph tripwire + `resolveRalph:()=>false` | sonnet · S | ci+trident | — | F8. Trident-lane ⇒ F5 cap-1 + no-op canary on merge. |

### 2.3 Block B — the K11 restructure + transport spine (wave 2 proper)
| # | Unit | Model/size | Lane | Deps | Gates / notes |
|---|---|---|---|---|---|
| 6 | **S0** — security quick-patch | opus · S | transport(+composer-touch) | FX1 (composer file peace) | + audit F3 additions: token re-fetch on auth-reject, per-INSTALL preferred, Expo path verified. Splice anchor drifted (~:1730). |
| 7 | **K11a** — extractions (NO deletions) | opus · L | engine+bridge(+composer-touch) | K11-pre | Audit §2 mandatory extractions 1–5: `WebChatSenderRegistry`+`LiveAgentTurnRunner` types → neutral module (resolves K11↔D3 circularity — the plan's named fallback); `AnthropicMessagesClient` types + `buildGatewayAnthropicMessagesClient` → neutral module + repoint 5 importers + composer/build-landing-stack + move its substrate test; interaction-mode import-leaf extraction (`IMPORT_SOURCE_SWITCH_ACK`, `LATE_UPLOAD_SOURCE_MISMATCH_NOTICE`, `detectImportSourceMention` + migrate the race test); `STATIC_PERSONALITY_CHARACTER_FALLBACK` + shapes → onboarding-preamble home; engine-slug SPLIT prep (extract the live open-mode agent-naming half). Retain-list per audit §2 travels into the brief verbatim. |
| 8 | **W3a** — resume-fidelity stage-0 | opus · S | transport+data | S0 | Migration + snapshot regen; G2 fields flip to parity. |
| 9 | **K11b** — the deletion | opus · L | engine(+bridge/transport-touch) | K11a, **M0**, FX2 | Deletes per plan §K11 minus the audit §2 retain-list; `engine-slug` deletes ONLY the slug_chosen managed remainder (~500-600 net, gated on D-5/K4b note); `NEUTRON_DEPLOYMENT_MODE` alias = MIGRATE the security pin test + 30-sec prod systemd grep before merge; `landing.registry` only after the K11a type extraction, keep warn-log, rewire/co-delete WowChannelAdapter, don't touch webTopicId/history/topics. Gates: root+leaf tsc via matrix, gateway/realmode-composer + open/ consumer suites, an EXERCISED upload-route check, **Managed vendored-tenant boot (needs M0)**, served-by-path evidence per file. Restart-recovery test pinning the composer-side start() replacements lands in-PR (plan §K11 care). |
| 10 | **P6** — import durability P0 (PULLED FORWARD, F7) | opus · M | data+engine | K11b (engine lane free; anchors re-grepped post-K11) | Restart-resume test per path fails pre-fix; honest-failure gate + cancel semantics untouched; idempotent vs 15-min hard timeout. |
| 11 | **M1** — contract-gate hardening | opus · M | managed | M0 | Gates C2/C4; holds the ENV_READ_DIRS extension if C1 resolution (B) is taken (F1). |
| 12 | **W5** — chat-core resilience | opus · M | transport | W3a | GAP-1/2/4/5; half-open + flap simulated test. |
| 13 | **M2** — thread claim-URL seam / delete dead composer-module seam | opus · S | managed(+gateway-touch for the delete) | M1 | Per §16 wave 2. The `NEUTRON_GRAPH_COMPOSER_MODULE` delete half runs in Open (composer lane) — schedule that sub-PR when composer lane is free. |

### 2.4 Block C — leaf spine + C1 (waves 2→3 boundary)
| # | Unit | Model/size | Lane | Deps | Gates / notes |
|---|---|---|---|---|---|
| 14 | **L1** — chat-protocol leaf | sonnet · M | transport(+bridge/composer flips) | W5, K11a | Accept restated **grep-enforced** (F4.3); JSDoc byte-identical; edge #4 dies here (F3). |
| 15 | **L7** — chat-core scope rename | sonnet · S | clients+transport | W5 | Before L6; Expo+web bundles build. |
| 16 | **L4** — manifest honesty | sonnet · M | ci | — (anytime; before L5) | Declared-vs-actual delta = 0. |
| 17 | **SCC-CHECKPOINT** (orchestrator task, not a PR) | — | — | K11b, L1 | F4.2: re-run depcruise vs HEAD, regenerate the cycle/SCC list, re-scope L2 + L3 cut lists in their briefs. |
| 18 | **L2** — contracts leaf | sonnet · M | **multi: engine+bridge+transport+trident+substrate** | **K11b (merged, not parked)**, L1, #17 | Runs ALONE across its lanes. Drop edge #4 from accept; `WebChatSenderRegistry` extraction already done by K11a (ratify/re-home only). Node-free (metro). |
| 19 | **L3** — DAG edge cuts (incl. **L3c before C1**) | opus · M | **multi: composer+data(+transport/engine-touch)** | L2, #17 | L3c (`resolveOpenDbPath`) gets a NEW pinning test (exact resolution order, both entrypoints) — it has none today. If L3 stalls, split L3c out and pull it ahead of C1 alone. Accept: no-cycles → hard-error vs the FRESH baseline. |
| 20 | **K6** — unpark/merge (#225 open) | sonnet · M | docs | — (whenever review capacity exists) | Leak-gate on clean checkout. |
| 21 | **L5 batch(es)** — relative-import autofix | haiku · M | **EXCLUSIVE barrier** | L4 | Run at a quiet point (e.g. immediately after L3, before C1 dispatch); nothing else in flight per touched package; env-read import positions preserved. |
| 22 | **C1** — Typed BootConfig | opus · L | composer | **L3(c), M0**; M1 if resolution (B) | **BootConfig homed at `gateway/config/`** (F1-A) unless (B) declared at dispatch; both-entrypoints boot test; G1 matrix unchanged; M3 rider if any pinned surface moves. |

### 2.5 Block D — composer serial + wave-4 data/substrate (waves 3–4)
Strictly serial in composer lane: **C2 → C3a → C3b → C3c → C3d → C4 → C5 → C6 → C7 → C8**,
each with its **M3 rider** when it touches a pinned surface (C2 boot-helpers, C3* + C4 `/chat`).
All C3 anchors re-grepped (composer is 4,058 lines now — §0).
| # | Unit | Deps | Notes |
|---|---|---|---|
| 23 | **C2** (+M3 rider) | C1, **M1** | + served-by-path accept (F9) for the 8 deleted dead exports + `loadInstanceEnvOverlay`. |
| 24 | **C3a→C3d** (M3 riders) | C2 | Per-module wiring tests; CompositionInput characterization snapshot taken before C3a. |
| 25 | **C4** (+M3 rider) | C3d, **M1** | Divergence fix (incl. G1's pinned `hasAnyChainedSurface` known-divergence) as an explicit tested commit. |
| 26 | **C5 → C6 → C7 → C8** | C4 | C5 consumes C3c's OpenOwnerGate. |
| 27 | **P1 → P2 → P3** · lane data | P1 first; **P2 after P6** (P2 sweeps P6's files) | Wave 4 as planned. |
| 28 | **D1 → D2** · lane substrate; **D4, D5, D6** parallel (none/cores/clients) | per plan | Wave 4 as planned. |
| 29 | **RA1** · lane data | P6 | Pulled to run right after P6 in the data queue (F7). |
| 30 | **N4-ABI slice** (ONLY if owner approves — flag ①) | M1; while tenant-count==1 | M3 rider + systemd regeneration. Otherwise skipped; literals frozen forever. |
| 31 | **M4** — gated deploy pipeline | M1 | Wave 4 per §16. |

### 2.6 Block E — wave 5 (reordered per F7)
| # | Unit | Lane | Deps | Notes |
|---|---|---|---|---|
| 32 | **D3** — chat-bridge split | bridge | K2✅, L1, L2, K11b | Partition ranges re-derived (file now 2,594 lines). |
| 33 | **D9a → D9b → D9c → D9d** | engine | K11b, P6 | Decomposed against post-P6/post-K11 code; all ranges re-grepped; anti-EngineInternals done-criteria per plan. |
| 34 | **P5** · data; **P7** · trident (F5 protocol); **P8** · data (+served-by-path accept); **P9** · data; **P10** · trident (F5; merge.ts anchors re-grepped per #193) | — | P7 coordinates with F4's ProcessRegistry writers. |
| 35 | **P4 → P11** | data | P4 after the store moves above; **P11 strictly last in data** | Per F7. |
| 36 | **D7** · clients; **D8** · transport (after L1; +served-by-path accept); **M5** · managed | — | |

### 2.7 Block F — waves 6–9 (unchanged shape, gates added)
- **Wave 6:** F1 F2 F3 F5 F8(after P6 ✓ already merged) · O1 → O2, O3 O4 O5 O7 O8 · RC1.
  **F4, F6, F7 (trident) under the F5 self-surgery protocol** (cap-1 + canary + staged revert);
  F4 after P7 + O4. F5(delivery) after L1/L2 (registry types re-homed).
- **Wave 7:** X1–X4, X5 · W7 (full rebuild; #354 crash slice already closed by #200/#197),
  W1 (after L6), W2 · O6 · RA2 (Managed `open-contract.ts` check if buildTenantEnv touched)
  RA3 · RA4 RA5.
- **Wave 8:** N1 · N2 · N3 · **N4 (minus the gate-pinned literals — F9)** · N5 · N7 · N8 · M6.
- **Wave 9:** **W3-1 → W3-2 → W3-3 per F6** (backup before read-flip; W3-3 may defer
  past window) · W4/W6 (spike-gated, may slip post-window) · N6 (after X5) ·
  S1 → S2 (ride C3c/C5 gate) · **S3 (+restore-drill accept — F9)** ·
  RB1 RB2 RC2 RC3 RB3 RB4 (one shared flag) · **X6 (last unit before K10, D-12)** ·
  **K10 STRICTLY LAST** (RT1 rule updated in the same PR; governed-mode ack; leak-gate on
  clean checkout).

### 2.8 Parked/deferred ledger (nothing silently lost)
- **K6:** parked in PR #225 — merge via item #20.
- **K4b:** stays deferred; its engine-slug scope is partially consumed by K11a/K11b's SPLIT
  (audit §2.5); whatever remains after K11b is re-audited in the D9a brief.
- **W4/W6:** spike-gated (W0), may slip post-window by design.
- **A3 (`rate_limit_paused` machinery):** decision recorded in FX2; execution folds into D9's brief.
- **D-11:** audit dirs stay untracked. **⚠️ If/when this doc is committed, its `git add` MUST
  carry a leak-gate allowlist entry (retired-vocab rules only) in the SAME commit** — it quotes
  `buildTenantEnv`/tenant-count vocabulary, the exact class that made main red in the #196/#198
  incident (§1.4 / D-11 precedent: mirror the plan doc's allowlist entry).

---

## 3. Plan-doc edits to apply (follow-up docs unit — one PR, lane docs)

**`docs/plans/2026-07-02-world-class-refactor-plan.md`:**
1. **§16 wave-2 row:** delete "**W8 F9**" (merged Step 0 — #197/#194); add "S0 W3a
   (wave-1 carry-overs)"; note K11 → K11a/K11b split + K11-pre; add "M0 DISPATCHED (was
   wave-0 deferred)".
2. **§16 wave-1 row:** annotate "K6 parked #225; K11 restructured per
   docs/plans/2026-07-05-waves-2-9-resequence.md".
3. **§16 wave-5 row:** reorder to "P6→(pulled to wave 2) · RA1 · D9a→d · P4→P11 last";
   wave-4 row gains P6/RA1 mention or a pointer here.
4. **§16 footer:** add the trident self-surgery protocol (cap-1 + canary + staged revert)
   and the per-unit anchor re-grep gate as §1.5 protocol amendments (or pointer to this doc).
5. **§17:** tick **K7 ✅ #224**; annotate K6 "parked #225"; split K11 into
   `[ ] K11-pre · [ ] K11a · [ ] K11b`; add `[ ] FX1 · [ ] FX2 · [ ] RT1 · [ ] SCC-checkpoint`;
   split W3 into `[ ] W3-1 · [ ] W3-2 · [ ] W3-3`; optionally add `[ ] N4-ABI (owner-gated)`.
6. **§L1:** restate the depcruise accept as grep-enforced (or sub-path rule) — F4.3.
7. **§L2:** lane `none` → the multi-lane list (F2); remove edge #4 from the accept; note the
   `WebChatSenderRegistry` extraction is owned by K11a; add hard dep "after K11b MERGED".
8. **§L3:** add "L3c must merge before C1 (split out if L3 stalls)" + the new pinning-test
   requirement + "re-derive cut list vs fresh depcruise SCC at dispatch".
9. **§L5:** lane `none` → "EXCLUSIVE barrier (no concurrent units in touched packages)".
10. **§L7:** lane `clients` → `clients+transport`; add "after W5, before L6".
11. **§C1:** "One `config/` leaf" → "One `gateway/config/` leaf (Managed ENV_READ_DIRS pin);
    top-level `config/` only with the M1c gate extension same-wave".
12. **§S0:** add token-refetch-on-auth-reject, per-INSTALL preference, Expo verification.
13. **§K11:** stamp "SUPERSEDED IN PART — execute per audit §2 + this resequence
    (K11-pre/K11a/K11b; retain-list; acceptChoice already deleted by K4a)".
14. **§N4:** add the gate-pinned-literal carve-out (healthz `project_slug`,
    `NEUTRON_INSTANCE_SLUG`) + the owner-gated N4-ABI slice.
15. **§S3:** add the restore-drill + key-escrow acceptance line.
16. **§L6, §D8, §P8, §C2:** add the served-by-path/bundler-graph acceptance line.
17. **§W3:** encode the three-PR staging + backup-before-read-flip + window-end rule.
18. **§K10 / D-4:** reference RT1 (tripwire + `resolveRalph:()=>false`) as the enforced
    mechanism; K10 after X6 + all parked/slipped units resolved.

**`docs/plans/refactor-orchestration-STATUS.md`:**
19. Snapshot → HEAD `fd814d9`; wave 1 complete except K6 (parked #225) / K11 (restructured);
    ready-set → §2.2/§2.3 of this doc; add the standing gates (§2.1) and the F5 trident
    protocol to the protocol section; record the audit + this doc as read-first pointers.

---

## 4. Owner-decision flags (non-blocking; window proceeds without them)

1. **① N4-ABI slice** (§2.5 #30): rename the healthz `project_slug` field +
   `NEUTRON_INSTANCE_SLUG` while tenant-count==1 (M3 rider + systemd regen), or freeze the
   literals forever? Default if unanswered: **freeze** (exclude from N4).
2. **② A3 `rate_limit_paused`:** restore the exhaustion-ceiling test vs delete the
   production-unreachable machinery (folds into D9 brief either way). Default: **delete with D9**.
3. **③ W3-3 timing:** the double-write delete requires a multi-day soak — if the window
   closes first it ships post-window. Pre-ack requested, not required (F6 already encodes the
   safe default).

No STOP-for-owner conditions are triggered by this resequence itself; every resolution above
stays inside the plan's already-granted authority (§1.5 stop conditions unchanged).
