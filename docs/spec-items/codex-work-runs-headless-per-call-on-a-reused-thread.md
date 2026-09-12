---
title: Run cross-model codex work headless per call on a reused thread
group: trident
status: open
priority: P1
cutover: false
legacy_ref: "spike: GitHub issue #543; pivot plan §3.3"
---

Recurring cross-model work (codex test agents, codex reviewers, any repeated
codex turn inside one build) runs as **one process per call** — `codex exec` for
the first turn of a piece of work and `codex exec resume <thread_id>` for every
turn after it. There is **no long-lived codex process** and no supervisor for
one. The unit of continuity is the **thread id**, which Neutron stores; the unit
of execution is a process that starts, takes one turn, and exits.

Decided by the 2026-09-12 spike (SPEC.md Decisions Log, that date). The short
version of the evidence: OpenAI's prompt cache for a codex thread lives
server-side and is keyed on the thread prefix, so it **survives process exit**. A
one-shot turn resuming a thread and a turn on a live persistent session cost the
same — measured on adjacent turns of one thread, 1,141 uncached input tokens for
the one-shot against 1,240 for the live session. Persistence therefore buys
process startup time (~1.3–2.5 s) and nothing else, while adding a supervised
long-lived process, an exclusive per-thread writer lock that strands a
conversation when that process wedges, and a daemon mode this install cannot run.

## Where this lands, and the codex adapter that already exists

**The surface is trident's cross-model path** — `trident/codex-review.sh`,
`trident/codex-build.sh`, and the thread-id bookkeeping the trident inner loop needs
to pass an id from one call to the next. It is **not** a new `Substrate`.

**`runtime/adapters/codex-cli/` is neither replaced nor extended by this item**, and
that is a reasoned position, not an omission:

- **It is a different seam with a different consumer.** It implements `Substrate` for
  the gateway's LLM-call path, constructed at
  `gateway/wiring/build-llm-call-substrate.ts:1353` via
  `selectSubstrateFactory('openai-codex-cli')` — that is "dispatch a Neutron
  *judgment turn* to codex instead of Claude". This item is trident's cross-model
  *gate* around a build. Two implementations of **different** paths is not the dual
  path the tree forbids; two implementations of the **same** path would be.
- **It could not host this work as it stands.** Its resume is built as
  `codex exec --resume <id>` (`runtime/adapters/codex-cli/exec.ts:67`), and that
  option **does not exist** on the pinned CLI: `codex exec --resume <id>` returns
  `error: unexpected argument '--resume' found`, **exit 2**. `resume` is a
  subcommand, not a flag. So its resume path is dead against 0.149.1 regardless of
  this item.
- **If it is ever repaired, this item's thread contract governs it too** — one owner
  per thread id, per-lane fan-out, the conflict outcome — so the rule is one rule in
  two places, not two rules.

**The billing rule is one position, not two.** The apparent conflict — this item
forbidding a metered key while `runtime/adapters/codex-cli/auth.ts:86` documents
`OPENAI_API_KEY` precedence — dissolves on reading what the adapter actually does:

- It **drops ambient inherited keys**. `resolveCodexAuth` seeds the spawn env with
  each auth variant set to `undefined` (`auth.ts:77-83`) and the merge loop deletes
  those keys from the child's environment (`exec.ts:82-91`). The substrate's `env`
  defaults to `{}`, explicitly **not** `process.env` (`index.ts:30-43`).
- What it permits is an **explicitly-passed instance credential**: a self-hoster who
  wants BYO opts in by passing `env: { OPENAI_API_KEY: … }` (`index.ts:42-43`), and
  pays for it knowingly, for their own gateway's turns.

So both surfaces forbid the same thing — an **ambient** key silently billing — and
differ only on whether a **deliberately configured** one is allowed. It is allowed for
a self-hoster's own gateway turns; it is forbidden here, because this surface spends
the owner's subscription seat, which is what `trident/codex-review.sh:145-152` states
in capitals. The criteria below are scoped to this surface and assert nothing about
the adapter's.

