# Multi-substrate build agent: Codex and Kimi K3 as Trident builders

> Arbiter design pass, 2026-08-09. Read-only investigation; every repo claim carries a
> `file:line`, every reference-deployment claim was read over read-only ssh. Items the
> arbiter could not establish are listed rather than inferred.

**Recommendation, in five lines.** Ship the Codex builder with the sandbox ON
(`workspace-write`) and let the model only EDIT — the harness bridge agent, not the
model, runs `git add`/`commit`/`push` after the turn ends. This removes the
`danger-full-access` question entirely instead of mitigating it: Codex's sandbox
deliberately pins `.git` read-only (including a worktree's resolved gitdir), so the
"can't commit" failure is designed policy, not a bug to work around. Kimi K3 CAN build
(verified: it drives the Claude Code harness through its Anthropic-compatible endpoint),
so it ships as a second builder — but its `effort` knob does not exist, and the settings
boundary must reject what it cannot honour. The per-phase config seam from #157 extends
with one field, `substrate`, validated loudly at the settings boundary; and every ledger
row and log line must record the RESOLVED model, because the CLI's default has already
moved underneath us once, invisibly.

---

## A. Can a Codex build turn commit without full access? No — and it shouldn't try. The harness commits instead.

**Plain-language consequence:** the build model never needs to touch git at all, so the
scariest permission goes away rather than being argued about.

The reference deployment's `forge-codex.sh` (not in this repo) runs
`codex exec --sandbox danger-full-access --skip-git-repo-check`, and its header records
that under `--sandbox workspace-write` the model fixed the code and then could not
commit — `index.lock: Read-only file system`.

The arbiter checked whether that failure was an accident of the worktree layout (a
worktree's `.git` is a FILE pointing at the parent's `.git/worktrees/<name>`, so "the
writable root" might simply be the wrong directory). **It is not an accident.** Codex
CLI's workspace-write policy (verified against `codex-rs/protocol/src/permissions.rs` in
the CLI's own source; the CLI on the reference box is codex-cli 0.147.0):

- pins `.git`, `.agents`, and `.codex` read-only inside every writable root
  (`PROTECTED_METADATA_PATH_NAMES`), and
- for a git **worktree**, detects the `.git` pointer FILE, **resolves the gitdir it
  points to, and pins that resolved directory read-only too**
  (`default_read_only_subpaths_for_writable_root` → `resolve_gitdir_from_file`).

So workspace-write can never commit from inside the sandbox, by design, in a plain
checkout or a worktree. The protection exists for a real reason: a writable `.git` lets
the model plant `hooks/pre-push` or edit `core.hooksPath`, which then executes
UNSANDBOXED the next time any process runs git in that repo — a clean sandbox escape.

**Ranked options:**

1. **Harness commits, agent only edits — RECOMMENDED.** The Codex turn runs at
   `workspace-write` in the per-run worktree and only edits files + runs tests. The
   thin Claude bridge agent that invoked it (the same shape as the existing
   `codexReviewerPrompt` bridge, `trident/inner-workflow.mjs:830-852`) then performs
   steps 3–6 of the existing Forge contract itself: verify tests, commit, push,
   open/reuse the PR, write the diff file (`inner-workflow.mjs:470-483`). The bridge is
   an ordinary Claude agent with Bash — exactly the trust level today's Claude builders
   already have. The model never needs `.git`. **This removes the security question
   rather than mitigating it.**
2. `workspace-write` + an explicit writable rule for the parent `.git`
   (`--add-dir` exists in `codex exec --help`; `[sandbox_workspace_write] writable_roots`
   exists in config). The read-only pins are applied "if_no_explicit_rule", so this would
   likely work mechanically (unverified) — but it hands the model the hooks/config escape
   the pin exists to close. **Rejected.**
3. `GIT_DIR` / `core.hooksPath` rearrangements — same exposure as (2) with more moving
   parts. **Rejected.**
4. `danger-full-access` — acceptable as an informed choice on one's own box; not
   shippable as the default build path of a public, self-hostable product. **Rejected
   as a default.**

Two practical notes for option 1: `workspace-write` has `network_access = false` by
default (config key verified in the CLI binary: `[sandbox_workspace_write] network_access`).
A fresh worktree has no `node_modules`, so the build turn needs either
`-c sandbox_workspace_write.network_access=true` for the one invocation, or the bridge
pre-installs dependencies before invoking Codex. Either is still strictly tighter than
the Claude baseline (see B). And the brief must arrive on STDIN (`codex exec -`), never
argv — `MAX_ARG_STRLEN` is 131072 bytes and the repo has hit this class of failure
before (`trident/codex-review.sh:125-127` documents the same rule for the review path).

**Settling experiment (cheap, one command, for the implementer):** in a scratch
worktree, `codex exec --sandbox workspace-write` with a trivial edit task, then
`git add -A && git commit` from the parent shell. Expected: edit succeeds, harness
commit succeeds. This is the first integration test of PR 1.

## B. Isolation for a self-hoster: the honest minimum is what already exists, because the new path is STRICTER than the current baseline.

**Plain-language consequence:** no new scary switch, no container requirement, no
consent wall — because the Codex builder as designed has *less* access than the Claude
builder every install already runs.

The documented baseline: "Neutron runs `claude` with broad permissions on the host it
is installed on, by design. Treat the machine running Neutron as trusted
infrastructure" (`SECURITY.md`, "Scope and context"). The Claude Forge agent is granted
`Bash`/`Write`/`Edit` (`trident/inner-loop.ts:211-221`) and runs in a per-run worktree
(`inner-workflow.mjs:1112`, `isolation: 'worktree'`) with mandatory cleanup on every
path (`inner-workflow.mjs:1283-1314`). Neutron Open installs per-owner into `~/neutron`
(`install.sh:36-37`).

Against that baseline:

- **Codex builder (as recommended):** `workspace-write` = filesystem-confined to the
  worktree + tmp, `.git` pinned read-only. That is a *narrower* grant than the Claude
  builder's unconstrained Bash. No consent needed for a posture that only tightens.
- **Kimi builder:** it IS the Claude harness pointed at a different endpoint (see C),
  so its posture equals the baseline exactly.
- A dedicated unix user or a container is **documented as optional hardening in
  SECURITY.md**, not required. The reference deployment uses a dedicated user; a
  single-owner `~/neutron` install gets the same defense-in-depth from the worktree +
  sandbox.

No feature flag anywhere: substrate choice is a user-facing product setting, which
SPEC.md explicitly distinguishes from a flag ("a user-facing PRODUCT SETTING …, not a
feature flag — do not strip it citing the no-flags rule"; the rule itself: "No feature
flags, one code path"). There is one build code path — resolve substrate, dispatch —
with substrate as data, exactly as `model` is data today.

## C. Kimi K3 CAN build — verified, not inferred — because it drives the Claude Code harness itself.

**Plain-language consequence:** K3 is a real third builder for quota balancing, not
just a reviewer; but its reasoning-effort knob doesn't exist, and the settings UI must
say so instead of pretending.

The arbiter expected answer-only and was wrong. The reference deployment's
`forge-kimi.sh` points the stock `claude` CLI at K3's **Anthropic-compatible** endpoint
(base URL on `api.kimi.com/coding`, key passed as `ANTHROPIC_API_KEY`, model `kimi-k3`)
and runs `claude -p` with the brief on stdin. Its header records a verification run: K3
through that harness created and wrote a file — the full agent loop, tools and all. The
same Anthropic-compatible surface is already what `trident/kimi-review.ts:60-62` calls
for review.

Two things must carry over into any shipped version:

1. **Billing safety is load-bearing.** The Kimi key travels as `ANTHROPIC_API_KEY` —
   the exact variable that makes an Anthropic-bound `claude` abandon subscription auth
   and bill the API. The reference script sets it INLINE on the one argv
   (`env VAR=… claude`), never exported. The repo already has the same discipline in
   `ensureKimiKeyExported` (`trident/kimi-key.ts:80-90`): key in the child's env only,
   never prompt text. Keep both.
2. **Permissions:** the reference script skips the permission prompt wholesale. That
   equals the documented baseline (B), so it is honest to ship — but the implementer
   should first try a scoped `--permission-mode acceptEdits` against the worktree and
   fall back only if a non-interactive turn stalls on a prompt (unverified which works).

So: **the settings UI OFFERS kimi as a build substrate** — but with `effort` rejected
(E). For uniformity and review-independence bookkeeping, still route it through a
checked-in `trident/kimi-build.sh` bridge.

## D. Composition with the per-phase settings: one new field, validated loudly, dispatched where the workflow already shells out.

**Plain-language consequence:** the owner picks "Build: Codex · gpt-5.6-sol · high" in
settings and the next run obeys it — or the settings write fails with a sentence
explaining why, never a run that silently used something else.

**What exists today (all verified):** phase keys → `{model?, effort?}` validated in
`parsePhaseModelConfig` (`trident/phase-models.ts:283-350`), threaded as `phaseModels`
(`trident/inner-loop.ts:306-312`), applied by
`applyPhaseOverride`/`routeModel`/`withModel` (`inner-workflow.mjs:277-333`). Every
phase dispatches a Claude `agent()`; `phase-models.ts:53-58` states the substrate
limitation explicitly. The workflow has NO module resolution — it can only `agent()` or
shell out through an agent's Bash (`inner-workflow.mjs:120-124`). Cross-model REVIEW
already shells out through thin bridge agents with an exit-code contract
(`inner-workflow.mjs:830-873`).

**⚠️ Gap found while verifying:** `InnerLoopInput` accepts `phase_models`
(`inner-loop.ts:107`) but the orchestrator never supplies it
(`trident/orchestrator.ts:384-407` — no `phase_models` key), and no settings surface
writes it (grep: only `inner-loop.ts`, `phase-models.ts`, and the coverage test
reference it). **The settings storage, HTTP surface and orchestrator threading are part
of this work, not a given.**

**The shape:**

```jsonc
// phase key → override
{ "build": { "substrate": "codex", "model": "gpt-5.6-sol", "effort": "high" } }
// substrate ∈ {"claude","codex","kimi"}, default "claude" (absent = today, byte-identical)
```

**Validation (`parsePhaseModelConfig`, extended):**

- `substrate` accepted only on phases that declare it — add
  `substrates: ReadonlyArray<Substrate>` to `TridentPhase`; `build` and
  `build_mechanical` get all three, every other phase gets `['claude']`. Setting
  `substrate: "codex"` on `decomposition` is a loud error at the write boundary, same
  policy as an unknown phase key today (`phase-models.ts:292-297`).
- `effort` with `substrate: "kimi"` is a loud error (E).
- `model` under `substrate: "codex"`/`"kimi"` is a vendor id (same length/control-char
  bounds, `phase-models.ts:273`); tier names resolve only under `claude`.
- Connectedness is validated at the settings WRITE (the surface can consult
  `CodexCredentialService.status`, `trident/codex-credential.ts:142-159` /
  `gateway/http/codex-credential-surface.ts`) AND at launch: a build phase pinned to a
  substrate whose credential is gone must FAIL the run loudly, never silently fall back
  to Claude — the same no-silent-fallback rule the review peers already enforce
  (`deferredCrossModelPeers`, `inner-workflow.mjs:807-824`).

**Dispatch:** `routeModel` returns `{substrate, model, effort, phaseKey}`. For
`forge:build`/`forge:fix-round-*` with `substrate !== 'claude'`, the workflow builds a
BRIDGE prompt instead of the direct Forge prompt: a thin Claude agent (fast tier,
`isolation: 'worktree'`) that (1) writes the brief to a run-keyed temp file, (2) runs
`bash ${repoPath}/trident/codex-build.sh` (or `kimi-build.sh`) synchronously with the
resolved model + effort as arguments and the brief on stdin, (3) maps the exit code,
(4) then itself executes the commit/push/PR steps of the existing Forge contract and
returns `FORGE_SCHEMA` (`inner-workflow.mjs:387-399`). Because the bridge returns the
same schema, everything downstream — checkpoints, the head-probe/`roundLanded` guard
(`inner-workflow.mjs:746-803`), reviews, cleanup — is untouched.

One consequence to surface honestly: when the builder is Codex, `argus:codex` is no
longer cross-model *with respect to the builder*. The two Claude reviewers keep the
panel cross-model, but the synthesis prompt should be told the builder's substrate so
"GPT-5 second opinion" is not overweighted on GPT-5-built code.

## E. One `effort` setting across three substrates — mapped where real, rejected where not.

**Plain-language consequence:** the effort slider always does something, because the
one substrate where it would do nothing refuses the setting instead of eating it.

- **Claude:** `effort` passes to `agent()` as today (`inner-workflow.mjs:332`). Values:
  `low…max` (`phase-models.ts:71`).
- **Codex:** pass `-c model_reasoning_effort=<v>` **per invocation** on the `codex exec`
  line — never by editing a user-level `config.toml` (global mutable state, and the
  reference box's config pins nothing, which is how F happened). The config key exists
  in codex-cli 0.147.0 (verified in the binary's string table, which also shows effort
  tiers including `xhigh`). Map `low/medium/high/xhigh` 1:1; map Neutron's `max` to
  Codex's top tier and LOG the mapping in the `trident.agent` line. Note the REVIEW path
  takes no effort at all today (`codex-review.sh` passes only `--model`,
  `codex-review.sh:138-144`) — those lanes stay in `UNROUTED_LABELS`
  (`phase-models.ts:174-192`) and the UI keeps not offering them a control.
- **Kimi:** no effort control exists on the path we have (the harness redirect exposes
  no per-turn effort, and whether K3 honours an Anthropic `thinking` budget through it
  is unverified). So the settings boundary REJECTS `effort` on a kimi-substrate phase
  with a message, and the UI disables the slider with the reason — the exact policy
  `phase-models.ts:34-43` already articulates: silent no-ops at the settings boundary
  are the worst available outcome.

## F. Observability: record the model that RAN, not the label we hoped for.

**Plain-language consequence:** the owner is balancing quota from a dashboard; a ledger
that guesses the model makes every balancing decision wrong silently.

Measured on the reference deployment: nothing pins the build model —
`CODEX_FORGE_MODEL` is referenced only inside `forge-codex.sh` and set nowhere; the
user-level codex `config.toml` pins no model (verified: it contains only personality +
project trust entries). Of 153 codex session files, the oldest 40 are 34× `gpt-5.5` and
the newest 40 are 40× `gpt-5.6-sol` — **the CLI's own default moved underneath the
deployment and nothing noticed.** Worse, the bridge labels every quota-ledger row with a
DEFAULT model name independent of the model actually used, so the drift was invisible
and the next one will be too.

What ships in Neutron Open:

1. `trident/codex-build.sh` takes the model as a **required argument** (resolved from
   settings) — no unset-means-CLI-default path, mirroring the pin rationale already
   written into `codex-review.sh:128-138`.
2. The same resolved string feeds the `-m` flag, the
   `trident.agent label=forge:build substrate=codex model=…` log line (`withModel`
   already logs exactly this for Claude, `inner-workflow.mjs:327-329`), and any usage
   row. One variable, three consumers — they cannot disagree.
3. Belt-and-suspenders: parse the model the session actually reports (`codex exec --json`
   emits it; the session `.jsonl` records `"model":"…"`) and log THAT as
   `model_reported=`. If reported ≠ requested, that line is the alarm the last drift
   never had.

## What the arbiter could not establish

- Whether `--add-dir <parent>/.git` actually suppresses the `.git` read-only pin at
  runtime (the source reads that way — "if_no_explicit_rule" — but it was not executed;
  irrelevant to the recommendation, which rejects that option).
- Whether Codex accepts `model_reasoning_effort=max`/`ultra` or tops out at `xhigh`
  (string-table evidence only). PR 1's test settles it.
- Whether `claude -p` against the Kimi endpoint can run with a scoped
  `--permission-mode acceptEdits` instead of skipping permissions, without stalling.
- Whether K3 honours an Anthropic `thinking` budget through the harness (treated as
  "no" until shown otherwise; the settings boundary rejects effort for kimi either way).
- End-to-end: workspace-write edit + harness commit in a real worktree — designed to be
  PR 1's integration test; not run because it writes to the build host.

## Implementation sequence

**PR 1 (small, one pass): `trident/codex-build.sh` + tests.** A checked-in sibling of
`codex-review.sh`: `--sandbox workspace-write`, brief on stdin, REQUIRED model arg,
`-c model_reasoning_effort=<effort>`, wall-clock cap, exit-code contract (0 = edited,
10/11 = not connected — a LOUD failure for a builder, unlike the review's graceful path
— 3/5 = deferred), `CODEX_HOME` respected, `OPENAI_API_KEY` scrubbed (same billing
contract as `codex-review.sh:53-60`), and a `NEUTRON_CODEX_EXEC_CMD`-style test seam.
Includes the workspace-write-edit + harness-commit integration test. No workflow
changes; nothing user-visible yet.

**PR 2: the settings seam, end to end.** `substrate` in `phase-models.ts` (+
`substrates` per phase, validation, coverage-test update), persistence + HTTP surface
for phase-model config, and orchestrator threading of `phase_models` into
`fireWorkflow` — closing the pre-existing gap at `orchestrator.ts:384-407`.

**PR 3: workflow dispatch.** `routeModel` carries substrate; the forge step builds the
bridge prompt for `substrate: 'codex'`; bridge commits/pushes and returns
`FORGE_SCHEMA`; resolved-model logging per F; launch-time hard failure when a pinned
substrate is not connected.

**PR 4: Kimi builder.** `trident/kimi-build.sh` (inline env, harness redirect,
permission-mode investigation), UI enables kimi for build phases with effort disabled.

**Tradeoff accepted:** the Codex build turn either gets sandbox network access or the
bridge pre-installs dependencies — both weaker than "no network" but both strictly
tighter than the Claude builder baseline. What is NOT accepted, anywhere in the shipped
path: full filesystem access, a writable `.git`, a silent substrate fallback, or a
ledger label that is not the resolved model.
