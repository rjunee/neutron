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

### (c) Approval round-trip — PASS on BOTH shapes, by different mechanisms

The first pass of this record proved (c) only for the shape being rejected, which is
the wrong thing to have measured and was caught by the gate. Re-measured on the
adopted shape:

- `codex exec` with `-c approval_policy=on-request` emits **no approval event** and
  refuses the escalation outright — *"this session's approval policy forbids
  requesting escalated permissions"* — at **exit 0**. A caller that sets the policy
  and nothing else gets a task silently not done.
- `codex exec --approve-for-me` routes the request to codex's **own automatic-review
  subagent**. The escalated write that `on-request` had just refused went through and
  the file appeared.
- On a **resumed** call the flag does not exist, but the capability does:
  `-c approval_policy=on-request` + `-c approvals_reviewer=auto_review` completed the
  same escalated write on a resumed thread. So (c) holds on every turn of the adopted
  shape, not only the first.

**Two limits, stated because they bound what (c) means here.** The approver is codex,
not Neutron — headless has no channel for Neutron to decide, and an approval that must
reach the *owner* is out of scope by the 2026-09-11 entry anyway. And it was **not
established that `auto_review` ever denies**: the one refusal seen came from the model
declining to print a credential-shaped file before any escalation was attempted, so
the reviewer was never consulted. It is not a safety control.

**Neither consumer needs it today**, which is why this is a capability note rather
than a blocker. `trident/codex-build.sh:1402` runs
`codex exec … --sandbox danger-full-access` — deliberate, with each narrower policy
rejected on record at `trident/codex-build.sh:181-200` (a build writes outside its
worktree twice over and may need network) — so a build never requests an escalation.
Cross-model review reads a diff. Checked before asserting it, because
`trident/codex-build.sh` means review is **not** the only codex caller.

### (c) on the persistent shape — PASS, after one dead end

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

  **And the correction then contradicted itself inside the same change.** The spec
  item was fixed to say the lock survives while this record's own Decisions Log
  entry still read "the headless shape has no such state" — an overstatement sitting
  in the document an implementer reads *before* deciding whether the queue and the
  typed-conflict outcome are needed. Caught by the gate, not by the author. That is
  the #574 rule turned inward: a change that corrects a claim must grep for every
  place asserting the old one, **including the places it edited an hour earlier**.
  The entry now says what is true — headless removes the wedged long-lived owner,
  not the lock.

### The sibling question: what OPERATION would a wrong implementation get right?

Every other criterion corrected in this change was satisfied by the wrong **value** —
a guessable nonce, a hard-coded sandbox mode, a key in the wrong place. One was
satisfied by the wrong **write pattern**, and it is the more transferable miss.

The `auth.json` sharing criterion asked for "the same credential file — same
inode/`realpath`" and tested it by mutating the file in place. **A hard link passes
both halves.** Measured here rather than argued:

| | inode == canonical | `realpath` == canonical | after in-place write | after atomic replace |
|---|---|---|---|---|
| hard link | **true** | false | reads new value | **stale token** |
| symlink | true | true | reads new value | reads new value |

So inode equality does not discriminate at all, `realpath` does, and the *behaviour*
only diverges under **replacement** — which is precisely how a credential file is
rewritten, because atomic replace is the correct way to do it. A hard-linked
implementation would therefore have passed every test as written and failed in
production at the one moment the criterion existed to protect: a token rotation.

The generalisation, which is not specific to credentials: **"what input would a wrong
implementation get right?" has a sibling — "what *operation* would it get right?"**
Anywhere a test asserts two paths are the same file, the discriminator is what
happens when one is **replaced**, not when one is written through. The criterion now
requires `islink` plus `realpath` equality, and exercises an atomic replace.

The implementation was already correct — the spike used a symlink, for this reason.
The criterion permitted something weaker than what was actually done, which is its
own kind of failure: a record that would have let the next person do it wrong.
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

### The spike never asked what already existed

Neither the brief nor this record checked for a codex adapter before specifying one.
There is one: `runtime/adapters/codex-cli/`, registered as the
`'openai-codex-cli'` provider and constructed in production at
`gateway/wiring/build-llm-call-substrate.ts:1353`. Two measurements settled what to
do about it rather than a judgement call:

- **Its resume is dead on the pinned CLI.** It builds `codex exec --resume <id>`
  (`exec.ts:67`); on 0.149.1 that is `error: unexpected argument '--resume' found`,
  **exit 2** — `resume` is a subcommand, not a flag. Same dead end this spike hit
  with `-s` on `codex exec resume`, from the other direction. So it could not host
  thread reuse as it stands.
