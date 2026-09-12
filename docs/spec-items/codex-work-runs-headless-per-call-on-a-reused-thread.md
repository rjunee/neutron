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
   subagent, reached as `--approve-for-me` on a first call and as `-c
   approvals_reviewer=auto_review` on a resumed one. **It is not a safety control**
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
   be a claim about someone else's machine. Precedent and same policy: #538's herdr
   client must `ping` and compare protocol versions for exactly this reason.
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
- [ ] The resumed call is built as a **resume of the recorded id**, asserted
      deterministically on the argv. verify: a test asserts the argv for a
      follow-up call is exactly `exec resume <the recorded thread_id> …` — the
      `resume` **subcommand**, not a `--resume` flag (which does not exist on the
      pinned CLI: `codex exec --resume <id>` returns `error: unexpected argument
      '--resume' found`, exit 2) — and that the id equals the one read back from
      durable state. Negative half: an adapter that re-establishes context by
      re-sending prompt text must fail, which this catches because its argv carries
      no `resume` subcommand and no id.
      **This, plus the restart-crossing test above, is the proof that the thread was
      reused.** The cache ratio is not: see the telemetry note below.
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
      (ii) **Environment path:** the test seeds the **union of every recognised
      codex credential variable** in the parent environment — `OPENAI_API_KEY`,
      `OPENAI_KEY`, `OPENAI_AUTH_TOKEN`, `OPENAI_API_TOKEN` — alongside a valid
      subscription `auth.json`, then asserts **not one of them is present in the
      spawned child's environment**. The union, not either existing list: the
      wrappers unset only the first two (`trident/codex-review.sh:152`,
      `trident/codex-build.sh:850`) while `auth.ts:24-33` classifies the last two as
      variables the spawn "must NOT inherit". #645 unifies the lists; **this
      criterion does not wait for it**, because a boundary this item promises is a
      boundary this item tests. An implementation that leaks `OPENAI_AUTH_TOKEN`
      would otherwise pass this suite while breaking the contract the suite exists
      to enforce — on a hole this very document names.
      Bidirectional half: a benign control variable seeded in the parent (say
      `NEUTRON_SCRUB_CONTROL=1`) and `PATH` must **still be present** in the child,
      or a scrub that empties the whole environment satisfies the assertion above. The assertion must read the child's env (the env
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
- [ ] The codex CLI's contract is **verified at startup and refused loudly** when it
      does not match. verify: a test drives the adapter against a stub `codex` whose
      `exec resume --help` lacks the `resume` subcommand and asserts the adapter
      returns a **distinct typed unsupported-version outcome before spawning any
      turn** — not a generic failure, and not a run that proceeds. Positive half: a
      stub exposing the expected surface is accepted and the recorded
      `codex --version` appears in the run's record.
      **Chosen: a capability probe, not a version pin** — the number is not the
      contract, and the contract is not ours to pin. The wrappers do not install
      codex; they check `command -v codex` and degrade to NOT_CONNECTED
      (`trident/codex-review.sh:154`, `trident/codex-build.sh:852`), so the binary is
      whatever the host already has and a version literal in this repo would be a
      claim about someone else's machine. A probe of the actual surface is
      enforceable there, and survives a patch release that changes nothing.
      **This drift is measured, not anticipated:** `runtime/adapters/codex-cli/exec.ts:67`
      builds `codex exec --resume <id>`, which on 0.149.1 is
      `error: unexpected argument '--resume' found`, exit 2 — `resume` became a
      subcommand and a caller in this tree has been broken by it already, reporting
      only an exit code nobody reads. Same policy as #538, whose herdr client must
      `ping` and compare protocol versions because the socket server does no version
      check and the protocol moved 20 → 22 in nineteen days: **verify the contract at
      startup and fail loudly rather than discovering it mid-run.**
- [ ] No long-lived codex process is created. verify: a test asserts every codex
      child the adapter spawns has exited by the time the adapter's call returns,
      and that the adapter exposes no start/stop/health surface for a server.
      This is the criterion that fails if the persistent shape is reintroduced by
      the back door.

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
