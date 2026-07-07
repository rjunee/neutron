# Subsystem map: vision-docs

Auditor scope: `README.md`, `AS-BUILT.md` (root), `docs/AS-BUILT.md`, `docs/AS_BUILT.md`,
`docs/SYSTEM-OVERVIEW.md`, `docs/specs/`, `docs/plans/`, `docs/research/` (2026-06 onward),
`CONTRIBUTING.md`, `SECURITY.md`. Repo: `/Users/ryan/repos/neutron-open` @ `main` (d30280c, 2026-07-02).

---

## 1. Purpose & responsibilities

This subsystem is the repo's **written self-knowledge**: the public product pitch (README),
the community contracts (CONTRIBUTING, SECURITY), the architecture map (SYSTEM-OVERVIEW),
the shipped-change audit trail (three AS-BUILT changelogs), and the design pipeline
(docs/specs → docs/plans → docs/research). It is unusual in one load-bearing way: **large parts
of it are machine-written and machine-read.** Trident/Ralph build agents are prompted to read
and update "AS-BUILT.md at the repo root" (`trident/prompts.ts:113,116,199`;
`trident/inner-workflow.mjs:361`), and the Forge delivery contract references an
"AS_BUILT.md update" (`cores/free/code-gen/src/prompts/forge-system.ts:7`). The docs are
therefore not passive prose — they are part of the autonomous-build control loop, and the CI
leak-gate (`scripts/ci/leak-gate.sh`) enforces structural rules against them.

## 2. Module inventory (with sizes and freshness)

