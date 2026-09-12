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
   adapter scrubs `OPENAI_API_KEY` **and** `OPENAI_KEY` from every child's
   environment, exactly as `trident/codex-review.sh:145-152` does under its HARD
   BILLING CONTRACT header. A correct `auth.json` beside a leaked inherited key
   bills the metered key.
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
   subagent, reached as `--approve-for-me` on a first call and as `-c
   approvals_reviewer=auto_review` on a resumed one. **It is not a safety control**
   — the spike did not establish that it ever denies. Therefore: work that needs an
   approval *decision* does not run on headless codex, and an approval that must
   reach the **owner** never does — owner questions flow from the orchestrator
   (Decisions Log 2026-09-11). Today neither consumer needs one: the build runs
   `--sandbox danger-full-access` on record (`trident/codex-build.sh:181-200`) so it
   never escalates, and review reads a diff.
7. **A thread id has exactly one owner, and that owner's calls on it are strictly
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

- [ ] A recorded `thread_id` survives **the adapter being destroyed**, and the
      resumed call reaches the first call's conversation. verify: one test that
      crosses a real restart, because two calls in one process is a weaker claim
      wearing this one's clothes — **a memory-only `Map` passes that and loses
      continuity on restart, which is the exact boundary this design is built on.**
      The test: (1) generate a fresh high-entropy nonce (≥128 bits, e.g.
      `randomUUID()`) and plant it in call 1; (2) **destroy the adapter instance and
      every in-process cache** — a new process, or at minimum a new instance
      constructed from nothing but the durable store's path; (3) **reload the
      thread id from durable state**, and assert it was read from there, not
      carried in a variable; (4) resume and assert the nonce comes back by **exact
      structured extraction** — equality against the generated string, never a
      substring sniff or a model-judged "mentions it".
      Control: a call prompted with the **byte-identical text** and no `thread_id`
      must not return the nonce. And assert the nonce is absent from call 2's own
      prompt and from any file the run can read (the worktree, `AGENTS.md`, the spec
      items), or what is measured is retrieval from context the test handed over.
      A low-entropy or guessable fact would let the "no memory at all"
      implementation pass the control by inference, which is one of the two wrong
      implementations this criterion exists to catch; the memory-only map is the
      other.
- [ ] The resumed call's `turn.completed.usage.cached_input_tokens` is at least
      90% of its `input_tokens`. verify: the same test reads the JSONL usage
      event. This is the whole cost case for thread reuse; an adapter that
      re-establishes context by re-sending a prompt instead of resuming the
      thread fails this while still passing the recall assertion above.
- [ ] Every `resume` call applies the **caller's** sandbox mode and cwd, exactly.
      verify: a test builds resume argv for **two different** caller-requested
      modes (e.g. `read-only` and `workspace-write`) and asserts, for each, that
      argv contains `-c sandbox_mode=<that exact value>` — string equality against
      the requested mode, not a prefix or substring match on `sandbox_mode=`. Two
      modes is the load-bearing part: one mode is satisfied by a hard-coded
      constant. The test asserts explicitly that no argv it builds carries an empty
      value or `danger-full-access` unless that is what the caller asked for, and
      that the child's cwd equals the caller's value — exercised with a caller cwd
      **different from the test process's own**, so inheriting the parent's cwd
      fails rather than coincidentally passing.
- [ ] `--last` appears nowhere in the adapter. verify: `grep -rn -- '--last'` over
      the adapter's sources returns nothing, with the positive control that the
      same grep over `docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md`
      finds it.
