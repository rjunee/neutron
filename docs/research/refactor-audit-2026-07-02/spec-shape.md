# SPEC.md shape investigation — public in-repo master spec for neutron-open

**Date:** 2026-07-02 · **For:** refactor-plan unit K10 (executes decision D-4) · **Status:** read-only investigation, no repo files touched.

Ryan's resolution (refactor plan §15, `docs/plans/2026-07-02-world-class-refactor-plan.md:1304`): *"D-4 | SPEC.md | Public in-repo SPEC.md, consistent with neutron-managed's SPEC.md conventions. New unit K10."* The plan already carries the K10 unit spec at `docs/plans/2026-07-02-world-class-refactor-plan.md:368-380`; this report delivers the skeleton + seeding plan + prompt-repoint list it calls for, plus three findings the plan doesn't yet account for.

Legend: **[V]** = verified at file:line · **[I]** = inference.

---

## 1. What trident's Ralph-mode prompts expect from a root SPEC.md

### 1.1 The four prompt sites (all in neutron-open)

| Site | What it does with SPEC.md |
|---|---|
| `trident/prompts.ts:112-119` (`RALPH_BOOTSTRAP_NOTE`) | **[V]** "Read SPEC.md (and AS-BUILT.md if present) at the repo root. SPEC.md is the master spec — do NOT invent a competing plan doc" (:113); write root `IMPLEMENTATION_PLAN.md` as a prioritized `- [ ] <task>` checklist of "the discrete tasks needed to make the code match SPEC.md" (:114); build only the top task, update `AS-BUILT.md`, check off, emit `REMAINING_TASKS=` (:115-118). |
| `trident/prompts.ts:157-171` (`renderRalphPlanPrompt`) | **[V]** Planning pass: read root SPEC.md + AS-BUILT.md (:160); "Diff the SPEC against the ACTUAL code on this branch … Include code that has drifted from the spec, not only unbuilt tasks" (:161); rewrite IMPLEMENTATION_PLAN.md (:162); rules: "SPEC.md is the source of truth — read it, NEVER rewrite it" (:169), "Exactly one IMPLEMENTATION_PLAN.md at the repo root" (:170). |
| `trident/prompts.ts:193-204` (`renderRalphTaskPrompt`) | **[V]** Task pass: "Read SPEC.md and IMPLEMENTATION_PLAN.md at the repo root" (:196), implement ONE task, update AS-BUILT.md (:199). |
| `trident/inner-workflow.mjs:361-362, 381-383` (trident-v2 Fable planner + Forge executor) | **[V]** Planner: "Read SPEC.md (the master spec) and AS-BUILT.md if present at the repo root … SPEC.md is authoritative — do NOT invent a competing plan doc" (:361); regenerate the IMPLEMENTATION_PLAN.md body, returned via schema (:362); the executor persists it at the repo root (:381-383). |

`cores/free/code-gen/src/prompts/forge-system.ts:7` is the fifth prompt K6 names, but its AS_BUILT.md convention was already deliberately STRIPPED from the portable Core prompt (**[V]** :1-15 header comment) — it carries no SPEC.md reference; it's in K6's list only for the changelog-target consolidation.

### 1.2 What format the prompts assume — almost none

**[V]** The prompts assume **no named sections whatsoever** — no "decision log", no "feature specs", no "invariants" section is ever referenced by name. The complete contract a root SPEC.md must satisfy:

