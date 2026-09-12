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
4. **Subscription credentials only.** Unchanged from `trident/codex-review.sh`:
   ChatGPT subscription `auth.json`, never a metered `OPENAI_API_KEY`.
5. **One `auth.json` file per account, shared by reference.** codex rotates the
   refresh token when it refreshes, so two independent copies of one account's
   `auth.json` revoke each other (`trident/codex-credential.ts:396-399`). A
   second `CODEX_HOME` for the same account points at the same `auth.json`; it
   never holds a copy of it.
6. **A thread id has exactly one owner, and that owner's calls on it are strictly
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

- [ ] A second call against a recorded `thread_id` reaches the first call's
      conversation. verify: an automated test **generates a fresh high-entropy
      nonce** per run (≥128 bits, e.g. `randomUUID()`), plants it in call 1, and
      asserts call 2 returns it — by **exact structured extraction**, an equality
      check against the generated string, never a substring sniff or a
      model-judged "mentions it". The control call is prompted with the **byte-identical
      text** to the resumed call and differs only in carrying no `thread_id`; it
      must not return the nonce. The test also asserts the nonce does **not**
      appear in call 2's own prompt, nor in any file the run can read (the
      worktree, `AGENTS.md`, the spec items) — otherwise what is measured is
      retrieval from context the test handed over, not thread recall.
      A low-entropy or guessable fact would let the "no memory at all"
      implementation pass the control by inference, which is the wrong
      implementation this criterion exists to catch.
- [ ] The resumed call's `turn.completed.usage.cached_input_tokens` is at least
      90% of its `input_tokens`. verify: the same test reads the JSONL usage
      event. This is the whole cost case for thread reuse; an adapter that
      re-establishes context by re-sending a prompt instead of resuming the
      thread fails this while still passing the recall assertion above.
- [ ] `resume` calls carry an explicit sandbox mode and cwd. verify: a test
      asserts the argv the adapter builds for a resume call contains
      `-c sandbox_mode=` and that the child's cwd is the value the caller asked
      for — not the parent's. Negative half: a call built with a caller cwd
      different from the test process's cwd must not run in the test process's
      cwd.
- [ ] `--last` appears nowhere in the adapter. verify: `grep -rn -- '--last'` over
      the adapter's sources returns nothing, with the positive control that the
      same grep over `docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md`
      finds it.
- [ ] A metered `OPENAI_API_KEY` in the resolved `CODEX_HOME`'s `auth.json`
      refuses the call rather than spending it. verify: a test builds an
      `auth.json` with `auth_mode` absent and `OPENAI_API_KEY` set and asserts the
      adapter returns the not-connected outcome without spawning codex; the
      positive half asserts a subscription `auth.json` does spawn it.
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
- [ ] No long-lived codex process is created. verify: a test asserts every codex
      child the adapter spawns has exited by the time the adapter's call returns,
      and that the adapter exposes no start/stop/health surface for a server.
      This is the criterion that fails if the persistent shape is reintroduced by
      the back door.