- [ ] A metered API key cannot be spent, **including one inherited from the
      parent environment**. verify: two tests, and the second is the one that
      matters.
      (i) File path: an `auth.json` with `auth_mode` absent and `OPENAI_API_KEY`
      set returns the not-connected outcome without spawning codex; a subscription
      `auth.json` does spawn it.
      (ii) **Environment path:** the test seeds **both** `OPENAI_API_KEY` and
      `OPENAI_KEY` in the parent environment alongside a valid subscription
      `auth.json`, then asserts **neither variable is present in the spawned
      child's environment**. The assertion must read the child's env (the env
      object handed to the spawn, or `/proc/<pid>/environ`), **never** the config or
      the `auth.json` — the file being correct is exactly what the broken
      implementation gets right. This is not hypothetical: the codex CLI **prefers**
      an inherited `OPENAI_API_KEY` over persisted OAuth, which is why
      `trident/codex-review.sh:145-152` unsets both variants under a header calling
      it a HARD BILLING CONTRACT. An adapter that validates the file and then leaks
      an inherited key into the child silently bills a metered key while passing
      every other criterion here.
- [ ] A second `CODEX_HOME` for one account reaches the canonical `auth.json`
      **through a symlink**, and keeps reaching it across a rotation. verify: two
      assertions, and the second is the one with teeth.
      (i) **Structural:** `lstat` on the secondary `auth.json` reports a **symbolic
      link** (`islink` true), and the link resolves to the canonical file — assert
      `realpath` equality, **never inode equality**, which a hard link also
      satisfies.
      (ii) **Behavioural, and it must use atomic replacement:** rewrite the
      canonical file the way a client actually rotates a credential — write a temp
      file, then `rename`/`replace` it over the canonical path — and assert the
      secondary home reads the **new** token back. An in-place mutation is not an
      acceptable substitute here: measured, a hard link and a symlink are
      indistinguishable under in-place write (both read the new value) and diverge
      only under replacement, where the hard link keeps the old inode and serves a
      **stale token**.
      Two mutants this kills, both of which passed the earlier wording: `copyFile`,
      and `link()`. The second is the dangerous one, because atomic replace is the
      *correct* way to rewrite a credential file — so a hard-linked implementation
      would pass every test here and fail in production at the exact moment this
      criterion exists to protect, a refresh, silently revoking the other home
      (`trident/codex-credential.ts:396-399`).
- [ ] Two overlapping calls on one thread id produce the specified behaviour, not a
      collision. verify: a test starts call A on a thread and, while A is still in
      flight, starts call B on the same thread id; it asserts B **waited** (B's
      turn began no earlier than A's completion) and that both returned their own
      result. Negative half, and the one that matters: a test that forces the
      writer-lock error — a second `CODEX_HOME`-level caller the per-process queue
      cannot see — asserts the caller receives the **conflict-specific typed
      outcome**, and asserts it is NOT the adapter's generic failure outcome and
      NOT a success. An adapter that swallows the conflict and retries silently, or
      one that reports it as an ordinary failure, fails this while still passing
      the waiting half.
- [ ] An escalation is either **not requested** or **completed explicitly** — never
      silently refused mid-task. verify: the adapter's default for build-shaped work
      matches what ships today (`trident/codex-build.sh:1402` runs
      `--sandbox danger-full-access`, so nothing escalates) and a test asserts the
      argv carries no approval routing in that mode. For any call that CAN escalate,
      a test asserts the argv carries **both** `-c approval_policy=on-request` and
      `-c approvals_reviewer=auto_review`, and drives a real escalation that
      completes. Negative half, and it is the one that catches the measured trap:
      a call built with `approval_policy=on-request` and **no** reviewer must be
      refused by the adapter at build time rather than dispatched — measured on CLI
      0.149.1, that combination makes codex refuse the escalation outright with
      **exit 0** and no approval event, so the model reports a task it could not do
      while the wrapper sees success.
      A test that only asserts "an escalation succeeded" passes against
      `--dangerously-bypass-approvals-and-sandbox`, so the test must also assert
      that flag is absent from every argv the adapter builds.
- [ ] No long-lived codex process is created. verify: a test asserts every codex
      child the adapter spawns has exited by the time the adapter's call returns,
      and that the adapter exposes no start/stop/health surface for a server.
      This is the criterion that fails if the persistent shape is reintroduced by
      the back door.
