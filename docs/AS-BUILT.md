# AS-BUILT

Running log of what shipped, newest-first. One entry per delivered PR.

## PTY terminal-detection P1 — auto-approve tool-use prompt (port row #2)

**What shipped.** On the merged F1/F2/F3 substrate (PR #54), a second
output-scan detector (`id: 'tool-use-approve'`) registered on every session's
`OutputScanner` in `persistent-repl-substrate.ts` auto-approves CC's tool-use
permission prompt. Port of Vajra's `gateway-core.ts isToolUsePrompt` +
`pane-scan-watchdog.ts decideAutoApproveAction` (research row #2).

- **Detect — BOTH cues required.** Fires only when the normalized bottom-N view
  contains the question (`/doyouwantto(makethisedit|proceed|runthiscommand|create)/i`,
  the spec regex carried in whitespace-free form because Ink shreds each word
  across cursor-move escapes) **AND** the `❯ 1. Yes` selector (`/❯1\.yes/i`).
  Single-cue matching false-fires on lingering scrollback (a prior approval's
  selector with no live question).
- **Action.** `writeKey('1')` then `writeKey('enter')` (`keys: ['1','enter']`)
  on the rising edge — selects "Yes".
- **Fire-once / no double-Enter.** `debounceMs: 5000` floor; the F3 framework
  stamps the latch + last-fire BEFORE returning the fired detection, so a
  transport-failed keystroke write can NOT retry next tick and DOUBLE-Enter onto
  the approval (cross-cutting invariant §4).
- **Why it's needed.** These prompts render even under
  `--dangerously-skip-permissions` for key-to-kingdom paths (`.git/hooks/*`,
  writes outside the project root), so the substrate must clear them itself.
- **Tests.** `output-scan.test.ts` (+1, now 16): both-cue frame → `1`+`enter`;
  selector-only and question-only do NOT fire; debounce stamped before await
  (same-frame retry does not re-fire; re-arm within 5s suppressed, past 5s
  fires). `tsc` clean (no new errors in touched files vs baseline).

## GBrain memory auto-upgrade + doctor (the cc-update-doctor analogue)

**What shipped.** `gbrain-memory/gbrain-doctor.ts` — a deterministic, NO-LLM
engine that keeps the GBrain memory binary CURRENT and VERIFIED, modeled on
Vajra's `cc-update-doctor`. Closes the follow-on gap from PR #51: `ensure_gbrain`
pinned an UNPINNED default-branch snapshot with no upgrade path and no health
check.

- **DOCTOR — `neutron doctor`.** Verifies gbrain WORKS, not just exists: binary
  on PATH, `gbrain --version` responds, AND a real memory **round-trip**
  (connect → `put_page` → `list_pages` read-back) through the production
  `GBrainStdioMcpClient` → `GBrainMemoryStore` against an ephemeral throwaway
  brain. Catches the present-but-broken case.
- **AUTO-UPGRADE — `neutron doctor --upgrade`.** `git ls-remote` the upstream
  HEAD, re-install only when it advanced (IDEMPOTENT), pinned to the resolved
  commit (`github:garrytan/gbrain#<sha>`) for reproducibility, then VERIFY and
  ROLL BACK a broken upgrade to the recorded ref. State in
  `<NEUTRON_HOME>/gbrain-doctor.json`.
- **Host-level cadence, never in-process** (preserves the notify-only doctrine
  in `version-notice.ts`): `install.sh` schedules `neutron doctor --upgrade`
  daily via `neutron-service.sh install-doctor` (launchd `StartInterval` /
  systemd `.timer`), opt-out aware (`--no-gbrain`), best-effort. `bin/neutron
  doctor` added to the CLI; `uninstall.sh` tears the schedule down.
- **Tests.** `gbrain-memory/__tests__/gbrain-doctor.test.ts` (24): working-vs-
  broken detection, idempotent upgrade, install-failure preserves old ref,
  broken-upgrade rollback. `tsc` clean; `gbrain-memory` suite green (88).

## Parity gap #1 (P0) — installer self-installs the GBrain memory binary

**What shipped.** `install.sh#ensure_gbrain` provisions Neutron's real memory
substrate so a fresh self-host has knowledge-graph + semantic recall out of the
box. The runtime (`gbrain-memory/`) spawns `gbrain serve` over stdio MCP; before
this change `install.sh` had ZERO gbrain references, so the binary was never on
PATH and memory degraded SILENTLY to on-disk entity pages. Closes gap #1 of the
2026-06-25 Vajra→Neutron parity audit.

- **Default install** in the Dependencies phase: `bun install -g
  github:garrytan/gbrain` (canonical README path; `NEUTRON_GBRAIN_REF` overrides
  the ref). **Idempotent** — an already-present `gbrain` is detected, not
  reinstalled.
- **Non-fatal + LOUD on failure** (the audit's core requirement: never silently
  degrade). A failed/unresolvable install reports the gap — `Memory: DEGRADED`
  in the final banner + the exact `bun install -g …` recovery command — and
  continues; the runtime's graceful-degradation path is preserved.
- **Opt-out** via `--no-gbrain` / `NEUTRON_SKIP_GBRAIN=1`.
- Pure installer + docs + test change; the memory runtime is untouched (its
  degradation logic already existed and was correct).
- **Tests** — `tests/integration/install-gbrain.test.ts`, 7 cases over the new
  `NEUTRON_INSTALL_PRINT_GBRAIN` seam (no network; injected install command).
  7 pass / 0 fail; `install-auth-gate.test.ts` still 8/8.

## WAVE 3 — Email Core: thread read (`email_thread`) + doc reconciliation

**What shipped.** The Email-Managed Core (`cores/free/email/`) gained the
conversation-level READ surface it was missing. The Core already shipped
read (`email_list` / `email_read` / `email_search`), summarize, triage,
draft, and send — but there was no way to read a whole Gmail *thread*. The
WAVE 3 acceptance for the Email Core ("list/search threads, read a message,
thread metadata") needed the thread unit, so this PR adds it.

- **`email_thread` MCP tool** — fetches a whole conversation by thread id
  via Gmail's `users.threads.get?format=full`. Returns every message in
  the thread plus derived thread metadata: `subject` (from the oldest
  message), `message_count`, `last_message_date`, the distinct
  `participants` (From/To/Cc union, first-seen order), the `label_ids`
  union, and the full `messages` array **oldest-first** (conversation
  reading order — the inverse of the newest-first list/search ordering).
  One round-trip for the whole thread (no N+1, unlike list/search).
  Read-capability gated (`read:email_managed_core.messages`).
- **Backend** (`src/backend.ts`) — `GmailThreadFull` / `GmailThreadGetInput`
  types, `ThreadNotFoundError`, and `getThread` on the `GmailClient`
  interface, implemented across both in-memory fakes
  (`buildInMemoryGmailClient`, `buildSeededInMemoryGmailClient`) and the
  production `buildGoogleGmailClient`. A shared pure `assembleThread`
  helper derives the metadata identically across backends.
- **Chat parity** — `/email thread <id>` chat command (agent-native parity:
  the agent's MCP tool and the user's chat command hit the same path).
- **Manifest** — `email_thread` declared in `package.json` `neutron.tools`;
  `TOOL_NAMES` updated to eight tools.
- **Defect fix** — removed the dangling `./mcp-tools-extra` entry from the
  Core's `package.json` `exports` map (the referenced file never existed).
- **Docs reconciliation** — `README.md` was several sprints stale: it
  documented a "Tier 1 no-send guarantee" and a 3-scope grant, but the
  Core had already shipped `email_send` + the `gmail.send` scope (gap-audit
  P0 reversal, 2026-06-20). Rewrote the send section + scope table to match
  the shipped reality and added `email_thread`. Added an Email Core section
  to `docs/SYSTEM-OVERVIEW.md` (previously unmentioned).

**Tests.** `cores/free/email/__tests__/thread.test.ts` (11 new): backend
`getThread` on both in-memory fakes (ordering, participant/label union,
`ThreadNotFoundError`), the production wrapper against a mocked
`users.threads.get` (full-payload mapping + 404 + empty-thread →
`ThreadNotFoundError`), the `email_thread` tool (audit row), and the
`/email thread` command. Full Email Core suite: 159 pass / 0 fail. `tsc`
clean against `cores/free/email/tsconfig.json`.

**Not in scope / follow-ups.** Thread-level *listing* (a "list threads"
surface distinct from per-message `email_list`) — `email_list` already
returns `thread_id` on every row, so callers group client-side; a native
thread-list endpoint is deferred until the surface needs it. Attachment
surfacing and RFC 2047 encoded-word subjects remain follow-ups (unchanged).