> **One real discrepancy, filed as #645 rather than carried here.** There are three
> scrub lists and none is a superset: `trident/codex-review.sh:152` and
> `trident/codex-build.sh:850` unset `OPENAI_API_KEY`/`OPENAI_KEY`;
> `CODEX_CLI_AUTH_ENV_VARS` covers
> `OPENAI_API_KEY`/`OPENAI_AUTH_TOKEN`/`OPENAI_API_TOKEN` (`auth.ts:37-41`). The
> intersection is one variable, so `OPENAI_KEY` survives the adapter's scrub and two
> token variants survive both wrappers'. One shared list read by every call site is
> the fix, and it is a change against the adapter, not this one.

## What the adapter owns

1. **Thread identity is Neutron's state, not codex's.** The adapter records the
   `thread_id` returned by the first call (`thread.started` on `codex exec
   --json`) against the piece of work, and passes it to every later call. It
   never uses `codex exec resume --last`: "most recent session in this
   `CODEX_HOME`" is a race with every other codex caller on the box, including
   the review gates.
2. **`resume` is not flag-compatible with `exec`.** `codex exec resume` accepts
   no `-s/--sandbox`, no `-C/--cd`, no `--add-dir` and no `--approve-for-me`
   (`codex exec resume --help`, CLI 0.149.1). The sandbox on a resumed turn is
   settable only as `-c sandbox_mode=<mode>`, and the working directory only by
   the process cwd. The adapter sets both explicitly on every call rather than
   inheriting whatever the parent had.
3. **Usage is read from the turn, not estimated.** `codex exec --json` ends a
   turn with `{"type":"turn.completed","usage":{input_tokens,
   cached_input_tokens,…}}`. The adapter records it per call.
4. **Subscription credentials only, and the environment is the hard part.**
   Unchanged from `trident/codex-review.sh`: ChatGPT subscription `auth.json`,
   never a metered `OPENAI_API_KEY`. Validating the file is **not sufficient** —
   the codex CLI prefers an inherited `OPENAI_API_KEY` over persisted OAuth, so the
   adapter scrubs the **union of every recognised credential variable** from every
   child's environment: `OPENAI_API_KEY`, `OPENAI_KEY`, `OPENAI_AUTH_TOKEN`,
   `OPENAI_API_TOKEN`. That is wider than either list in the tree today — the
   wrappers unset the first two under their HARD BILLING CONTRACT header
   (`trident/codex-review.sh:145-152`), `auth.ts:24-33` names the last two as
   variants the spawn must not inherit — and it is deliberately wider, because the
   cost of scrubbing a variable codex ignores is zero and the cost of missing one is
   a silently metered bill. #645 unifies the lists; this contract does not depend on
   it landing first.
5. **One `auth.json` file per account, shared by SYMLINK.** codex rotates the
   refresh token when it refreshes, so two independent copies of one account's
   `auth.json` revoke each other (`trident/codex-credential.ts:396-399`). A second
   `CODEX_HOME` for the same account carries a **symlink** to the canonical file —
   never a copy, and never a hard link. The link type is load-bearing, not
   incidental: a credential file is rewritten by atomic replacement, which gives the
   canonical path a new inode, and a hard link stays behind on the old one serving a
   stale token.
6. **Approvals, and who is allowed to be the approver.** Headless codex cannot ask
   *Neutron* for an approval — there is no channel for it. `-c
   approval_policy=on-request` alone makes codex refuse an escalation outright, with
   **exit 0** and no event, so a caller that sets it without a reviewer gets a task
   silently not done. The only headless mechanism is codex's own automatic-review
   subagent, and there is **one form for every call**: `-c approval_policy=on-request`
   with `-c approvals_reviewer=auto_review`, measured working on a first call and on a
   resumed one alike. `--approve-for-me` is the same thing spelled as a flag and is
   **not used**, because it does not exist on `codex exec resume` — one form that works
   everywhere beats two that must be selected by call shape. **It is not a safety
   control**
   — the spike did not establish that it ever denies. Therefore: work that needs an
   approval *decision* does not run on headless codex, and an approval that must
   reach the **owner** never does — owner questions flow from the orchestrator
   (Decisions Log 2026-09-11). Today neither consumer needs one: the build runs
   `--sandbox danger-full-access` on record (`trident/codex-build.sh:181-200`) so it
   never escalates, and review reads a diff.