1. **Exists at the git root** (that's also the governed-mode trigger, §1.3).
2. **Is diffable against code** — it must state present-tense, verifiable requirements an agent can compare with the actual tree (prompts.ts:161, inner-workflow.mjs:362). A pure vision doc or a history narrative would break the planning pass.
3. **Is never rewritten by agents** (prompts.ts:169) — humans (or an explicitly-instructed run) own it.
4. **Has two companion root files:** `IMPLEMENTATION_PLAN.md` (agent-regenerated checklist, exactly one, at the root — prompts.ts:114,162,170; inner-workflow.mjs:381) and `AS-BUILT.md` (agent-updated build log — prompts.ts:113,116,199; inner-workflow.mjs:361). ⚠ The AS-BUILT path collides with K6 — see §5.1.
5. Optional format hints only: the "SPEC / TASK CONTEXT" is appended after the spec framing in the v2 planner (inner-workflow.mjs:369-370), and prompt text is pinned by tests (`trident/prompts.test.ts`, `trident/ralph.test.ts`, `trident/code-command.test.ts` all reference SPEC.md — **[V]** grep) so any wording change updates those tests.

**[I]** Conclusion: the section conventions come entirely from the Managed repo's precedent (§2), not from the prompts. The prompts only constrain the *root location*, the *present-tense diffability*, and the *companion-file trio*.

### 1.3 The governed-repo trigger (side effect K10 must plan for)

**[V]** `trident/git-mode.ts:100-142`: `detectRalphMode` returns governed when the git root contains `SPEC.md` (`defaultRalphModeProbe` checks `<root>/SPEC.md` at :142); `/code` uses it as the default (`trident/code-command.ts:156-159`: "Defaults to `detectRalphMode` (a `SPEC.md` at the git root)"; help text :308: "Governed repos (a `SPEC.md` at the root) run the Ralph plan↔task loop automatically"). **[V]** `detectRalphMode` has an `explicit: true` force-ON but **no force-OFF** (git-mode.ts:115-126); `resolveRalph` is injectable per call site (code-command.ts:159) but nothing in the repo passes a "never" resolver.

**Consequence [I]:** the moment K10 merges, every subsequent `/code` run whose repo is neutron-open itself flips from the legacy single-context build to the Ralph plan↔task loop — including the remaining refactor-window unit runs if they're dispatched via `/code` against this repo. The Ralph planner would then diff SPEC.md against the whole tree per run and regenerate a root IMPLEMENTATION_PLAN.md, which is NOT how the window's per-unit briefs are meant to execute. See plan-impact #2.

The convention name: **[V]** git-mode.ts:96 calls it "the Spec-Drift Guardrails convention" (mirrors Vajra SKILL.md "Ralph mode detection", :106).

---

## 2. The Managed repo's SPEC.md conventions (the consistency target)

**[V]** `/Users/ryan/repos/neutron-managed/SPEC.md` — 568 lines. Root doc set: `SPEC.md`, `IMPLEMENTATION_PLAN.md`, `ISSUES.md`, `AS-BUILT.md`, `CLAUDE.md`, `README.md` (**[V]** ls).

### 2.1 Frame

- **YAML frontmatter** (:1-4): `title: "SPEC.md — Neutron master plan (the ONE source of truth)"` + a `last_updated:` line that doubles as a one-line change note.
- **`<!-- CURRENT: <branch/sprint> -->` marker** (:5) — the active frontier tag.
- **Governance preamble** (:9-11): the body (System Overview · Architecture · Phases→Steps · Open Questions · Business snapshot) is the **present-tense CURRENT TARGET, carrying no abandoned branches**; the Decisions Log is an **append-only audit appendix**; "a locked decision lives in EXACTLY ONE place — the Decisions Log"; other docs reference decisions by date/ID, never restate; when a decision changes the plan, update the body AND append a log line — the body reflects the new plan only, never a "we used to do X" narrative.
- **Governed-repo declaration + doc-set table** (:13-22): "This repo is governed (it has a root `SPEC.md`)"; canonical docs = SPEC.md (decisions+architecture+phases+overview+business) · `/AS-BUILT.md` (chronological build log) · `docs/SYSTEM-OVERVIEW.md` (living architecture detail "under SPEC") · `ISSUES.md` (bugs/defects/backlog). Everything else under docs/ is referenced detail or archive, "never a second home for a decision" (:22).

### 2.2 Section order (heading outline, verified by grep)

| Line | Section | Content pattern |
|---|---|---|
| :26 | `## System Overview` | What the product IS, the two shipping shapes, pointer to SYSTEM-OVERVIEW.md for implementation truth. |
| :37 | `## Architecture` | "Summary + pointers only — implementation truth lives in docs/SYSTEM-OVERVIEW.md" (:39); numbered `### 2.1 … 2.6` subsections (product shapes, repo split, Cores, Substrate, Memory, **Naming registry** — a key/value table :75-88). |
| :92 | `## Skill Forge — …` | A first-class in-SPEC feature spec (the pattern for spec'ing a system before build). |
| :103 | `## Phases → Steps` | "The single master work queue … Edit IN PLACE. Discovered bugs/backlog that don't need immediate action go in ISSUES.md, not here. Each step carries an acceptance criterion" (:105); milestone arc + `### WAVE N` blocks + `[x]/[ ]` status legend (:109) + DEFERRED/GATED (:219) + Verification note (:238). |
| :244 | `## Open Questions` | "When Ryan answers one, move it to the Decisions Log (newest-first) and delete it here" (:246). |
| :256 | `## Business snapshot` | Condensed from the external master plan; flagged as a mirror that loses to the live source (:258). |
| :294 | `## Detail specs index` | Table: `| Spec | Owns |` — mechanics docs that "reference decisions by date/ID, never restate them" (:296). |
| :324 | `## Decisions Log (append-only audit trail — NOT the build spec)` | Newest-first `### <date>` blocks; entry format "`date — decision — [detail pointer]`" (:328); "Append-only — superseded entries STAY (with a 'superseded' note)" (:326). |

### 2.3 How IMPLEMENTATION_PLAN.md + ISSUES.md relate

- **[V]** `neutron-managed/IMPLEMENTATION_PLAN.md` (142 lines): the repo's Ralph plan file — a short topology preamble + phased `- [ ]` checklist; "Each `- [ ]` is one discrete module/slice. Checked items landed in this repo; see `AS-BUILT.md` for provenance" (:9-10). It restates NO decisions; it operationalizes SPEC.md into buildable slices — exactly the artifact trident's Ralph loop regenerates.
- **[V]** `neutron-managed/ISSUES.md` (2,019 lines): frontmatter `title: Neutron — Known issues`, `status: living document`, plus a stack of `last_updated:` lines forming an append-at-top change journal (:4-30); numbered `#NNN` issues. SPEC.md:105 routes "discovered bugs/backlog that don't need immediate action" here, and SPEC.md:20 names it the bugs/defects/backlog home.
- **[I]** Relationship model: SPEC.md = *what and why* (target + decisions) → IMPLEMENTATION_PLAN.md = *what's next* (machine-regenerated, disposable) → AS-BUILT.md = *what happened* (append-only provenance) → ISSUES.md = *what's broken/deferred*. Open must reproduce this quartet with public-safe substitutes for the two slots the leak-gate bans/relocates (§3).

### 2.4 Why the Managed SPEC.md content cannot be copied

**[V]** The Managed SPEC.md body is saturated with tokens the Open leak-gate bans: "tenant"/multi-tenant vocabulary throughout (e.g. SPEC.md:31, :46, :68, :73), the hosted-domain token (e.g. :31, :46), Managed module names (`tenant-provisioning/`, `identity/`, `proxy/` — IMPLEMENTATION_PLAN.md:8), and the Business snapshot carries customer/partner proper names (SPEC.md:256-292: customer-zero lineup, named specialists) that are Tier-1 PII-denylist-shaped. **The Open SPEC.md must be authored fresh in the owner/instance vocabulary — conventions ported, content not.**

---

## 3. Leak-gate constraints on a public root SPEC.md

Gate: `/Users/ryan/repos/neutron-open/scripts/ci/leak-gate.sh` (public Tier-2/Tier-3 subset; "no skip flag and no env bypass" :30-31).

### 3.1 Root-file rules — SPEC.md is allowed, confirmed

- **[V]** :200 `FORBIDDEN_EXACT='STATUS.md ISSUES.md CLAUDE.md AGENTS.md'` — **SPEC.md is NOT in the list; neither is IMPLEMENTATION_PLAN.md nor AS-BUILT.md.** The match is exact-root-path only (:207-209 `[ "$f" = "$p" ]`), so `docs/ISSUES.md` etc. would also pass. K10's "verify" care-item is satisfied.
- **[V]** :199 `FORBIDDEN_PREFIXES='tenancy/ tenant-provisioning/ signup/ identity/ proxy/'` — irrelevant to a root doc.
- **[V]** Nuance: the gate scans **every file found on disk** (:57-60), not the git index. Neutron-open's root already carries a `.gitignore`'d `STATUS.md` (**[V]** `.gitignore:22`; `git ls-files` confirms untracked) — so a *local* full-tree gate run trips `forbidden-path` on it today, while CI (tracked-files-only checkout) stays silent. Not K10's bug, but K10's accept step "leak-gate SILENT" should be run on a clean checkout, not the dev tree.

### 3.2 Content rules the SPEC.md text must satisfy

- **[V]** `tenant-word` prose rule (:135) + zero-tolerance `tenant-purged` (:155 — "any `tenant` substring re-entering the tree is now a regression") → the spec must use the Open vocabulary: OWNER + PRIVATE/SHARED PROJECTS + COLLABORATORS + instance.
- **[V]** `neutron-computer` hosted-domain ban (:194) → no hosted addresses; the Managed overlay can only be described generically ("a proprietary hosted overlay exists; every relay/base-domain address is env-configured with no default").
- **[V]** `workspace-retired` identifier tripwire (:167) → don't name the retired symbols.
- **[V]** Tier-1 PII denylist is env-supplied at CI (:182-189), contents unknowable from the public tree. **[I]** "Ryan" is evidently not on it — tracked `docs/AS_BUILT.md` and `docs/SYSTEM-OVERVIEW.md` already carry the name (**[V]** git grep) and main is green — so quoting "Ryan locked X" decisions is safe; customer/partner proper names from the Managed business snapshot must be assumed banned.
- **[V]** Precedent for unavoidable retired-vocab mentions: `scripts/ci/leak-gate-allowlist.txt` exempts `docs/AS_BUILT.md` from exactly the retired-vocab rules (allowlist "docs/AS_BUILT.md:tenant-purged" block) because it documents the renames. **[I]** The new SPEC.md should NOT need any allowlist entry — write it clean; needing one would be a smell.

### 3.3 Where issue tracking lives for Open (root ISSUES.md banned)

- **[V]** Root `ISSUES.md` is banned (:200); no `docs/ISSUES.md` exists (ls docs/); nothing in the refactor plan mentions an Open issues file (grep: zero hits).
- **[V]** The public-repo contribution model is "standard OSS" — external contributors PR the public repo (Managed SPEC.md:55), and Open's `CONTRIBUTING.md:72` already assumes a public issue tracker ("For security issues, do NOT open a public issue").
- **Recommendation [I]:** **GitHub Issues on `rjunee/neutron` is Open's bug tracker** (the ban on a root ISSUES.md is a carve-time tripwire against Managed's private root files re-entering the public tree — the private ISSUES.md is full of tenant vocabulary and infra detail, see §2.4). The SPEC.md doc-set table should say so explicitly, and the SPEC's Roadmap section (K10 already mandates it) holds the *planned* backlog, keeping the Managed split: bugs→tracker, plan→SPEC. Cross-repo/private defects continue to live in Managed's ISSUES.md.

---

## 4. Proposed SPEC.md skeleton + seeding plan

### 4.1 Skeleton (Managed conventions, public-clean)

```markdown
---
title: "SPEC.md — Neutron Open (master spec)"
last_updated: <date> (<one-line change note>)
---
<!-- CURRENT: <active frontier, e.g. refactor-window/wave-N> -->

# SPEC.md — Neutron Open

_Governance preamble (port Managed SPEC.md:9-11 verbatim in spirit): the body is the
present-tense CURRENT TARGET; the Decisions Log is the append-only appendix; a locked
decision lives in exactly ONE place; body reflects the new plan only._

**This repo is governed** (root SPEC.md → trident /code runs the Ralph plan↔task loop).
Canonical doc set:

| Concern | Doc |
|---|---|
| Decisions + architecture + roadmap (this file) | `/SPEC.md` |
| Chronological build log (agent-written) | `docs/AS_BUILT.md` (K6 target — see §5.1) |
| How it works NOW (living architecture detail) | `docs/SYSTEM-OVERVIEW.md` |
| Load-bearing invariants (per-merge checklist) | `docs/INVARIANTS.md` (G10) |
| Current build queue (agent-regenerated) | `/IMPLEMENTATION_PLAN.md` |
| Bugs / defects | GitHub Issues (root ISSUES.md is reserved by the purity gate) |

## System Overview
   — what Neutron Open IS (agent harness; the agent *is* a Claude Code process),
     single-owner self-host shape, one paragraph on the proprietary hosted overlay
     existing out-of-repo (no domain, no vocabulary).

## Architecture   (summary + pointers only; truth lives in docs/SYSTEM-OVERVIEW.md)
### 2.1 Product shape (Open: free, Apache-2.0, self-host, single-owner)
### 2.2 Layering (the 5-layer diagram from README:239-266 + the target module DAG
        from the refactor plan — the 11-edge cut, packages-as-real-boundaries)
### 2.3 Substrate (spawn-and-stdio Claude Code, persistent REPL pool, one-reply-per-turn)
### 2.4 Memory (GBrain sole store; scribe extraction as a side effect of talking)
### 2.5 Cores (bundle unit, free tier in cores/free/*, manifest/registry mechanics)
### 2.6 Transport & channels (ChannelRouter as the real extension seam per D-10;
        app-ws + web today, Telegram/Slack as roadmap)
### 2.7 Connect (share projects across instances)
### 2.8 Naming registry (table: NEUTRON_HOME=~/neutron/data, engine dir, npm scope
        @neutronai, env-knob conventions — port the Managed :75-88 table shape,
        public-safe rows only)

## Invariants
   — 3-5 lines + pointer to docs/INVARIANTS.md; never restate entries.

## Roadmap (Phases → Steps)
### Current wave — the refactor window (pointer to
    docs/plans/2026-07-02-world-class-refactor-plan.md as the unit backlog;
    do NOT duplicate its unit specs)
### Post-window feature backlog (the K10-mandated seeds, each with an acceptance
    criterion, Managed-style):
    - [ ] Wire ProjectBackupScheduler (dormant loop, D-7)
    - [ ] Wire comments AgentWatcher (dormant loop, D-7)
    - [ ] HITL 'prompt-user' enforcement decision — review with window log data (D-9)
    - [ ] Per-project context for tools — X6 follow-ons
    - [ ] (W0 outcome slot — web+Expo UX architecture, D-13)

## Open Questions
   — Managed :246 rule verbatim: answered → move to Decisions Log, delete here.

## Detail specs index
   — table over docs/plans/* + docs/specs/* + kept docs/research/*; "owns mechanics,
     references decisions, never restates" (Managed :296 rule).

## Decisions Log (append-only audit trail — NOT the build spec)
   Format: `date — decision — [detail pointer]`, newest-first ### date blocks.
```

**Deliberate divergence from Managed [I]:** NO Business snapshot section. Managed's (:256-292) exists to make the *private* engineering repo self-contained for agents; its content (customers, pricing, named partners) is Tier-1 material that cannot appear in a public tree. The public positioning already lives in README.md — reference it instead.

### 4.2 Seeding plan (source → SPEC section)

| Source | Verified anchor | Feeds |
|---|---|---|
| README "the one idea" + substrate + spawn-and-stdio | `README.md:41,64,79` | System Overview, §2.3 |
| README "Architecture at a glance" 5-layer diagram + one-turn-end-to-end + data model + memory + Cores + Connect | `README.md:239,286,325,357,375,404` | §2.2-2.7 (condense; the SPEC points at README/SYSTEM-OVERVIEW rather than duplicating diagrams) |
| `docs/SYSTEM-OVERVIEW.md` (2,700+ lines, living detail) | whole file; **after K7's truth pass** (plan :357-366 fixes the stale boot-path + web-chat-flag claims) | referenced from Architecture as the implementation-truth doc — same role it plays under the Managed SPEC (Managed SPEC.md:19) |
| `docs/INVARIANTS.md` (G10 output; **does not exist yet** — Wave-0 unit, plan :262-267) | plan :262 | Invariants section pointer + detail-specs-index row |
| Refactor plan §0 ground rules "locked by Ryan, 2026-07-02" (no functionality changes; dedicated window; nothing frozen except the composer-module seam; trident keeps the Workflow inner loop / Option-A REJECTED) | plan :20-36 | Decisions Log seed block `### 2026-07-02` |
| Refactor plan §15 resolved queue D-1…D-13 + Q1 scope expansion (Managed joins the window; invisible-ABI constraint dissolves) | plan :1298-1325 | Decisions Log seed block + Roadmap gates |
| K10's mandated roadmap seeds: D-7 dormant loops, D-9 HITL review item, X6 follow-ons | plan :374-377, :1307-1310 | Roadmap post-window backlog |
| Earlier public-safe locked decisions currently only in the private SPEC (e.g. GBrain sole memory store; spawn-and-stdio hard rule; "Open ships ZERO hosted addresses — env-configured, no default" B2 2026-06-13; Cores = the one distribution unit) | Managed SPEC.md:68,73,87,59 | Decisions Log back-fill — **rewritten purity-clean, owner vocabulary, no dates' private context**; only decisions that govern the Open tree |
| Ryan-attributed decisions in Open's own docs/plans | e.g. plan :20, :384, :907, :1247; `docs/plans/2026-06-30-*` | Decisions Log + Open Questions |

**[V]** Note: `docs/plans/2026-07-02-world-class-refactor-plan.md` is currently **untracked** (git status `??`) — K7 already owns `git add`-ing referenced plans (plan :366); the SPEC's detail-specs index assumes that has happened (ordering: K7 before/with K10, both lane docs).

---

## 5. Prompt repoints + coordination points (what K10/K6 actually change)

### 5.1 The AS-BUILT collision between K6 and the Ralph prompts (cross-repo)

**[V]** K6 (plan :346-354) repoints ALL changelog-writer prompts to `docs/AS_BUILT.md` and archives root `AS-BUILT.md` — but the very same prompt lines are the ones telling Ralph agents to *read/update root AS-BUILT.md next to SPEC.md* (prompts.ts:113,116,199; inner-workflow.mjs:361). These prompts are **generic across every governed repo trident targets** — and the Managed repo keeps its build log at root `AS-BUILT.md` (**[V]** ls). So after K6, the generic prompt text ("read SPEC.md and docs/AS_BUILT.md") would be wrong *for the Managed repo* unless Managed moves its changelog too. **[I]** Since Managed is now in-window (Q1, plan :1316-1324) and Ryan wants consistency, the clean resolution is: **Managed mirrors the docs/AS_BUILT.md convention in its own window phase (M-units), same wave as K6/K10**; interim-safe prompt wording: "read SPEC.md at the repo root and the build log (docs/AS_BUILT.md, or AS-BUILT.md at the root if that's what the repo has)". The plan currently says neither — it should.

### 5.2 Exact repoint list

| File:line | Change |
|---|---|
| `trident/prompts.ts:113` | keeps "SPEC.md at the repo root" (now true); AS-BUILT ref → per §5.1 |
| `trident/prompts.ts:116` | AS-BUILT update target → docs/AS_BUILT.md (K6) |
| `trident/prompts.ts:160-163, 169` | same; SPEC.md wording already correct |
| `trident/prompts.ts:196, 199` | same |
| `trident/inner-workflow.mjs:361` | same (planner read line) |
| `cores/free/code-gen/src/prompts/forge-system.ts:7` | K6 changelog consolidation only (no SPEC ref — AS_BUILT already stripped, :1-15) |
| `trident/prompts.test.ts`, `trident/ralph.test.ts`, `trident/code-command.test.ts` | **[V]** all pin prompt text containing SPEC.md (grep) — update alongside |

### 5.3 Stale provenance comments (optional K7 sweep, not K10)

**[V]** `runtime/doc-links.ts:4`, `tabs/registry.ts:4`, `gateway/http/doc-store.ts:4` cite "SPEC.md § Phases→Steps (P7…)" — references to the *pre-carve monorepo/Managed* master spec's section numbers, which won't exist in Open's new SPEC.md. Once a root SPEC.md exists, these comments point at the wrong document's sections. Cheap fix: re-cite as "the master plan (private) / see docs/plans/wave3-tabbed-interface-build-plan.md".

---

## 6. Findings the refactor plan should absorb (summary)

1. **Governed-mode flip is a side effect of K10** (§1.3): landing SPEC.md makes `/code` on neutron-open auto-Ralph with no force-OFF (`git-mode.ts:115-126`). Either sequence K10 after the window's last trident-executed unit, or add a `resolveRalph: () => false` override for window unit dispatches, or accept that post-K10 runs are governed (in which case the window's per-unit briefs must flow through the Ralph task path). The plan's wave table (:1286-1296) puts K10 nowhere explicitly — it should.
2. **K6↔K10↔Managed AS-BUILT coordination** (§5.1): the prompt is shared across governed repos; the changelog move must be two-repo-consistent or the wording repo-agnostic.
3. **Issue tracking**: GitHub Issues for Open (state it in the SPEC doc-set table); root ISSUES.md stays banned as a carve tripwire; the plan's K10 "decide where…" care-item resolves to this (§3.3).
4. **No Business snapshot in the public SPEC** (§4.1) — a deliberate, documented divergence from the Managed template; README owns public positioning.
5. **Ordering**: K7 (docs truth pass + `git add` of referenced plans) and G10 (INVARIANTS.md) should land before or with K10, since the SPEC references both outputs; K10 currently only "pairs with K6" (plan :373-374).