- **The billing conflict is not one.** Its `auth.ts:86` documents `OPENAI_API_KEY`
  precedence, which reads as contradicting the HARD BILLING CONTRACT — until you read
  what it does: `resolveCodexAuth` seeds the spawn env with each auth variant set to
  `undefined` (`auth.ts:77-83`) and the merge loop **deletes** them from the child
  (`exec.ts:82-91`), with the substrate env defaulting to `{}` rather than
  `process.env` (`index.ts:30-43`). Ambient keys are dropped on both surfaces. What
  differs is whether a *deliberately passed* instance credential is allowed — yes for
  a self-hoster's own gateway turns, no here, because this surface spends the owner's
  subscription seat. **The repository holds one position, described in two places,
  one of which describes itself badly.** That is a materially different conclusion
  from "two contradictory positions", and the difference is entirely that the code
  was run instead of the comment being read — the same correction this record makes
  against itself twice above, arriving a third time from the reviewing side.

**One real discrepancy, filed rather than left here (#645).** The scrub lists are not
supersets of one another, and there are **three** of them, not two:
`trident/codex-review.sh:152` and `trident/codex-build.sh:850` both unset
`OPENAI_API_KEY`/`OPENAI_KEY`, while `CODEX_CLI_AUTH_ENV_VARS` covers
`OPENAI_API_KEY`/`OPENAI_AUTH_TOKEN`/`OPENAI_API_TOKEN` (`auth.ts:37-41`). The
intersection is one variable. So `OPENAI_KEY` survives the adapter's scrub and two
token variants survive both wrappers'. Two surfaces solved the same problem
independently against different vocabularies and neither knows about the other; the
fix is one shared list both call sites read, which is a change against the adapter
and not this one.

**The lesson is about the brief, not the tree.** "Specify an adapter" was taken as a
greenfield instruction by both the briefing and the spike, and the question *what is
already here?* was never asked — the same discipline that caught `codex-build.sh`
being a second codex caller, simply not applied a second time. A spec item that names
no implementation surface will grow one by default, and the default is a duplicate.

### Deferring a fix is allowed; deferring a boundary is not

The last two corrections were both a criterion narrower than the promise above it,
and the second names a rule worth keeping.

**The scrub union.** Having filed the three-list drift as #645, this item's own
credential test still seeded only the two variables the wrappers unset — while the
same document, two sections earlier, recorded that `OPENAI_AUTH_TOKEN` and
`OPENAI_API_TOKEN` escape both wrappers, and `auth.ts:24-33` classifies those as
variables a spawn must not inherit. An implementation leaking either would have
passed this suite while breaking the hard contract the suite exists to enforce, with
the evidence of the hole sitting in the same file. **A criterion may defer a fix; it
may not defer a boundary it owns.** The test now seeds the union of all four, and
#645 becomes the thing that keeps the lists in step rather than a reason to test
less.

**The "pinned CLI" was not pinned.** Every syntax decision here was justified against
0.149.1, but nothing in the tree pins it: the wrappers check `command -v codex` and
degrade to NOT_CONNECTED (`trident/codex-review.sh:154`,
`trident/codex-build.sh:852`), so the binary is whatever the host has, and a repo
search for the version literal finds it only in this item's own prose. The acceptance
suite could pass against mocked argv while deployment ran a different contract.

That is not speculative, and the proof was already in this record: the existing
adapter builds `codex exec --resume <id>` (`exec.ts:67`) and 0.149.1 answers
`error: unexpected argument '--resume' found`, exit 2, because `resume` became a
subcommand. **A caller in this tree has already been broken by exactly this drift,
and the symptom was an exit code nobody read.** The item now requires a startup
capability probe that refuses an unsupported surface loudly — chosen over a version
pin because the number is not the contract and the binary is not ours to pin. Same
policy as #538, whose herdr client must `ping` and compare protocol versions because
the socket server does none and the protocol moved 20 → 22 in nineteen days: verify
the contract at startup, fail loudly, rather than discover it mid-run.

### The acceptance section is the product, and it was wrong five times

The verdict never moved across six review rounds. The **criteria** were corrected in
every one, and always in the same direction: **narrower than the rule they enforce.**
The billing test covered two credential variables of four; the cache ratio proved
warmth rather than resumption; the symlink check was satisfied by a hard link; the
sandbox assertion was satisfied by an empty value; the approval criterion contradicted
the very form the contract prescribed. For a docs-only change that is the whole risk —
everything else here is prose describing a decision, while the criteria are what will
be executed against an implementation by someone who was not in the conversation.

**The discipline, adopted explicitly and now written into the section itself:** after
stating a rule, write its criterion and then ask **"what is the weakest implementation
that passes this?"** If the answer is an implementation you would reject, the criterion
is not finished. It is the question this repository already asks of code, turned on
one's own criteria — and it is mechanical, so it can be run over a whole section in one
pass.

**Run over all ten criteria, it caught eight.** Two were the findings that prompted the
pass; six were not:

| criterion | weakest implementation that passed |
|---|---|
| durable recall | "resume the most recent thread" — with one thread in the store, `--last` returns the nonce |
| `--last` ban | an adapter avoiding the literal string and computing newest-thread itself |
| sandbox mode | honours the caller's mode, then passes `--dangerously-bypass-approvals-and-sandbox` |
| credential scrub | `bash -lc "codex …"`, whose login shell re-sources the profile and can re-export a scrubbed key |
| symlink sharing | a rotation performed *through the secondary path*, replacing the link with a regular file |
| overlapping calls | a single global lock — "B waited" passes while every unrelated call serializes too |
| approvals (found) | never escalating at all, satisfying the "not requested" branch |
| startup probe (found) | a stub that accepts `resume` but rejects `sandbox_mode`, failing mid-turn |

Fixes, respectively: a decoy thread created *after* the recorded one so newest ≠
recorded; a behavioural half beside the grep; the bypass-flag exclusion moved to where
sandbox is asserted; an assertion that codex is exec'd directly, not through a login
shell; a rotation through both paths with `islink` re-checked; a different-thread-ids
half asserting overlap; driving a real escalation to completion; and per-key negative
cases proving no turn spawned.

### Two measurements that simplified the result

**One approval form, not two.** The contract had prescribed `--approve-for-me` on first
calls and `-c approvals_reviewer=auto_review` on resumed ones — a split that made the
acceptance assertion contradict the documented design. Measuring removed the split
rather than encoding it: `-c approval_policy=on-request -c approvals_reviewer=auto_review`
completes an escalated write on a **first** call too, so there is one form everywhere
and one assertion. `--approve-for-me` is dropped; it is the same thing spelled as a flag
and does not exist on `codex exec resume`.

**The startup probe is free, and the technique generalises.** `codex exec
--strict-config` rejects an unrecognised `-c` key with `unknown configuration field
<name>` and exits **before any model call** — 0.06 s, zero tokens. Passing every
relied-upon key together with one deliberately bogus **sentinel** validates them all in
a single free invocation: codex names only the sentinel when every real key is
recognised, and names a misspelled real key *instead of* the sentinel when one is not.

Two properties make that a real check rather than a hopeful one, and both are reusable
anywhere we depend on another tool's config surface:

- **The sentinel converts an absence of error into a positive signal.** Without it, a
  silent pass is ambiguous — it could mean every key was accepted, or that the tool
  stopped validating. With it, a pass *must* produce the sentinel's name; anything else,
  including silence, is treated as unsupported. The check fails closed.
- **It costs nothing, so "verify the contract at startup" stops being a trade-off.**
  The usual argument against a startup probe is latency or spend; at 0.06 s and zero
  tokens there is nothing to weigh against catching a drift like `--resume` → `resume`
  before a run instead of during one.

**A gate must fail only on what it gates**, and this one nearly did not. The owner's
live `config.toml` carries a per-project `approval_policy` field that 0.149.1 no longer
recognises, so a bare `--strict-config` fails to load config on this machine — which
would have looked identical to a genuine contract violation, the worst possible outcome
for a gate whose entire job is telling those apart. The first person to hit it would
have disabled the gate rather than fixed the config. Measured precedence:

| invocation | reported |
|---|---|
| `--strict-config` alone | the config-file field, as `<path>:<line>:<col>:` |
| `--strict-config -c <bad>=1` | the override, as `… in -c/--config override` — the file error is **masked** |
| `--strict-config --ignore-user-config -c <bad>=1` | the override; the user's file is out of scope entirely |

So the two are textually distinguishable — but the probe uses `--ignore-user-config`
rather than the message shape, because **a probe that decides whether a CLI is stable by
parsing that CLI's unstable error strings is circular**. Removing the failure mode beats
classifying it. The field itself is filed as #647, with the note that it is inert today
(every one of this spike's turns ran against it without `--strict-config` and none
failed) and becomes load-bearing the moment anything adopts that flag.

### Not established

- Whether `codex app-server proxy` and the unix control socket work at all. Twenty
  minutes produced silence, which is not a proof of breakage — only a measurement
  of how much it costs to find out.
- Whether the subscription rate limit is per-account or per-`CODEX_HOME`. The
  limit was never approached (`usedPercent` 5 throughout), so it was not reached
  rather than shown to be shared. The single measurement that would settle it:
  drive the account to its limit from one `CODEX_HOME` and see whether the other
  is refused.
