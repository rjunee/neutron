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
  option **does not exist** on the CLI measured here, 0.149.1 — and nothing pins that
  version, which is why the probe below is a capability check: `codex exec --resume <id>`
  returns
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
5. **One account, one `CODEX_HOME`.** The adapter uses the `CODEX_HOME` the wrappers
   resolve and never materialises an account's `auth.json` a second time anywhere.
   Multiple homes exist in production but hold **different** credentials — one per
   rotation seat (`slotHome`, `trident/codex-credential.ts:401`), one per project
   override (`codexProjectHome`, `trident/codex-auth.ts:191`) — and selecting among them
   is a pointer at a directory, nothing more (`trident/codex-credential.ts:396-399`).

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
   **There is no unconditional "the second caller waits".** Overlap has two cases and
   they get different answers, because only one of them is ours to coordinate:
   - **In-process overlap waits, under a bound that is a real setting.** A second call
     on a thread already in flight queues on a per-thread queue keyed by thread id. The
     wait is bounded by a **configured, inspectable timeout** — not an implicit one and
     not none — and on expiry the caller gets the typed conflict outcome. It never gets
     a fresh thread silently; that would abandon the conversation it asked to continue.
   - **Cross-process overlap does not wait; it returns the typed conflict
     immediately.** Two adapter processes sharing one thread id is a **design
     violation, not a supported case** — the rule above is one thread id per lane. The
     queue is per-process and the lock is codex's, per-`CODEX_HOME`, so there is no
     shared primitive to wait on: waiting would mean blocking on another process's lock
     with no coordination and no bound. Reporting the conflict is the only honest
     option, and it surfaces the design violation instead of hiding it in latency.
   Both outcomes are the **distinct typed conflict**, never a generic failure and never
   a silent retry loop — the #542/#576 rule: a distinguishable failure state must be
   reportable as itself.

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
      every readable file **outside codex's own thread store**.
      **The thread store is excluded because it is the mechanism under test, not a
      leak.** codex appends every session to a rollout at
      `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` — measured in this tree, and
      written even for an unauthenticated run (`trident/codex-rotation-io.ts:6-19`) —
      so that file **necessarily contains the planted nonce**; it is what `resume`
      rehydrates from. A blanket "absent from every readable file" is therefore not
      merely strict, it is **unsatisfiable**: the nonce must be persisted to be
      recalled. The claim the control actually needs to make is narrower and more
      useful — *recall arrives through codex's own persistence and through no other
      path*. So: assert the nonce is absent from the worktree, from `AGENTS.md` and the
      spec items, from any adapter-owned state file, and from the prompt; assert it
      **is** present in the recorded thread's rollout, which pins that the mechanism
      being exercised is the one claimed. Alternatively run the control under a
      filesystem policy that cannot read the rollout at all.
      *kills:* a memory-only `Map` (dies at step 3); a guessable fact (the control
      passes by inference); **"resume the most recent thread"** — without the decoy at
      step 2, `resume --last` recalls the nonce and passes; **an adapter that smuggles
      the nonce through its own state file or the prompt** (the narrowed absence list);
      and the earlier blanket wording, which no implementation could satisfy.

- [ ] **The follow-up call is built as a resume of the recorded id, and of no other.**
      verify: the argv is exactly `exec resume <the recorded id> …` — the `resume`
      **subcommand**, never a `--resume` flag, which does not exist on this CLI
      (`codex exec --resume <id>` → `error: unexpected argument '--resume' found`,
      exit 2) — and the id equals the one read back from durable state. With the
      decoy thread present, assert the argv carries the **recorded** id and not the
      decoy's.
      *kills:* re-sending prompt text to fake continuity (no `resume`, no id); and
      any newest-thread heuristic, which the decoy makes visible in the argv.

