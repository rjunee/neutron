# Vajra → Neutron fix reconciliation — 2026-06-24

**Checkpoint:** the recurring Vajra→Neutron reconciliation pass (SPEC.md WAVE 2
step 22). This is its first high-value port. The trigger is the **fleet
premature-completion / cross-model-review wedge** that hit Vajra fleet-wide on
2026-06-23, and the fact that Neutron's `trident/` runtime descends from the
same Vajra forge/argus + fleet-spawn code lifted on 2026-06-07.

> **Note on SPEC.md.** There is no `SPEC.md` at the Neutron-open repo root (only
> `docs/SYSTEM-OVERVIEW.md` + `AS-BUILT.md`). "WAVE 2 step 22" is the Vajra-side
> master-spec checkpoint; in Neutron the durable home for "every battle-tested
> Vajra fix maps to an Open equivalent with a regression test" is
> `trident/vajra-fixes.test.ts` (the Trident-port parity mandate). This pass adds
> its `FIX 9` block, so the reconciliation is anchored in CI, not just prose.

## 1. The bug (observed live, fleet-wide)

A spawned fleet/trident Forge commits + pushes its branch, then **hangs at the
cross-model (Codex) review step before opening the PR**. Two distinct failure
modes were conflated in the original report:

- **LIVE wedge (the actual cause).** The agent self-ran an **async** `/codex:review`
  (or a background broker job) and **ended its turn to await the result**. Nothing
  feeds an external review result back to a headless REPL, so nothing resumed it →
  it idled until the watchdog reaped the window, **PR unshipped**.
- **LATENT landmine.** The openai-codex plugin's global blocking Stop hook
  (`stop-review-gate-hook.mjs`) returns `decision:"block"` when the per-workspace
  `stopReviewGate` config is enabled. Off by default for fresh worktrees, so the
  exposure is narrow (a fix-pass re-run in a worktree where a prior interactive
  `/codex:setup` enabled it).

The originally-filed hypothesis — *"`/codex:review --wait` blocks forever, add a
timeout"* — was **verified WRONG** in Vajra: the `codex-review.sh` wrapper already
has timeouts + an auth precheck, and the stop-gate `block` path was not the live
cause. The real fix is **prompt discipline** (open the PR first; review is
best-effort; never yield the turn to await an async review) plus a **belt-and-
suspenders gate pin** at spawn.

## 2. Vajra changes since the 2026-06-07 lift, over the lifted paths

Paths lifted into Neutron `trident/`: the forge/argus prompts (`prompts/forge.md`,
`prompts/argus.md`) and the fleet spawn → subagent-wait → completion path
(`gateway/fleet-spawn-core.ts`, `spawn-fleet-agent.ts`, the Stop/completion hook).