7. **The CLI's contract is probed at startup, not assumed.** Before the first turn,
   the adapter verifies the surface it depends on — the `resume` **subcommand**, and
   the config keys it passes — and refuses with a distinct unsupported-version
   outcome if it is absent, recording `codex --version` either way. A probe rather
   than a pinned version string, because the wrappers do not install codex (they
   check `command -v codex` and degrade to NOT_CONNECTED,
   `trident/codex-review.sh:154`), so the binary is the host's and a pin here would
   be a claim about someone else's machine. The probe runs
   `--strict-config --ignore-user-config` so the **user's** config file is out of scope
   — a gate must fail only on what it gates, and a stale field in that file (#647) is
   not a CLI contract violation. Precedent and same policy: #538's herdr client must
   `ping` and compare protocol versions for exactly this reason.
8. **A thread id has exactly one owner, and that owner's calls on it are strictly
   sequential.** Fan-out is expressed as **one thread id per lane**, never as
   several callers sharing an id. Cache warmth is unaffected — it is per-thread,
   so each lane keeps its own warm thread — and this is the only arrangement that
   holds across processes, because the lock that enforces it is codex's, not ours.
   Concretely, when the adapter is asked for a concurrent call on a thread already
   in flight:
   - **The second caller waits**, on a per-thread queue keyed by thread id, up to
     a bounded timeout. It does not get a fresh thread silently: that would
     abandon the conversation the caller asked to continue.
   - **On timeout, and on a writer-lock error that arrives anyway** — which it can,
     because the queue is per-process and the lock is per-`CODEX_HOME` — the caller
     gets a **distinct typed outcome naming the conflict**, never a generic
     failure and never a silent retry loop. That is the #542/#576 rule applied
     here: a distinguishable failure state must be reportable as itself.

   **Why this is a rule and not a caution.** The writer lock was measured on the
   persistence side of the spike and counted against it, but going one-shot removes
   only the *wedged long-lived owner*; the lock still holds for the duration of an
   active call. The reason to reuse a thread at all is warmth across recurring
   work, so recurring work is exactly what will share an id — and a retry landing
   on top of an in-flight call, or several review seats on one thread, overlaps by
   construction. "Avoid overlapping calls" is not a contract; the above is.

## Acceptance

Every criterion below was written, then re-read against one question: **what is the
weakest implementation that passes this?** Where the answer was an implementation
that should be rejected, the criterion was widened. The `- [ ]` text is the widened
form; the "kills:" note names what the earlier form let through.

- [ ] **A recorded `thread_id` survives the adapter being destroyed, and the resumed
      call reaches the first call's conversation.** verify: (1) generate a fresh
      ≥128-bit nonce (`randomUUID()`) and plant it in call 1; (2) **create a decoy
      thread afterwards**, so the recorded thread is *not* the most recent one in the
      `CODEX_HOME`; (3) destroy the adapter instance and every in-process cache — a
      new process, or an instance built from nothing but the durable store's path;
      (4) reload the id from durable state and assert it came from there; (5) resume
      and assert the nonce returns by **exact equality** against the generated string
      — never a substring sniff or a model-judged "mentions it".
      Controls: a call with the byte-identical prompt and no `thread_id` must not
      return the nonce; and the nonce must be absent from call 2's prompt and from
      every file the run can read.
      *kills:* a memory-only `Map` (dies at step 3); a guessable fact (the control
      passes by inference); **and "resume the most recent thread"** — without the
      decoy at step 2, `resume --last` recalls the nonce and passes.

- [ ] **The follow-up call is built as a resume of the recorded id, and of no other.**
      verify: the argv is exactly `exec resume <the recorded id> …` — the `resume`
      **subcommand**, never a `--resume` flag, which does not exist on this CLI
      (`codex exec --resume <id>` → `error: unexpected argument '--resume' found`,
      exit 2) — and the id equals the one read back from durable state. With the
      decoy thread present, assert the argv carries the **recorded** id and not the
      decoy's.
      *kills:* re-sending prompt text to fake continuity (no `resume`, no id); and
      any newest-thread heuristic, which the decoy makes visible in the argv.

- [ ] **`--last` and every equivalent of it are absent.** verify: `grep -rn -- '--last'`
      over the adapter's sources returns nothing (positive control: the same grep over
      this file finds it) **and** the behavioural half — with the decoy thread present,
      a follow-up call must reach the recorded thread, not the newest.
      *kills:* an adapter that avoids the literal string but computes "most recent"
      itself by reading the sessions directory. A grep tests a spelling; this tests
      the behaviour the rule is about.