- [ ] **A follow-up never resolves "the most recent thread" by any route.** verify
      **behaviourally**: with the decoy thread present — created *after* the recorded one
      — a follow-up call must reach the **recorded** thread, and its argv must carry the
      recorded id. That is the property; it holds regardless of how the adapter is
      spelled.
      *Cheap secondary check, labelled as such:* `grep -rn -- '--last'` over the
      adapter's sources returns nothing (positive control: the same grep over this file
      finds it).
      *kills:* an adapter that avoids the literal string and computes "most recent"
      itself by reading the sessions directory — **a grep enumerates the spellings
      someone thought of and cannot express a property about what the program does.**

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
      (i) **File path — match `validateCodexSubscriptionAuth`'s coverage, case for case**
      (`trident/codex-auth.ts:73-115`), asserting codex is **not spawned** in each
      negative: a bare `sk-…` paste (`:85`); an `auth.json` carrying `OPENAI_API_KEY`
      and no tokens; and — the case that bills and that a hand-built suite omits —
      **`OPENAI_API_KEY` present *alongside* valid OAuth tokens**, which the tree rejects
      explicitly because *"the codex CLI PREFERS the key over OAuth, so its presence =
      metered"* (`:108-110`). Positive control: a clean subscription `auth.json` does
      spawn codex.
      The rule this encodes: **where the tree already validates something, match that
      validator's coverage rather than re-deriving cases.** An implementation that
      rejects key-only files and accepts OAuth-plus-key passes a suite built the other
      way, and bills.
      (ii) seed the **union of every recognised credential variable** in the parent —
      `OPENAI_API_KEY`, `OPENAI_KEY`, `OPENAI_AUTH_TOKEN`, `OPENAI_API_TOKEN` — and
      assert **not one** reaches the process that execs codex. Read the child's
      environment (the env handed to the spawn, or `/proc/<pid>/environ`), never the
      config: the file being correct is what the broken implementation gets right.
      (iii) assert **the adapter's own spawn execs `codex` directly**, not through a
      login shell (`bash -lc`), whose profile sourcing can re-export a scrubbed key.
      Scoped to the adapter's spawn deliberately: codex runs the *model's* commands
      through `/bin/bash -lc` itself — observed in this spike — and that is not the
      adapter's to change, so a criterion forbidding every login shell in the tree would
      forbid what a correct implementation cannot avoid.
      Bidirectional: `PATH` and a benign marker (`NEUTRON_SCRUB_CONTROL=1`) must still
      be present in the child.
      *kills:* validating the file and leaking an ambient key (the CLI prefers it —
      `trident/codex-review.sh:145-152`); scrubbing only the wrappers' two variables
      while `auth.ts:24-33` names two more the spawn must not inherit; a scrub that
      empties the environment (the bidirectional half); and **`bash -lc "codex …"`,
      which re-sources the user's profile and can re-export a scrubbed key into the
      grandchild that actually runs.**

- [ ] **An account's credentials are never materialised anywhere outside the selected
      existing home.** verify by **checking the resulting state, not the act that produced
      it**: after a full call cycle, walk the filesystem and assert that **no path outside
      the selected `CODEX_HOME`**
      (a) contains the credential's contents — match on a token value seeded for the test;
      (b) is a **hard link to the canonical `auth.json`'s inode**; or
      (c) is a **symlink resolving into that home**.
      This is instrument-independent: it does not care whether the path arrived by
      `copyFile`, `link`, `symlink`, `rename`, a shell redirect, or a syscall from a
      grandchild — and the filesystem is the only observer that sees **every** process,
      which no in-process spy can.
      **Exclude a path by the path itself (`lstat`), never by its resolved target.**
      Measured while building this: a scan that skips anything whose `realpath` lands
      inside the home excludes precisely the symlink pointing at the credential, and
      catches 3 of 4 routes. With lexical exclusion it catches 4 of 4. The escape lives in
      the exclusion rule, not the detection rule.
      Permitted and required not to fail: everything **inside** the selected home,
      including replacement of its own `auth.json` — codex rotates the refresh token there
      (`trident/codex-credential.ts:396-399`). Positive control that the scope is real:
      force a rotation inside the home and the test still passes; have a stub materialise
      the token outside it by **each** of copy, hard link, symlink and rename, and the
      test fails on each.
      *Diagnostic secondaries, not the check:* an fs spy or `strace` localising which call
      did it, the `auth.json` count under the credential root, and the absence of
      `copyFile`/`link`/`symlink` from the adapter's sources.
      *kills:* every previous version of this criterion, and none of them by a mechanism
      the next one anticipated — equal contents passed a copy; inode equality passed a
      hard link; a symlink passed one rotation direction; a **content-bearing-write
      observer passed `ln`**, because `linkat(2)` writes no content, and passed
      `symlinkat(2)` for the same reason. Each fix was correct about the mechanism it had
      just met. A state check is the first version that does not depend on having met the
      mechanism.

