## 2026-09-12 — the codex persistence spike: headless per call, on a reused thread

Issue #543, pivot plan §3.3. A ~2 hour probe that decides one adapter's shape and
ships no adapter. The owner's criterion, verbatim: *"If it's going to be riddled
with bugs and all fucked up like our trident workflow so far, then we should just
one-shot headless each time. If it can be built EASILY and will be robust, then
the shared repl is better for cost reasons."*

**Verdict: one-shot headless per call, reusing the thread id.** All three tests
passed; the decision is headless anyway, because the cost premise they were
weighed against is false. Decision recorded in `SPEC.md`'s Decisions Log under
this date; the shape to build is
`docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md`.

### Setup

codex CLI 0.149.1, `auth_mode: chatgpt`, `OPENAI_API_KEY: null` — subscription
only, no metered call anywhere in the spike. The live credential dir was left
untouched: the probe ran against its own `CODEX_HOME` holding a copy of
`config.toml`, `installation_id` and `.sandbox_migration`, with `auth.json` a
**symlink to the same file** the live dir points at. That was deliberate, not
convenience: `trident/codex-credential.ts:396-399` records that codex rotates the
refresh token when it refreshes, so two independent copies of one account's
`auth.json` revoke each other. Sharing the file by reference is the only safe way
to have a second `CODEX_HOME` for one account.

### (a) Follow-up turns — PASS

Two sequential `turn/start` calls on one live `codex app-server` connection. The
first planted a token; the second returned it. Cache on the second turn: 16,384
cached of 16,522 input (99.2%).

**How hard:** easy once a transport existed; finding the transport was the whole
fight (below).

### (b) Survive a gateway restart and resume — PASS, three ways, all first try

1. A **new client process** against the still-running server: `thread/resume
   {threadId}` → recalled the token. This is a gateway restart where the codex
   process outlives it.
2. The **server SIGTERM'd and restarted**: `thread/resume` rehydrated the thread
   from its rollout file on disk → recalled the token.
3. A client **killed mid-turn** (`kill -9`, 6 s into a long turn): the turn
   completed server-side, and a reconnecting client read the finished result —
   the model confirmed it had finished counting to 40. No orphan, no lock error.

**How hard:** each worked on the first attempt with no workaround. This is the
strongest part of the persistent case, and it is also the part that makes
persistence unnecessary: what survives is the **thread on disk**, not the
process, and the headless path resumes the same thread by the same id.

### (c) Approval round-trip — PASS, after one dead end

Bidirectional: `item/commandExecution/requestApproval` → `{"decision":"accept"}`
ran the escalated command and the file appeared with the expected contents;
`{"decision":"decline"}` left the file absent and the model reported the denial.