| File | Lines | Created | Last git touch | Status |
|---|---|---|---|---|
| `README.md` | 438 | repo init | 2026-06-24 (#44-era) | **stale in 3+ places** (see §7.2) |
| `AS-BUILT.md` (root) | **7,441** (493 KB) | 2026-06-20 (89b5302, repo init) | 2026-07-02 (#177) | active, agent-appended |
| `docs/AS-BUILT.md` (hyphen) | 1,469 | 2026-06-24 (#44) | **2026-06-30 (#148) — abandoned** | dead branch of the changelog |
| `docs/AS_BUILT.md` (underscore) | 1,818 | 2026-06-29 (#128) | 2026-07-02 (#177) | active; the leak-gate-blessed "public build log" |
| `docs/SYSTEM-OVERVIEW.md` | 3,593 | — | 2026-07-02 (#177) | active but **append-mostly**; contains flatly wrong sections (§7.3) |
| `docs/testing-runner.md` | 96 | — | current | accurate; contradicts CONTRIBUTING (§7.4) |
| `CONTRIBUTING.md` | 77 | — | 2026-06-24 | partially wrong test/typecheck advice |
| `SECURITY.md` | 37 | — | 2026-06-24 | fine |
| `docs/specs/connect-agent-engagement-mode-2026-06-26.md` | 68 | tracked | — | build-ready spec; **shipped** (SYSTEM-OVERVIEW:2516 documents it live) |
| `docs/plans/` (7 files) | 69–218 each | mixed | — | 5 of 7 shipped; 2 pending-ish (§5) |
| `docs/research/` (19 files + 1 .mjs) | 68–455 each | **8 of 19 UNTRACKED** | — | includes the trident-v2 rearchitecture design |
| `STATUS.md` (root, gitignored) | 193 | n/a | n/a | local Forge working doc; leak-gate FORBIDS committing it (`leak-gate.sh:200`) |

Untracked (working-tree-only, per `git status`): both 2026-06-30 plans, m1-e2e rounds 3/4/7,
`trident-v2-rearchitecture-2026-06-29.md`, and 4 vajra-parity docs. **The repo's roadmap and its
most important architecture-decision document exist only on Ryan's disk.**

## 3. Public seams / contracts other subsystems consume

- **`docs/AS_BUILT.md` is a CI-coupled artifact**: `scripts/ci/leak-gate-allowlist.txt:69-80`
  exempts exactly this path (by literal string) from the retired-vocabulary rules ("tenant",
  "workspace") because it documents the renames. Renaming or merging this file **re-arms the
  zero-tolerance tenant rules against its content and fails CI** unless the allowlist moves with it.
- **Root `AS-BUILT.md` is an agent contract**: the Ralph/plan prompts hardcode reading and
  updating `AS-BUILT.md` at the target-repo root (`trident/prompts.ts:113,116,160,163,199`;
  `trident/inner-workflow.mjs:361`). Since Neutron builds itself via trident, deleting the root
  file without changing the prompts means agents recreate it.
- **Root-file denylist**: `leak-gate.sh:200` `FORBIDDEN_EXACT='STATUS.md ISSUES.md CLAUDE.md AGENTS.md'`
  — a docs refactor may not introduce these at repo root (root `STATUS.md` survives only because
  `.gitignore` ignores `STATUS.md`).
- **`docs/SYSTEM-OVERVIEW.md` self-declares as the deep-detail sink** ("Keep this short; deep
  detail belongs in AS-BUILT.md and the per-module headers", `SYSTEM-OVERVIEW.md:3-5`) — at
  3,593 lines the "short" contract is broken.
- **README** is the public self-hoster contract (install one-liner, data-model promises, the
  "agent IS a Claude Code process" framing) and the de facto architecture summary for new
  contributors.
- **Plan/spec authority chain**: plans cite `SPEC.md` "Decisions Log" line numbers as their
  authority — but `SPEC.md` **is not in this repo** (see §7.5).

## 4. Workspace dependencies

- **In**: none in the package sense (pure docs). Consumers: trident prompts (above), the CI
  leak-gate, and the Documents-tab renderer indirectly (per-project docs, not these).
- **Out (references)**: `neutron-managed/SPEC.md` (private sibling repo — the master spec,
  cited by line number from `docs/plans/2026-06-30-per-project-settings-tab-credential-scoping-plan.md:6,15,23,107,123`),
  `~/repos/neutron-managed/docs/connect-spec.md` (cited by the Connect spec, `docs/specs/connect-agent-engagement-mode-2026-06-26.md:8`),
  and `~/vajra` (Vajra scripts cited throughout the parity/research docs, e.g.
  `trident-v2-rearchitecture-2026-06-29.md:375-385`).

## 5. Product vision & roadmap (extracted)

**Vision (README:5-27, 41-101):** a self-hosted single-owner "agent harness" — one Bun gateway
supervising warm interactive `claude` REPLs (PTY + per-session loopback MCP dev-channel;
one-reply-per-turn enforced by a Stop hook, README:84-100). Orchestration not inference; data as
plain files + one SQLite DB under `NEUTRON_HOME` (README:326-354); swappable substrate seam
(`runtime/substrate.ts`, README:64-77); Cores plugin system with the locked invariant "the runtime
cannot tell a free Core from a paid one" (README:398-401); Connect cross-instance sharing
(README:404-414). Status: pre-release, auth gate must go fail-closed before public launch
(README:231-235).

**Roadmap — the two 2026-06-30 plans (the nominal "pending" work):**

1. **Per-project Settings tab + credential scoping**
   (`docs/plans/2026-06-30-per-project-settings-tab-credential-scoping-plan.md`) — header says
   "Status: PLAN-ONLY. No code written" (line 5), **but it has substantially shipped**:
   `project-credentials/store.ts` + `fragment.ts` exist, `tabs/registry.ts:131-136` registers the
   `settings` builtin, `landing/chat-react/SettingsTab.tsx` exists, migration
   `migrations/0092_project_credentials.sql` exists, and root `AS-BUILT.md:337` records
   "2026-07-01 — Per-project Settings tab + credential system (FOUNDATION)" plus `AS-BUILT.md:274`
   the D2 Cores-resolver follow-up. What genuinely remains from the plan: per-project OAuth grants
   for the Google Cores (DELTA 2, explicitly deferred; still flagged at `SYSTEM-OVERVIEW.md:1134-1135`)
   and the M2 collaborators backend (Phase 5 was UI-scaffold only).
2. **Agentic per-project "wow moments"**
   (`docs/plans/2026-06-30-agentic-per-project-wow-moments-plan.md`) — a design for a recurring
   `ProjectOpeningDispatcher` (pre-stage on cadence, surface on enter; §2.2) with a per-project
   action catalogue (`p01-draft-doc`, `p02-deadlines-offer-reminders`, `p03-propose-and-start-work`,
   `p04-brief`) and 5 Ryan sign-off items (S1–S5). **Partially shipped in a reduced form** by
   PR #151 (one-time data-gated per-project kickoff — draft-doc / deadline-offer /
   interest-research / questions — in `emitProjectOpenings`; confirmed in
   `onboarding/interview/engine.ts` + `onboarding/wow-moment/`). The *recurring* dispatcher,
   cooldown state, generalized selector, and `agentic_openings` setting remain unbuilt.

**docs/specs/**: exactly one spec — Connect group-chat `agent_engagement_mode`
(`tag_gated` vs default `all_messages`), Ryan-locked 2026-06-26, and now shipped
(`SYSTEM-OVERVIEW.md:2516` "Connect group-chat agent engagement mode — connect/agent-engagement.ts
+ the chat-bridge gate"). The specs directory is otherwise empty — the real spec pipeline lives in
the private `neutron-managed/SPEC.md`.

**Trident v2 rearchitecture (`docs/research/trident-v2-rearchitecture-2026-06-29.md`, untracked, 455 lines):**
the audit brief calls this "designed-not-built" — that is **imprecise in an important way**. The doc
(design-ready, 2026-06-29) recommends Option A (drop the CC `Workflow` tool; gateway-orchestrated
single-reply substrate dispatches in TS; delete `inner-workflow.mjs`) and explicitly **rejects**
Option B′ (non-ephemeral kept-alive REPL) as "too many unknowns" (`:202-210`). What actually
shipped the same week (root `AS-BUILT.md:505`, 2026-06-29 "Trident exec-model rearchitecture";
`SYSTEM-OVERVIEW.md:2117-2257`) is **essentially B′ made to work**: a WARM NON-EPHEMERAL
`cc-trident-fire-*` substrate fires the background Workflow, the launch turn settles immediately,
and the result is harvested from `code_trident_runs.inner_result` in SQLite (migration 0091), with
false-completion discipline and orphan re-fire. `trident/inner-workflow.mjs` is alive and actively
extended (#173 model routing, #174 UX, #176 fire tools, #177 build workspace). So the doc's
decision log (D1 "drop the Workflow tool", D2 "Option A") is **superseded, not pending** — but the
doc still says `status: design-ready`, is untracked, and nothing marks it obsolete. Its §7
spawn-wedge analysis (one-shot MCP channel bind race, worktree-GC coverage hole) remains valuable
and partially unaddressed in Open.

**Older plans (all shipped, none marked done in the file):** api5xx dead-turn watcher
(SYSTEM-OVERVIEW:2747), gap2 cores-into-Open (SYSTEM-OVERVIEW:207), p1b one-chat consolidation
(landing/server.ts:1158-1163 comment), chat-collapse single surface (docs/AS_BUILT.md:223),
wave3 tabbed interface (root AS-BUILT PR-1..PR-9 entries, lines 3332-3506).

## 6. Registry of already-known debt (as declared in these docs)

Deferred/known items the docs themselves record (each verified present in the cited doc):

1. **"tenant" vocabulary rename** — leak-gate bans `tenant_slug`/`TenantDb`/etc. in the public tree
   (`leak-gate.sh:12-22`), and `docs/AS_BUILT.md` is exempted because it documents the rename — but
   the *sanitized replacement* vocabulary is itself debt: **853 `internal_handle` references across
   112 TS files** (grep, excluding node_modules/worktrees) in a single-owner product. Worse than the
   declared "441+".
2. **code-gen Core physical deletion** — engine + 4 MCP tools retired but not deleted; "the one
   documented remaining cleanup" (`SYSTEM-OVERVIEW.md:2254-2257`).
3. **`/code` command not wired into the landing chat path** — no `ChatCommandFilter` seam on
   `chat-bridge.handleInbound` ("NEXT PR", `SYSTEM-OVERVIEW.md:2232-2239`).
4. **Idle-nudge sweep cron not auto-enabled in Open** (`SYSTEM-OVERVIEW.md:1539-1540`).
5. **Message reactions `reaction_log` not in the live gateway composition** (`SYSTEM-OVERVIEW.md:2112-2113`).
6. **In-product OAuth-connect admin surface** (cookie-auth ↔ bearer contract) — "documented
   follow-up" (`SYSTEM-OVERVIEW.md:242-244`).
7. **Per-project OAuth grants for Google Cores** — deferred Phase-3 rework
   (`SYSTEM-OVERVIEW.md:1134-1135`; plan DELTA 2).
8. **Production app-ws token mint for web + identity sub-sprint** — deferred (`SYSTEM-OVERVIEW.md:3492-3493`).
9. **Auth gate fail-closed before public exposure** (README:231-235; SECURITY.md:30-32).
10. **Contribution guidelines incomplete** — README:437-438 "being finalized ahead of the public launch".
11. **Spawn-wedge structural fixes** — one-shot dev-channel bind race + disk-level worktree reaper
    (`trident-v2-rearchitecture-2026-06-29.md` §7.3 steps 1-5); the repo's own
    `.claude/worktrees/chat-switch-race/` full stale copy of the tree is live evidence of the §7.2
    GC coverage hole.
12. **Import wedge at `import_running` when `signup_via` missing** — recorded NEEDS-DECISION
    (memory/`docs/research` m1 rounds; unfixed).

## 7. Architectural debt in the docs themselves

### 7.1 THREE overlapping AS-BUILT changelogs — root cause identified (P1)

This is not random sprawl; it is **two agent-prompt filename conventions colliding**, plus abandonment:

- Root `AS-BUILT.md` (hyphen) — created at repo init; the **trident/Ralph prompts** hardcode this
  name at repo root (`trident/prompts.ts:113`), so self-builds append here.
- `docs/AS_BUILT.md` (underscore) — the **Forge delivery contract** vocabulary uses the underscore
  form (`cores/free/code-gen/src/prompts/forge-system.ts:7`); created 2026-06-29 (#128) and blessed
  by the leak-gate allowlist as "the public build log / audit trail" (`leak-gate-allowlist.txt:69`).
- `docs/AS-BUILT.md` (hyphen-in-docs) — created 2026-06-24 (#44), abandoned after 2026-06-30 (#148).
  A dead 1,469-line branch of the log.

Recent PRs write **inconsistently**: #177 wrote root (55 lines) AND docs/AS_BUILT (30 lines) —
two different-length write-ups of the same change; #174/#173/#172 wrote only docs/AS_BUILT;
#165/#162 wrote only root; #176/#168 wrote **neither**. There is no single place where "what
shipped" is complete. During 06-29→06-30 the same PR stream double-wrote docs/AS-BUILT and
docs/AS_BUILT (e.g. "Create Project rail refresh" appears in both: `docs/AS-BUILT.md:99` and
`docs/AS_BUILT.md:1059`).

Root `AS-BUILT.md` is additionally: (a) 493 KB / 7,441 lines / 123 entries in ~13 days — hostile
to the very agents told to read it each Ralph iteration; (b) **out of order** — it claims "newest
first" (line 3) but lines 7319-7441 hold 2026-06-27/06-28 entries appended *after* 2026-06-19
entries.

### 7.2 README staleness (P2)

- Lists **notes** as a bundled free Core (README:248, 389) — the notes Core was **removed
  entirely** 2026-07-01 (PR #161, `docs/AS_BULT` er `docs/AS_BUILT.md:570`; `git show 80e1f2d`
  deletes `cores/free/notes/**`).
- The "eight free Cores" table (README:385-397) omits **google-workspace** and **scraping**
  (both present and documented in SYSTEM-OVERVIEW:105,136) and still lists **code-gen** as a
  product feature although its gateway wrapper is retired (SYSTEM-OVERVIEW:2249-2257).
- README:359 memory section still frames GBrain as "degrades fail-soft if absent" while
  `docs/AS_BUILT.md:479` records the 2026-06-30 change "Install GUARANTEES GBrain memory —
  retry + abort-on-failure (no silent degrade)".

### 7.3 SYSTEM-OVERVIEW contradicts shipped code (P1)

- **Boot path section (lines 7-18)** says Open self-hosts "boot a `/healthz`-only shell" — false
  since Sprint D: `package.json:48` `start` → `open/server.ts`, whose header (lines 1-25)
  explicitly says a fresh clone gets "the full onboarding + chat product … NOT just /healthz".
  This is the FIRST section of the primary architecture map.
- **React web chat section (line 3409)** says the React client is "behind a flag" and "the
  vanilla-TS client … is the DEFAULT" — both deleted 2026-06-26: `landing/server.ts:1158-1163`
  ("React/assistant-ui is the ONLY web chat client. The vanilla chat.html/chat.ts surface and the
  NEUTRON_WEB_CHAT_CLIENT flag were DELETED").
- Pattern: the doc is **append-mostly** — new sections land per PR (10-60 lines each, see
  `git show --stat` of #163/#164/#167/#169/#172/#174/#177) but superseded sections are rarely
  corrected, so trust degrades non-uniformly: a reader cannot tell live sections from fossils.

### 7.4 CONTRIBUTING contradicts the testing reality (P2)

- CONTRIBUTING:47 says "`bun test` — the whole suite"; `docs/testing-runner.md:14-20` documents
  that a bare full-suite `bun test` (~775 files) climbs past ~1.2 GB RSS and OOMs — the documented
  runner is `bash scripts/run-tests.sh`. A new contributor following CONTRIBUTING gets an OOM.
- CONTRIBUTING:49 says "`bunx tsc --noEmit`" is the type-check; the trident package needs
  `tsc -p trident/tsconfig.json` (root tsc misses real errors — recorded project memory;
  `trident/tsconfig.json` exists as a leaf config).

### 7.5 The master spec is external and untracked plans cite it by line number (P1)

Plans derive authority from `SPEC.md:186` / `SPEC.md:328` etc. — but SPEC.md lives in the
**private** `neutron-managed` repo (`credential-scoping plan:6` cites `neutron-managed/SPEC.md:186`).
For the open-source repo this means: (a) the public tree's roadmap is unauditable by contributors;
(b) line-number citations into a privately-moving file rot silently; (c) the trident Ralph loop
reads "SPEC.md at the repo root" (`trident/prompts.ts:113`) — which does not exist in this repo,
so spec-driven self-builds depend on per-run injected specs.

### 7.6 Roadmap docs are untracked working-tree files (P1)

8 of 19 research docs and both 2026-06-30 plans are `??` in git status — including
`trident-v2-rearchitecture-2026-06-29.md` (the analysis of the substrate's one-reply-per-turn
invariant and the spawn wedge) and the vajra parity audit set. One `git clean -fd` or a fresh
clone loses the design record. Meanwhile several docs that ARE tracked (m1 rounds 5/6) are
interleaved with untracked siblings (rounds 3/4/7) in the same series.

### 7.7 Plan/spec lifecycle has no status transitions (P2)

Every plan keeps its birth status forever: the credential plan still says "PLAN-ONLY. No code
written" (line 5) after most of it shipped; the trident-v2 doc still says "design-ready" after
being superseded; the shipped Connect spec still says "cleared for Forge build"; wave3/chat-collapse
plans carry no completion marker. Nothing distinguishes {pending, in-progress, shipped, superseded}.
An agent (or engineer) grepping docs/plans for "what's next" gets 7 files, 5 of which are history.

### 7.8 Dead/legacy doc code candidates

- `docs/AS-BUILT.md` — entire file (abandoned changelog branch; last write #148, 2026-06-30).
- `docs/research/trident-v2-proto2-workflow.prototype.mjs` — a prototype script parked in a docs
  directory.
- `.claude/worktrees/chat-switch-race/` — a full stale repo copy (gitignored, but it double-counts
  every grep and is live evidence of the worktree-GC hole; the trident doc's §7.2 fix would reap it).
- README's notes-Core row + `cores/free/notes/` leftover `node_modules` on disk (git-deleted).
- `docs/plans/` 5 shipped plans (keep as history, but they need a `status: shipped` stamp or an
  `archive/` move).

## 8. Debt table (severity-ranked)

| # | Title | Sev | Evidence |
|---|---|---|---|
| 1 | Changelog fragmentation: 3 AS-BUILT files, inconsistent per-PR writes, no authoritative log | **P1** | §7.1; `trident/prompts.ts:113` vs `forge-system.ts:7`; leak-gate-allowlist:69-80; git stats of #162-#177 |
| 2 | Roadmap + key design docs untracked (loss-prone, invisible to contributors) | **P1** | `git status`: both 2026-06-30 plans, trident-v2 doc, 4 parity docs `??` |
| 3 | SYSTEM-OVERVIEW contradicts shipped code in first + late sections (append-mostly rot) | **P1** | §7.3; SYSTEM-OVERVIEW:7-18 vs open/server.ts:1-25; :3409 vs landing/server.ts:1158-1163 |
| 4 | Master SPEC.md external/private; plans cite rotting line numbers; Ralph prompt expects a root SPEC.md that doesn't exist | **P1** | §7.5 |
| 5 | Trident-v2 rearchitecture doc superseded but marked design-ready; decision log contradicts shipped exec-model | **P2** | §5; doc `:24-48,202-210` vs SYSTEM-OVERVIEW:2117-2257, AS-BUILT:505 |
| 6 | README stale (notes Core, core list, GBrain fail-soft claim) | **P2** | §7.2 |
| 7 | CONTRIBUTING test/typecheck advice OOMs / under-checks | **P2** | §7.4 |
| 8 | Plan lifecycle has no status field discipline ("PLAN-ONLY" after shipping) | **P2** | §7.7 |
| 9 | Root AS-BUILT is 493 KB, order-violating, and agent-read every Ralph iteration | **P2** | §7.1; lines 7319-7441 |
| 10 | docs/AS-BUILT.md dead file; prototype .mjs in docs/research | **P3** | §7.8 |

## 9. Test posture

The docs have real, unusual test coverage: `scripts/ci/leak-gate.sh` runs on every PR/push
(non-skippable; allowlist is the only exception mechanism, `leak-gate.sh:30-33`) and structurally
polices the docs tree (forbidden root files, retired vocabulary, hosted-domain, secrets);
`scripts/ci/ci-workflow.test.ts` tests the CI workflow itself. There is no staleness/link checking:
nothing verifies that file:line citations in plans/AS-BUILT resolve, that README's core table
matches `cores/free/`, or that SYSTEM-OVERVIEW sections match code — which is exactly the failure
mode observed. Flake risk: none (docs don't run), but the leak-gate's exact-path allowlist makes
doc renames CI-brittle in a good-but-surprising way.

## 10. Load-bearing subtleties a refactor must not break

1. **`docs/AS_BUILT.md` exemptions are keyed to the literal path** (`leak-gate-allowlist.txt:75-79`).
   Merging/renaming the changelogs without moving the allowlist entries re-arms the zero-tolerance
   tenant rules against the merged content → CI red.
2. **`FORBIDDEN_EXACT='STATUS.md ISSUES.md CLAUDE.md AGENTS.md'`** at repo root (`leak-gate.sh:200`):
   a docs consolidation must not promote the gitignored root STATUS.md (or add CLAUDE.md/AGENTS.md)
   into the tree. Note `.gitignore` ignores `STATUS.md` at ANY depth — a future tracked
   `docs/STATUS.md` would be silently unaddable.
3. **Trident/Ralph prompts hardcode root `AS-BUILT.md` and root `SPEC.md`**
   (`trident/prompts.ts:113,116,163,199`; `inner-workflow.mjs:361`): removing/renaming the root
   changelog without updating the prompts makes self-builds recreate it (or fail the "update
   AS-BUILT" step). The doc convention IS an agent API.
4. **AS-BUILT prose is the only record of several behavioral invariants** (one-reply-per-turn,
   false-completion discipline, provenance-gated APPROVE, paused≠finished) with file:line anchors —
   the refactor's "no functionality change" verification will lean on these entries; do not discard
   the two active logs' content when consolidating, and preserve the docs/AS_BUILT rename-history
   entries that justify the leak-gate exemption (`leak-gate-allowlist.txt:69-74` explains why).
5. **docs/AS_BUILT.md is "public audit trail" by design** — it deliberately names retired vocabulary;
   a well-meaning cleanup that scrubs "tenant" from it destroys the documented rename evidence the
   exemption exists for.
6. **Plans encode Ryan-locked decisions** (e.g. `all_messages` default with verbatim quote,
   connect spec:26-28; "no feature flags" locks) that later code reviews cite as authority; losing
   them orphans the rationale for non-obvious code shapes.

## 11. What the refactor should do here

1. **Collapse to ONE changelog**: keep `docs/AS_BUILT.md` (the leak-gate-blessed path) as the
   single log; append a terminal "moved" pointer entry to root `AS-BUILT.md` and
   `docs/AS-BUILT.md`, then delete `docs/AS-BUILT.md` and shrink root `AS-BUILT.md` to a stub that
   points at docs/AS_BUILT (or update `trident/prompts.ts`/`inner-workflow.mjs` + forge-system
   vocabulary to one filename first — the prompts are the actual writers). Archive the historical
   root content under `docs/changelog-archive/` so nothing is lost.
2. **Commit the untracked docs** (plans, research, parity audits) immediately — this is a
   one-command, zero-risk fix for the highest loss-risk item.
3. **Add a status header convention** (`status: pending | building | shipped(#PR) | superseded(by)`)
   and stamp all 7 plans + the trident-v2 doc; mark the trident-v2 doc `superseded` with a pointer
   to the shipped exec-model section.
4. **Fix the three provably-wrong doc sections** (SYSTEM-OVERVIEW boot path + web-chat-flag
   section; README core table/notes/GBrain claim; CONTRIBUTING test runner + trident tsc) — cheap,
   high-trust-restoring, zero behavior risk.
5. **Decide the SPEC story for the open repo**: either vendor a public SPEC.md snapshot (with the
   private Managed deltas stripped) or re-anchor plans on stable section slugs instead of private
   line numbers.
6. **Add a docs CI check** that (a) README's core table matches `ls cores/free/`, (b) every
   docs/plans file carries a valid status header — mechanical guards against the observed rot class.
7. **Keep SYSTEM-OVERVIEW but enforce its own contract**: split the 3,593 lines into per-subsystem
   maps (or per-layer files) with a short index, so "append a section per PR" stops compounding;
   the refactor's 17 subsystem maps are the natural seed.