- [ ] **In-process overlap on one thread id waits under a configured bound;
      cross-process overlap returns the typed conflict inside a fixed latency ceiling;
      different thread ids never block each other.** verify four cases. **Case (iii)** —
      the cross-process one — must use **two real adapter processes**, not an injected
      error.
      (i) **in-process, within the bound** — start call A, and while it is in flight
      start call B on the **same** id in the same process; assert B's turn began no
      earlier than A's completion and both returned their own result.
      (ii) **in-process, bound exceeded** — set the queue bound to a **small configured
      value** and make A outlast it; assert B returns the **conflict-specific** outcome
      (not a generic error, not a success) and that it returns **within that configured
      bound plus a stated tolerance**, measured against the *configured value* and never
      against A's duration. The bound must be a real, inspectable setting: a test that
      cannot name the number it is asserting is testing nothing.
      (iii) **cross-process** — spawn **two real adapter processes** sharing one
      `CODEX_HOME` and one thread id, with A's turn long enough to still be running when
      B starts; assert B returns the **conflict-specific typed outcome** in **≤ 2
      seconds of wall time, as an absolute ceiling independent of A's duration**.
      *Why that number, stated so it does not drift on the first flake:* codex detects
      the thread-store conflict and errors in **0.44 s** measured on this CLI, so 2 s is
      roughly 4.5× the observed detection cost — ample headroom for a loaded box and
      process startup — while the **shortest successful turn observed anywhere in the
      spike was 3.2 s**, so an implementation that waits for even one turn before giving
      up cannot pass. Asserting only "B returned before A finished" would be satisfied
      by B waiting nine minutes while A ran ten.
      (iv) **different ids** — two calls on **different** thread ids must overlap in
      time.
      Every conflict outcome must be distinguishable from the adapter's generic failure
      outcome and from success.
      *kills:* swallowing the conflict and retrying silently; reporting it as an ordinary
      failure; a single global lock, which passes (i) while serializing every unrelated
      call — (iv) separates a per-thread queue from a process-wide one; an
      implementation that serializes in-process and fails every cross-process overlap,
      which only (iii) can distinguish; **an unbounded in-process queue, and one that
      returns a generic error on expiry** — both passed while (ii) was missing; and **a
      cross-process arm that waits almost as long as A**, which the earlier
      relative-to-A comparison could not fail.

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
      run's record. Negative cases, each asserting a **distinct typed
      unsupported-version outcome** and **zero turns spawned** — not merely that the run
      failed:
      (i) **the `resume` subcommand is absent or its `--help` fails.** This case is
      mandatory and is the one with a known in-tree breakage:
      `runtime/adapters/codex-cli/exec.ts:67` emits the obsolete `codex exec --resume
      <id>` form, which 0.149.1 rejects at **exit 2**. The capability that actually
      broke must not be the one the negatives skip.
      (ii) **one per relied-upon config key** — `sandbox_mode`, `approval_policy`,
      `approvals_reviewer` — a stub rejecting that key.
      (iii) **the sentinel is not named** though the probe ran, standing in for a CLI
      that stopped validating unknown keys.
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

- [ ] **No long-lived codex process is created.** verify by **state, on an instrument
      that can see a re-parented process**: give the test its own unique `CODEX_HOME`, and
      after the call returns scan the **whole process table** for any process whose
      executable is codex and whose environment names that home — asserting none remains.
      **Not by process group, and not by tracked child pids:** a `setsid`/double-forked
      descendant is re-parented to init and leaves both, so either instrument would report
      success precisely in the case the criterion exists to catch. The unique home is what
      makes a full-table scan attributable without parentage.
      Also assert the adapter exposes no start/stop/health surface for a server and opens
      no listening socket.
      *kills:* the persistent shape returning by the back door; a detached grandchild,
      which "every child has exited" does not cover; and **the earlier process-group
      instrument**, which claimed to cover re-parented descendants while structurally
      unable to observe one.

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