**How hard:** one real dead end. The first attempt (`sandbox: read-only`,
`approvalPolicy: untrusted`) never reached the client — the model reported *"the
environment rejected the escalated-permission request under its current approval
policy"* and no server request arrived. The working combination is `sandbox:
workspace-write` + `approvalPolicy: on-request` + `approvalsReviewer: user` with
an action outside the writable workspace. There are also two decision
vocabularies — `accept`/`decline` for `item/*` requests, `approved`/`denied` for
the legacy `execCommandApproval` — and a client must speak both; the first probe
sent `approved` to an `item/*` request.

### The cost measurement, which decides it

OpenAI's prompt cache for a codex thread is server-side and keyed on the thread
prefix, so it **survives process exit**. Paired A/B, adjacent turns of one thread,
same trivial prompt:

| | input | cached | uncached |
|---|---|---|---|
| live persistent session | 21,336 | 20,096 | **1,240** |
| one-shot `codex exec resume` | 22,261 | 21,120 | **1,141** |

The one-shot was marginally cheaper. Early in the same thread both sat at 97–99%
cached (persistent 16,384 / 16,522; one-shot 15,744 / 16,181). A **new** thread's
first turn is the expensive one: 15,935 input, 11,264 cached — and that is the
codex analogue of the `claude -p` warm-up this spike was weighed against (23,799 /
23,799 / 27,603 cache-read tokens per job). The fix for it is reusing the thread,
not holding the process. Wall clock is the only real saving: ~3.2–3.8 s per live
turn against ~4.6–6.1 s one-shot, so 1.3–2.5 s per call.

`usedPercent` on the subscription's 7-day `codex` window (plan `pro`) did not move
off 5 across the whole spike, so the difference between the two shapes is below
the meter's resolution too.

### What persistence costs

- **An exclusive per-thread writer lock.** With the server running, `codex exec
  resume <id>` on that thread fails `thread-store conflict: … already has an
  active writer (code -32600)`. Positive control: the identical command succeeded
  the moment the server was killed. A wedged persistent process therefore strands
  its conversation with no one-shot fallback.

  **This finding is also a constraint on the option that won, and it nearly did not
  cross over.** Going one-shot removes the *wedged long-lived owner* — but the lock
  still holds for the duration of an active call, so two overlapping resumed calls
  on one thread id collide whichever shape is chosen. The reason to reuse a thread
  is warmth across recurring work, so recurring work is exactly what shares an id,
  and a retry landing on an in-flight call or several seats on one thread overlaps
  by construction. It was written up here as an argument against persistence and so
  read as rhetoric rather than as a boundary on the recommendation; it reached the
  acceptance criteria only when the gate pointed at it. **A finding that helps
  reject option A is often also a constraint on option B** — the spec item now
  carries the positive contract (one owner per thread id, per-lane fan-out, the
  second caller waits on a bounded per-thread queue, and a conflict that arrives
  anyway is a distinct typed outcome per #542/#576) and a test with both halves.
- **The supervised form is unavailable.** `codex app-server daemon start` refuses
  without a managed standalone install at
  `$CODEX_HOME/packages/standalone/current/codex`; codex here is the npm
  distribution and that directory does not exist under the live credential dir
  (its parent does — the absence is real, not a bad path). Using the daemon would
  mean adopting a second, self-updating codex distribution per `CODEX_HOME`.
- **A path-length wall for per-project seats.** The daemon's control socket is
  `$CODEX_HOME/app-server-control/app-server-control.sock`. At the per-project
  `CODEX_HOME` shape — `<owner_home>/.codex/projects/<project_id>`,
  `trident/codex-auth.ts:191-194` — that path measures **114 bytes against a
  108-byte `SUN_LEN` limit**: `path must be shorter than SUN_LEN`, reported with
  **exit status 0**. The global dir's own socket path is 68 bytes and fits. Filed
  as its own Post-cutover issue (#637): the limit is not the expensive part, the
  success exit code on a failed probe is — the same class as #542/#576, where a
  429 folded into `deferred`, reached from the other direction.

### Dead ends, in order

1. `codex exec "<prompt>"` with a non-TTY stdin blocks reading stdin and appends
   it as a `<stdin>` block ("Reading additional input from stdin…"). Every call
   needs `< /dev/null`.
2. `codex exec resume` rejects `-s/--sandbox` (`error: unexpected argument '-s'`).
   It also has no `-C/--cd`, no `--add-dir` and no `--approve-for-me`. The sandbox
   is settable only as `-c sandbox_mode=<mode>`; the cwd only as the process cwd.
   `resume` is **not** flag-compatible with `exec`.
3. `codex app-server daemon version` against a `CODEX_HOME` under a long path
   reports `path must be shorter than SUN_LEN` — and exits **0**.
4. `codex app-server daemon start` refuses without the managed standalone install
   (above).
5. Raw newline-delimited JSONRPC to a `--listen unix://PATH` socket: connection
   accepted, then EOF, **nothing logged on either side**. The socket wants a
   WebSocket upgrade — `failed to upgrade control socket websocket connection`
   appears in the binary's strings.
6. `codex app-server proxy --sock <path>`: stayed connected, never answered a
   valid `initialize`. Silent.
7. `codex app-server proxy` against the default control socket (with `daemon
   version` confirming `status: running` over that same socket): same silence.
8. The approval dead end in (c) above.
9. Self-inflicted, worth recording because it will happen again: `pkill -f "codex
   app-server"` from a Bash tool call kills the calling shell, because the
   pattern matches that shell's own command line. Kill by pid from
   `/proc/<pid>/cmdline`, skipping `/bin/bash`.

`--listen ws://127.0.0.1:<port>` worked first try, announces `readyz`/`healthz`,
and is directly speakable from the gateway's own runtime — that is the transport a
persistent adapter would have used. Finding it by elimination consumed most of the
spike, which is itself an answer to "can it be built EASILY".

### Contention with the concurrent review gates — none observed

The gates ran `codex exec` against the live credential dir throughout, repeatedly
and with turns in flight at the moments the probe ran. ~15 probe turns: no auth
failure, no 429, no session conflict, no `auth.json` rotation divergence (one file,
shared by reference). The thread writer lock is per-thread within one `CODEX_HOME`
and never crossed over. A persistent REPL would not have collided with the gates.

### Not established

- Whether `codex app-server proxy` and the unix control socket work at all. Twenty
  minutes produced silence, which is not a proof of breakage — only a measurement
  of how much it costs to find out.
- Whether the subscription rate limit is per-account or per-`CODEX_HOME`. The
  limit was never approached (`usedPercent` 5 throughout), so it was not reached
  rather than shown to be shared. The single measurement that would settle it:
  drive the account to its limit from one `CODEX_HOME` and see whether the other
  is refused.