- [ ] **Every call applies the caller's sandbox mode and cwd, exactly, and never
      disables the sandbox.** verify: build argv for **two different** caller-requested
      modes (`read-only`, `workspace-write`) and assert each carries
      `-c sandbox_mode=<that exact value>` by string equality — not a prefix match on
      `sandbox_mode=`. Assert no argv the adapter can build carries an empty value, or
      `danger-full-access` unless the caller asked for it, or
      `--dangerously-bypass-approvals-and-sandbox` **ever**. cwd is exercised with a
      value different from the test process's own.
      *kills:* a hard-coded constant (two modes); an empty value (prefix match); and
      **an implementation that honours the mode and then bypasses the sandbox
      entirely**, which the earlier wording permitted because the bypass exclusion
      lived only in the approval criterion.

- [ ] **A metered API key cannot be spent, including one inherited from the
      environment.** verify:
      (i) an `auth.json` with `auth_mode` absent and `OPENAI_API_KEY` set returns the
      not-connected outcome without spawning codex; a subscription `auth.json` spawns it.
      (ii) seed the **union of every recognised credential variable** in the parent —
      `OPENAI_API_KEY`, `OPENAI_KEY`, `OPENAI_AUTH_TOKEN`, `OPENAI_API_TOKEN` — and
      assert **not one** reaches the process that execs codex. Read the child's
      environment (the env handed to the spawn, or `/proc/<pid>/environ`), never the
      config: the file being correct is what the broken implementation gets right.
      (iii) assert the adapter **execs `codex` directly** rather than through a login
      shell.
      Bidirectional: `PATH` and a benign marker (`NEUTRON_SCRUB_CONTROL=1`) must still
      be present in the child.
      *kills:* validating the file and leaking an ambient key (the CLI prefers it —
      `trident/codex-review.sh:145-152`); scrubbing only the wrappers' two variables
      while `auth.ts:24-33` names two more the spawn must not inherit; a scrub that
      empties the environment (the bidirectional half); and **`bash -lc "codex …"`,
      which re-sources the user's profile and can re-export a scrubbed key into the
      grandchild that actually runs.**

- [ ] **A second `CODEX_HOME` for one account reaches the canonical `auth.json`
      through a symlink, and still does after a rotation.** verify:
      (i) `lstat` on the secondary `auth.json` reports a **symbolic link** and
      `realpath` equals the canonical file — **never inode equality**, which a hard
      link also satisfies.
      (ii) rotate the canonical file the way a client actually does — write temp,
      then `rename`/`replace` over the path — and assert the secondary reads the new
      token.
      (iii) perform a rotation **through the secondary path too**, and assert the
      secondary is *still a symlink* afterwards and both paths still agree.
      *kills:* `copyFile`; `link()` — measured, a hard link is indistinguishable from a
      symlink under in-place writes and serves a **stale token** after an atomic
      replace; and **a rotation through the secondary path that replaces the link with
      a regular file**, silently ending the sharing the first two checks established.

- [ ] **Overlapping calls on one thread id serialize; calls on different thread ids do
      not.** verify: start call A, and while it is in flight start call B on the **same**
      id; assert B's turn began no earlier than A's completion and both returned their
      own result. Then start two calls on **different** thread ids and assert they
      overlap in time. Negative half: force the writer-lock error from outside the
      per-process queue and assert the caller gets the **conflict-specific typed
      outcome** — not the generic failure outcome, and not a success.
      *kills:* swallowing the conflict and retrying silently; reporting it as an
      ordinary failure; and **a single global lock**, which passes "B waited" while
      serializing every unrelated call — the different-ids half is what separates a
      per-thread queue from a process-wide one.