| Vajra commit | What it changed | Port decision for Neutron |
| --- | --- | --- |
| **`7a05f9f` / PR #164** — *stop /slfg Forges wedging on cross-model review* | (a) `prompts/forge.md` cross-model section rewritten: OPEN PR FIRST, sync `codex-review.sh` only, async/await-wakeup BANNED, review best-effort. (b) `spawn-fleet-agent.ts` `disableCodexStopGate()` pins `stopReviewGate:false`. (c) `fleet-spawn-core.ts` pure `codexStateFilePath` + `buildCodexGateDisabledStateJson` + `defaultCodexPluginDataDir`. | **PORT (adapted) — primary driver of this pass.** (a) → ported into `trident/prompts.ts` `FORGE_SYSTEM_PROMPT` as the *CROSS-MODEL REVIEW* hard-rule block (the Open analog of the forge.md rewrite). (b)+(c) → **SKIP (not applicable):** the openai-codex stop-review-gate plugin is **not part of Neutron-open's repo surface** (no plugin dependency; the only "codex" in-repo is the unrelated GPT-5.5 *Codex CLI model adapter*). Pinning a plugin config Neutron doesn't ship would be dead defense. The durable Open defense is the prompt + the dispatch-level false-completion fix below. |
| **`c1aca57` / PR #160** — *distinguish paused vs finished fleet Stop* | Gateway tells a real FINISH apart from a PAUSE so an agent that pauses to await a background subagent is not reaped mid-work. Adds `fleet-spawn-core` reap-decision helpers + `fleet-complete` hook logic. | **PORT (adapted).** Neutron has no tmux/Stop-hook reaper; the analog is **`trident/substrate-dispatch.ts`**, where a substrate turn whose event stream ends WITHOUT a terminal `completion`/`error` event was classified `completed` (silent success). Changed to `failed` — a paused / abnormally-closed turn is *not* a confirmed finish. This is the "paused ≠ finished" invariant on the Open substrate. Reap-window/pane-tail heuristics → **SKIP** (no tmux panes in Open). |
| `d3ffc7e`, `bcc2bfb`, `d47c5b3` — fleet **spawn-wedge** fixes (channel-name 64-char limit, `MCP_TIMEOUT`, speculative-code removal) | Reliability of `claude -p`/tmux dev-channel MCP binding under memory pressure at spawn. | **SKIP (not applicable).** Neutron dispatches an in-process `Substrate` (CC-subprocess persistent REPL), not a tmux dev-channel MCP spawn — none of these failure surfaces exist here. |
| `aa308d2` / PR #156 — Spec-Drift Guardrails Phase 2 (Ralph loop + planning-pass drift-catch + Fable removal) | Ralph one-task-per-fresh-context loop + active planning pass. | **ALREADY PRESENT.** Neutron `trident/prompts.ts` already ships `RALPH_BOOTSTRAP_NOTE` / `renderRalphPlanPrompt` / `renderRalphTaskPrompt`, and Fable is export-disabled (asserted in `vajra-fixes.test.ts` FIX 8). No action. |
| `9e13abc`, `c824ec5`, `0719461` — Fable-5 trial pins / `SPAWN_AGENT_MODEL` / `claude -p`→tmux transport | Transport + model-routing experiments specific to Vajra's fleet. | **SKIP (not applicable).** Open routes models via the orchestrator (`forge_model`/`argus_model`, FIX 8) over its own substrate; Vajra's transport/trial knobs don't map. |

## 3. What was ported (this PR)

1. **`trident/prompts.ts` — `FORGE_SYSTEM_PROMPT` cross-model-review hard rule.**
   Encodes: OPEN THE PR FIRST then review; review is BEST-EFFORT and NEVER gates
   the PR or blocks the turn; NEVER end the turn to await an async/background
   review (run it synchronously inline or skip). Open analog of `prompts/forge.md`.
2. **`trident/substrate-dispatch.ts` — false-completion race.** A turn whose
   stream ends without a terminal `completion`/`error` event now maps to `failed`
   (was `completed`). The session manager treats any non-`completed` status as a
   crashed sub-agent, so a paused/yielded turn is recovered or failed **loudly**
   instead of silently advancing the build as "done". Open analog of #160's
   "paused ≠ finished".
3. **Tests.** `trident/substrate-dispatch.test.ts` +1 case (stream-ends-without-
   terminal-event → failed); `trident/vajra-fixes.test.ts` +1 `FIX 9` describe
   block (3 cases pinning the prompt's PR-first ordering, best-effort marking, and
   the ban on yielding the turn).

## 4. Spec-conformance diff (5 lines)

```
- substrate-dispatch: stream-end-without-terminal-event  was: 'completed'  now: 'failed'   (paused ≠ finished)
- FORGE_SYSTEM_PROMPT: + "CROSS-MODEL REVIEW (best-effort — NEVER a hang point)" hard-rule block
+   rule: OPEN THE PR FIRST, then review  (a stalled review never costs the deliverable)
+   rule: review is BEST-EFFORT, NEVER gates the PR / blocks the turn
+   rule: NEVER end the turn to await an async review — run it synchronously inline or skip
```

## 5. Verification

- `bun test trident/substrate-dispatch.test.ts trident/vajra-fixes.test.ts trident/prompts.test.ts` → 63 pass / 0 fail.
- `bunx tsc -p trident/tsconfig.json --noEmit` → clean (exit 0).
- The review-wait is no longer a hang point: the dispatch already bounds every
  turn with `timeout_ms` (→ `timed_out`), and a turn that ends without a real
  completion no longer reports success — so a stalled/abandoned review degrades to
  a loud crash + recovery, never a falsely-completed build with an unshipped PR.
