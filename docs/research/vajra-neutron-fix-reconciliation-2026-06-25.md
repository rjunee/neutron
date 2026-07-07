# Vajra → Neutron fix reconciliation — 2026-06-25 (gap-4 catch-up pass)

**Author:** Atlas (Vajra fleet research agent) · **Scope:** READ-ONLY (no code modified).
**Trigger:** SPEC WAVE2 step22 catch-up pass (gap-4). The first attempt (r1) spawn-wedged before producing output; this is r2.
**Repos cross-checked:** `~/vajra` (upstream), `~/repos/neutron-open` (Open engine), `~/repos/neutron-managed` (hosted control plane + `vendor/neutron/` copy of the runtime).

**Builds on (does not duplicate):**
- `docs/research/vajra-neutron-fix-reconciliation-2026-06-24.md` — already adjudicated the **fleet-wedge cluster** (#164/#48 cross-model wedge, #160 paused-vs-finished) and the spawn-wedge/Fable/Ralph SKIPs. Those are marked DONE here, not re-analysed.
- `docs/research/vajra-neutron-parity-audit-2026-06-25.md` — feature-level parity (engine ~85%). This doc is the *fix-level* complement: it walks every gateway commit since the lift, not just the fleet ones.

---

## Headline

**Counts (20 meaningful Vajra commits over lifted paths since 2026-06-07):**

- **2 ALREADY DONE** (ported this session, commit `f527f27` / Neutron #48; documented in the 06-24 doc): cross-model-review wedge (#164) + paused-vs-finished (#160).
- **1 VERIFIED PORT** — the only concrete bug that demonstrably still exists in Neutron's current code: **#153 MCP `reply` param-drop** (`dev-channel.ts:155`).
- **3 PORT-CANDIDATE / VERIFY** (conceptual analog exists; bug plausible but NOT confirmed in Neutron — estimate-grade, needs a Forge verify pass): #150 + #151 reminder duplicate-fire, #158 Telegram typing keepalive.
- **14 SKIP** — eliminated by Neutron's architecture (tmux panes → in-process REPL substrate + HTTP `/health` + systemd timers), reverted/net-zero, Fable-disabled, or Vajra-side config.

**The single actionable item for a follow-up Forge:** port `coalesceReplyBody` into `dev-channel.ts`. Everything else is either done, architecture-N/A, or a verify task.

**Why so few real ports — the load-bearing fact:** Neutron's fleet/topic transport is *not* a port of Vajra's tmux + `claude -p` dev-channel spawn. It is a generalized in-process **persistent-REPL substrate** (`runtime/adapters/claude-code/persistent/`) using HTTP `/health` liveness probes, random 8-char channel names, and systemd-timer cron. The majority of Vajra's recent gateway fixes patch failure surfaces specific to tmux pane-scanning, `claude -p` MCP-binding under memory pressure, and starve-able `setInterval` timers — **surfaces that do not exist in Neutron.** This is the same reasoning the 06-24 doc used for the spawn-wedge trio; it generalizes to most of the catch-up set.

---

## Reconciliation table

| Vajra change (commit / PR) | Lifted concern | Neutron equivalent (verified path) | Decision | Priority |
|---|---|---|---|---|
| `7a05f9f` #164 — cross-model-review wedge (open PR first; async-await-wakeup banned; codex gate-pin) | fleet prompt + Stop path | `trident/prompts.ts` FORGE prompt + `trident/substrate-dispatch.ts` (#48 / `f527f27`) | **DONE** (06-24 doc §3) | — |
| `c1aca57` #160 — paused vs finished Stop | fleet completion | `trident/substrate-dispatch.ts`: stream-end-without-terminal-event → `failed` (#48) | **DONE** (06-24 doc §3) | — |
| `f99bfd9` #153 — MCP `reply` silently drops body on wrong param name | MCP reply tool | `runtime/adapters/claude-code/persistent/dev-channel.ts:155` — `const text = typeof args['text']==='string' ? … : ''` | **PORT (VERIFIED bug present)** — add `coalesceReplyBody = text ?? message ?? content ?? body` + surface empty-non-append as `isError` | **P1** |
| `b2f42b1` #150 — liveness-aware reminder re-fire suppression | reminder tick | `reminders/{tick,store,dispatcher}.ts` (claim-before-dispatch; per 06-25 parity audit) — tick loop not fully located | **PORT-CANDIDATE / VERIFY** — confirm Neutron's claim TTL can't expire while the composing agent still runs (duplicate-fire). Mechanism differs (no `tmux list-windows`); port the *invariant*, not the code | **P2** |
| `a5eeeeb` #151 — exit-0 delivery-confirm backstop | reminder tick | same `reminders/dispatcher.ts` | **PORT-CANDIDATE / VERIFY** — stacks on #150; check delivery is confirmed on clean agent exit so a failed confirm-POST can't re-fire | **P2** |
| `f69e26d` #158 — typing keepalive resilient to event-loop starvation | Telegram typing | substrate keepalive uses heartbeat/absolute-deadline (`persistent-repl-substrate.ts:135`) — NOT the analog. Telegram-side typing loop lives in `channels/adapters/telegram/` (managed-only, OSS-disabled) and was NOT located | **PORT-CANDIDATE / VERIFY** — audit the Telegram adapter's typing keepalive for the same starve-able `setInterval` pattern. Managed-only surface | **P3** |
| `aa308d2` #156 — Ralph loop + planning drift-catch + Fable removal + rename-gate hook fix | trident + spec-guard | Ralph present (`trident/orchestrator.ts` ralph-plan/ralph-task; 06-24 doc); model routing via orchestrator config (FIX 8) | **MOSTLY PRESENT.** One residual: if Neutron ships a spec-guard pre-commit hook, verify it has the rename-classification fix (`git mv app.js README.md` must still count as a code change). `SPAWN_AGENT_MODEL` analog = orchestrator `forge_model`/`argus_model`, present | **P3 (verify hook only)** |
| `0719461` #147 — migrate fleet off `claude -p` onto interactive-tmux | transport | persistent-REPL substrate (different transport by design) | **SKIP — architecture N/A** | — |
| `f507e39` #148 + `6e437e2` #149 — fleet resource-pressure notifier + load attribution | tmux-box watchdog | none; Neutron substrate pool + managed systemd box | **SKIP — tmux-box-specific, observe-only (not a bug)** | — |
| `12dfdbb` — topic-CC idle-kill 48h→24h | topic-CC lifecycle | none — Neutron keeps REPLs warm in a pool, no idle-kill watchdog | **SKIP — architecture N/A** (Neutron's pool-eviction policy is its own concern) | — |
| `7aeabad` #152 — cold-start first message dropped behind 30s session-capture | topic-CC activation | `session-capture.ts` gates capture (5×6s) but inbound `/message` proceeds on the live session — message not dropped | **SKIP — N/A** (different activation model). *Estimate-grade — a targeted "first message on a pooled-miss REPL isn't lost" check would fully retire it* | — |
| `f9f37af` #159 — wedged-AskUserQuestion footer not at pane bottom | wedge detect | `wedge-detector.ts` uses pid-liveness + HTTP `/health`, no pane-text scan | **SKIP — architecture N/A** | — |
| `9caf6b9` #163 — add `neutron-managed` to `/forge/delivered` worktree allowlist | Vajra delivery guard | this is **Vajra-side** config (lets Vajra's Forge deliver into the neutron-managed worktree) | **SKIP — Vajra-side config, not a Neutron bug** | — |
| `d47c5b3` + `bcc2bfb` (MCP_TIMEOUT + channel-name hashing) | spawn-wedge | reverted by `d3ffc7e` (root cause = memory pressure) | **SKIP — reverted, net-zero** | — |
| `9e13abc` + `c824ec5` + `0b2f090` — Fable-5 pins / `SPAWN_AGENT_MODEL` | model routing | Fable globally disabled (export control 2026-06-13); routing via orchestrator config | **SKIP — superseded** (keep only the generic per-spawn model override, which already has an analog) | — |

---

## Prioritized PORT list (for a follow-up Forge)

**P1 — VERIFIED, do first (small, self-contained):**
1. **`dev-channel.ts` MCP `reply` body-coalescing (#153).** Bug confirmed at `runtime/adapters/claude-code/persistent/dev-channel.ts:155` in BOTH `neutron-open` and the `neutron-managed/vendor/neutron/` copy. An agent that calls `reply(message: "…")` (the sibling `dispatch` tool's param) instead of `reply(text: "…")` silently gets `text=""` and posts an empty turn — the exact Vajra failure. Port: replace `args['text']` read with `coalesceReplyBody(args) = text ?? message ?? content ?? body`, and return `isError` (with a "use `text`") on a truly-empty non-append body so the agent self-corrects instead of silent-retrying. Add the `webhook-reply-coalesce` test analog. **Apply in `neutron-open`; the managed vendor copy inherits on next vendor sync.**

**P2 — VERIFY then port (reminder duplicate-fire, #150 + #151 together):**
2. Confirm whether Neutron's `reminders/dispatcher.ts` claim-before-dispatch TTL can expire while the (slow, RAM-starved) composition agent is still running — if so, the same duplicate-fire Vajra hit (4 identical posts) is reachable. Port the **invariant** (don't re-fire while the occurrence's agent is provably alive; confirm delivery on clean agent exit), not Vajra's `tmux list-windows` mechanism. These two stack — do them as one change.

**P3 — VERIFY, low exposure:**
3. Telegram typing keepalive (#158) — audit `channels/adapters/telegram/` for a starve-able `setInterval`; managed-only surface, Telegram OSS-disabled, so low blast radius.
4. Spec-guard rename-gate (`aa308d2` slice) — only if Neutron ships an equivalent pre-commit AS-BUILT gate; verify rename classification.

---

## Estimate-vs-verified flags

- **VERIFIED (read from current Neutron source):** #153 bug present (`dev-channel.ts:155`, quoted). #48/#160 ported (commit `f527f27` + 06-24 doc). Neutron transport = persistent-REPL substrate, not tmux (`persistent-repl-substrate.ts`, `wedge-detector.ts`, `session-capture.ts` all read directly). Channel name = `neutron-${randomBytes(4).hex}` (robust). No `MCP_TIMEOUT` usage.
- **ESTIMATE / UNVERIFIED:** the P2/P3 reminder + typing items — Neutron's reminder tick loop and Telegram typing keepalive were located by module but the duplicate-fire / starvation reachability was NOT proven against current code. Treat as "verify first," not "known bug." #152 cold-start is marked N/A on a moderate-confidence read of the activation flow, not a proof.
- **No fabricated parity claims:** every SKIP is grounded in a named architectural difference or a revert, not in "probably fine."