- [ ] **An escalation is either not requested or completed explicitly — never silently
      refused mid-task.** verify: for build-shaped work the argv matches what ships
      today (`trident/codex-build.sh:1402` runs `--sandbox danger-full-access`, so
      nothing escalates) and carries no approval routing. For escalation-capable work,
      **drive a real escalation to completion** — it is not enough that the mode
      exists — with argv carrying `-c approval_policy=on-request` **and**
      `-c approvals_reviewer=auto_review`, on **both** a first call and a resumed one:
      measured, that single form works on both, so there is one form and one assertion.
      Negative half: a call built with `approval_policy=on-request` and **no** reviewer
      must be refused by the adapter before dispatch — measured, that combination makes
      codex refuse the escalation with **exit 0** and no approval event, so the work is
      silently not done.
      *kills:* satisfying the criterion by never escalating at all (the "not requested"
      branch alone); `--dangerously-bypass-approvals-and-sandbox`, excluded above; and
      **the earlier split form**, which required `--approve-for-me` on first calls in
      the contract while the assertion demanded the config pair — so the documented
      design necessarily failed its own criterion.

- [ ] **The CLI's contract is verified at startup and refused loudly, before any turn
      is spawned — and the probe fails only on the contract it gates.** verify: the
      probe checks (a) `codex exec resume --help` exposes the `resume` **subcommand**,
      and (b) **every config key the adapter passes** — `sandbox_mode`,
      `approval_policy`, `approvals_reviewer` — is recognised, by a single
      `codex exec --strict-config --ignore-user-config` invocation carrying all of them
      plus a deliberately bogus **sentinel** key. Measured: codex reports
      `unknown configuration field <sentinel> in -c/--config override` and exits
      **before any model call** — 0.06 s, zero tokens — while a misspelled real key is
      named **instead of** the sentinel.
      Positive case: the probe passes and the recorded `codex --version` reaches the
      run's record. Negative cases, **one per relied-upon key**: a stub rejecting that
      key yields a **distinct typed unsupported-version outcome** and the test asserts
      **no turn was spawned** — not merely that the run failed.
      **Day-one case, and it is a real machine's state (#647):** with a user
      `config.toml` containing an unrecognised field, the probe must still **pass**.
      `--ignore-user-config` is why, and it is the chosen mechanism rather than parsing
      the error text: the two failures are distinguishable by message shape
      (`in -c/--config override` versus a `<path>:<line>:<col>` prefix), but a probe
      that decides whether the CLI is stable by parsing that CLI's unstable error
      strings is circular. Taking the user's file out of scope removes the failure mode
      instead of classifying it. Should a config-file error ever surface anyway, it is a
      **separate, non-blocking** outcome — never the unsupported-version refusal.
      *kills:* a probe that checks only `resume` and lets a rejected `sandbox_mode`
      surface mid-turn, which is the exact failure it exists to prevent; one that
      detects the problem after work has started; a sentinel-less probe that would pass
      silently if codex ever stopped rejecting unknown keys; and **a probe that fails
      closed on this machine today for a reason unrelated to the CLI contract**, whose
      first victim would disable the gate rather than fix the config.

- [ ] **No long-lived codex process is created.** verify: every codex process the
      adapter starts — **including any detached or re-parented descendant**, not only
      direct children — has exited by the time the call returns; no codex process
      remains in the adapter's process group; and the adapter exposes no
      start/stop/health surface for a server and opens no listening socket.
      *kills:* the persistent shape returning by the back door; and **a detached
      grandchild**, which "every child has exited" does not cover.

## Telemetry, deliberately not acceptance

Record `turn.completed.usage.{input_tokens,cached_input_tokens}` per call and
surface the ratio. **It is observational and must not gate anything.** Cache warmth
is *why* this shape was chosen — the spike measured 97–99% cached on resumed turns —
but it does not prove the recorded thread id was used, and it fails in both
directions if used as a criterion:

- a **correct** implementation can drop below any threshold through server-side
  eviction, an eligibility change, a changed system prompt or a service policy
  change — none of which are this adapter's behaviour;
- the **mutant** it would be aimed at, re-sending context, passes whenever it
  reproduces an identical prefix.

The behaviour is proved by the argv/thread-id assertion and the
restart-crossing recall test. The ratio's real job is watching, in production,
whether the premise behind the decision still holds — if resumed turns stop being
cache-warm, the cost argument that retired the persistent REPL has changed and the
decision deserves re-examination. That is a signal to read, not a build to fail.
