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
`auth.json` revoke each other.

**That was right for the spike and is not a production design** — see "Three rounds on
a mechanism that should not have existed" below. It held only because nothing refreshed
during the two hours: a refresh *initiated from the spike's own home* would have
`rename`d over the symlink, replaced it with a regular file and split the credentials.
The spike needed a second home to avoid contending with the review gates; the shipped
adapter uses the same `CODEX_HOME` as the wrappers and needs no sharing at all.

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
  carries the positive contract (one owner per thread id, per-lane fan-out,
  in-process overlap waiting on a bounded per-thread queue, cross-process overlap
  returning the typed conflict at once, and every conflict distinct per #542/#576) and
  a test that spawns two real processes. That contract took a further round of its own
  — see "When the prose already knew and the criterion did not" below.

  **And the correction then contradicted itself inside the same change.** The spec
  item was fixed to say the lock survives while this record's own Decisions Log
  entry still read "the headless shape has no such state" — an overstatement sitting
  in the document an implementer reads *before* deciding whether the queue and the
  typed-conflict outcome are needed. Caught by the gate, not by the author. That is
  the #574 rule turned inward: a change that corrects a claim must grep for every
  place asserting the old one, **including the places it edited an hour earlier**.
  The entry now says what is true — headless removes the wedged long-lived owner,
  not the lock.

### Three rounds on a mechanism that should not have existed

The sharing of one account's `auth.json` across two `CODEX_HOME`s was specified, then
corrected three times, each correction defeated by a more accurate model of
*replacement*:

| mechanism | passes | fails |
|---|---|---|
| equal contents | a **copy** | the first token refresh |
| same inode / `realpath` | a **hard link** | atomic replace — new inode, stale token behind |
| a **symlink** | rotation through the *canonical* path | rotation through the *secondary* path |

The last was measured, and it is the sharpest: **`rename` replaces a directory entry and
does not follow the final symlink.** So a codex process whose `CODEX_HOME` *is* the
secondary directory turns the link into a regular file on its own refresh, and the
credentials split silently — the exact failure the mechanism existed to prevent.

Each fix was correct about the rotation it imagined. None was correct about all of them,
and the fourth fix (symlink the *directory*, so a rename inside it lands in the real one)
was never needed, because **the premise was wrong**. A second home for one account was an
artefact of *this spike's* isolation requirement — running without contending with the
review gates — and it got written into the production contract. Production never puts one
account in two homes:

> *"A SEAT IS NEVER MOVED OR COPIED BETWEEN DIRECTORIES. The codex CLI rotates the
> refresh token when it refreshes, so two live directories holding one account revoke
> each other. Selection is a pointer at one of these dirs and nothing more."*
> — `trident/codex-credential.ts:396-399`

Multiple homes do exist there, and they hold **different credentials**: one per rotation
seat (`slotHome`, `:401`) and one per project override (`codexProjectHome`,
`trident/codex-auth.ts:191`). The tree already forbade the thing the contract was
labouring to make safe. The item now says *one account, one home, and no materialising of
credentials by copy, hard link or symlink* — and the whole class of finding is gone
rather than fixed a fourth time. **The diff got smaller.**

### When the prose already knew and the criterion did not

The concurrency contract promised, unconditionally, that a second caller **waits** — and
acknowledged two sentences later that the queue is per-process while the lock is codex's,
per-`CODEX_HOME`. Acceptance tested in-process serialization, and separately *injected* a
writer-lock error. Nothing drove two real adapter processes sharing a thread id. So an
implementation that queues in-process and fails every cross-process overlap satisfied
every criterion while contradicting the promise.

**The promise and its exception sat in adjacent sentences and neither contradicted the
other loudly enough to notice.** An identical construction appeared in another lane the
same day (#577: "concurrent replacement converges", full stop, beside code documenting an
interleaving that cannot converge without a lock). Two subsystems, two authors, one shape
— which makes it structural rather than careless, and the mechanism is worth naming: **a
criterion gets read as a summary of the prose above it rather than as its own claim**, so
a condition stated in that prose is felt to be covered without ever being asserted.

Resolved by deciding the contract instead of describing both halves, and the design
already implied the answer. One thread id per lane means **cross-process overlap on one id
is a design violation, not a supported case** — so in-process overlap waits on the
per-thread queue, and cross-process overlap returns the typed conflict *immediately*.
Waiting there would mean blocking on another process's lock with no shared primitive and
no bound; there is nothing to wait on. Two conditional promises, both true, both testable,
and the unconditional one is gone.

And the test changed shape, for the reason the `--strict-config` sentinel did: acceptance
now spawns **two real adapter processes** sharing a `CODEX_HOME` and a thread id. Forcing
a writer-lock error tests the handling of a symptom the test injected; two processes test
whether the symptom arises at all.

**And one more, of a kind the other four cannot reach.** The cross-process arm asserted
that B returns *before A finishes*. That is satisfied by B waiting nine minutes while A
runs ten: the promise was "immediately" and the assertion scaled with A's duration. The
case was present, the mechanism was right, and **the comparison could not fail for the
reason it existed** — its looseness invisible precisely because a comparison against a
real quantity looks like a real constraint. The in-process arm had the mirror gap: a
bounded timeout was promised and only successful serialization tested, so an unbounded
queue passed.

Both now assert against numbers the test controls. The cross-process ceiling is **2
seconds absolute**, chosen from measurement rather than taste: codex detects the
thread-store conflict and errors in **0.44 s** on this CLI, so 2 s is ~4.5× the observed
detection cost — headroom for a loaded box — while the **shortest successful turn
anywhere in this spike was 3.2 s**, so an implementation that waits for even one turn
before giving up cannot pass. The rationale is recorded beside the number because a bound
without one drifts at the first flake. The in-process case sets a small configured bound,
makes A outlast it, and asserts the conflict-specific outcome arrives within *that
configured value* — a bound the test cannot name is a bound it is not testing.

So: **does this assertion's strength depend on something the test does not control?**
Swept across the other nine, it caught nothing — every remaining assertion is an equality,
an absence, a count or a causal ordering rather than a magnitude, and ordering is the
claim itself in the serialization case rather than a proxy for it. First sweep of this PR
to come back empty, which is the only reason to believe the section is converging.

**This is a fourth audit question, and it points at documentation rather than
environment.** The path verified in the spike was single-process, so the criterion
inherited a boundary the prose had already named: *what does this criterion assume that
the surrounding text has already contradicted?* The full set, in the order they were
learned:

1. What is the weakest implementation that passes this? — *permits too much*
2. What would the correct implementation necessarily do that this forbids? — *permits too little*
3. What does this criterion assume about how the system behaves, and have I measured it? — *true only in an environment that does not exist*
4. What does this criterion assume that the surrounding prose has already contradicted? — *the document disagrees with itself*
5. Does this assertion's strength depend on something the test does not control? — *the comparison cannot fail for the reason it exists*
6. Can the instrument actually observe what this criterion asserts? — *the test sees nothing, though property, criterion and mutant are all correct*

### Two rules about instruments and about the tree

**A textual instrument cannot express a behavioural property.** Three criteria here leaned
on source greps. The one-home rule counted `auth.json` files under the credential root and
grepped for `copyFile`/`link`/`symlink` — and a mutant that reads the credential and
`writeFile`s it to `/tmp/auth.json` violates the property while matching none of those
names and leaving the count untouched. A grep enumerates the mechanisms someone thought of.
The fix was to **raise the instrument, not narrow the claim**: observe or intercept
filesystem writes and assert no write anywhere carries the credential's contents, which
covers `writeFile`, a stream, a shell redirect and whatever the next API is called, because
it asserts the outcome rather than the route. The greps and the file count survive as
*secondary* checks, explicitly labelled, and the `--last` criterion was reshaped the same
way — behavioural primary, grep secondary. Another lane reached this independently today
(#638, where "every rev-range" was delivered as a pattern match and "only itself" as a
basename comparison): **narrowing a claim to fit a textual instrument encodes the gap
permanently; raising the instrument deletes it** — and raising it is available whenever the
property is observable at runtime, which here it was.

**Observe the resulting state, not the act that produced it.** This one criterion was
defeated four times, and every version watched a *mechanism*: equal contents (a copy
passed), inode equality (a hard link passed), a symlink (a rotation through the secondary
path destroyed it), and then a write-observer — which `ln` walks straight through, because
`linkat(2)` carries no content, as does `symlinkat(2)`. Each was an enumeration of ways the
credential could arrive, and each fell to a way not enumerated. The write-observer also
*overclaimed its reach*: an in-process fs spy sees the adapter's own calls and structurally
cannot see a child's syscalls, while the criterion asserted coverage of the whole process
tree.

The fix is the sibling of "scope by location, not by act", applied to the observation rather
than the exclusion: **check the state afterwards.** No path outside the selected home may
contain the credential's contents, be a hard link to its inode, or be a symlink resolving
into it. That is instrument-independent — copy, link, symlink, rename, shell redirect or a
grandchild's syscall all land in the same state — and it fixes the reach problem for free,
because the filesystem is the only observer that sees every process. Demonstrated rather
than argued: four routes, one scan, 4/4 caught.

**And the state check's own scoping repeated the lesson one more time.** The first scan
excluded any path whose `realpath` landed inside the home — which excludes precisely the
symlink *pointing at* the credential, catching 3 of 4. Exclusion must be lexical, on the
path itself (`lstat`), never on its resolved target. Three rounds after "the escape lives in
the exclusion rule", the escape was in the exclusion rule again.

**An instrument's claimed reach is a claim like any other**, and it was asserted rather than
measured. That is question 3 pointed at the tool instead of the environment, and it is the
one failure mode where the property, the criterion and the mutant can all be correct while
the test still sees nothing:

6. Can the instrument actually observe what this criterion asserts, and has that been checked?

Swept over the other nine immediately, and it caught one: the no-long-lived-process
criterion claimed to cover "any detached or **re-parented** descendant" while asserting
*"no codex process remains in the adapter's process group"* — and a `setsid`/double-forked
child is re-parented to init, leaving both the process group and any tracked-pid list. The
instrument would have reported success in exactly the case the criterion existed to catch.
Replaced with a whole-process-table scan attributed by a **unique `CODEX_HOME`** per test,
which needs no parentage to be sound. Two of the ten criteria named an instrument narrower
than their claim, which suggests this question earns a standing place rather than a
one-off.

**When raising the instrument is out of scope, the claim must come down — and the gap
named rather than implied.** The rule this record had been applying was *match the claim to
the instrument, preferring to raise the instrument.* It has a third case. The credential
property said "anywhere outside the selected home" while the test walked four known
locations, so `/dev/shm/auth.json` escaped both the scan and every positive control. Raising
the instrument here would mean a sandbox with an enforced filesystem boundary — larger
machinery than this item should carry. So the claim came down to **"any location the adapter
can write"**, with the scan's root defined as *exactly* that set, enumerated and justified,
and the uncovered case written into the contract in as many words. A true narrow claim beats
an unenforceable broad one, and the difference between the two is only visible if the gap is
stated.

**A refusal must be reachable from an input.** Deleting the escalation route left the
negative half asserting that a call built with `approval_policy=on-request` be *refused* —
incoherent beside a clause forbidding the adapter to build such a call at all: if it cannot
build one there is nothing to refuse, and if it can, the prohibition is false. The refusal
now lives at the **input**: work declares that it needs an approval decision through an
explicit request field, and the adapter rejects it before argv construction, with zero
spawns. That is testable by driving a real request rather than by constructing a forbidden
output — and it is the general form, since a criterion phrased against an artefact the
design forbids can never be satisfied by a correct implementation.

**Widen, then scope BOTH sides — the instrument and the violation.** Every over-strict
criterion on this PR arrived immediately after a widening, and the fourth instance showed
why the procedure as first written was incomplete. Having fixed the state check's
*exclusion* to be lexical, its *inclusion* widened past the property: clause (c) rejected
any symlink resolving anywhere into the selected home, so a harmless
`/tmp/codex-sessions -> <home>/sessions` violated it though no credential had escaped.
Same check, same round, opposite side. The inclusion clauses are now scoped to
**credential-bearing** files and inodes, because the property is about credentials
escaping and not about anything referring to the directory.

The scan was also unbounded — *"walk the filesystem"* is not implementable, and a negative
over an undefined set asserts nothing. It now walks a **controlled root the test creates
and owns**: the selected home, the worktree, the adapter's state dir, and the temp dir the
adapter is given.

So the procedure is: **widen the instrument, then scope what it looks at *and* what it
counts as a violation.** Scoping only the first is what produced four over-strict criteria
from four correct widenings.

**And a route that works, that nothing needs, was deleted rather than certified.** The
acceptance had required escalation-capable work to drive a real escalation to completion
through codex's `auto_review` — the same reviewer this record states was **never observed
denying**. That would have certified codex authorizing its own privileged actions, and a
certified route gets used. Nothing in scope needs one: review reads a diff and the build
runs `--sandbox danger-full-access` so it never requests an escalation. The measurement
stays — test (c) is satisfiable on both call shapes, and that is the answer to the owner's
criterion — but the adapter ships no approval routing at all, and every argv is asserted to
carry none. The negative half survives and is the point of the criterion now: a call built
with `approval_policy=on-request` and no reviewer must be refused **before dispatch**,
because codex answers that combination with exit 0 and no event.

Deleting it had a consequence worth recording, because it is the fourth question in action:
the startup probe validated `sandbox_mode`, `approval_policy` and `approvals_reviewer` as
*"every config key the adapter passes"* — and two of the three were no longer passed. A
probe over a key nothing depends on fails the build for a capability we do not use. The
list is now `sandbox_mode` alone. **Removing a feature leaves claims about it behind**, and
they have to be chased in the same change.

**Raising an instrument has a cost, and it is question 2.** Both over-strict criteria on
this PR arrived *immediately after* a widening, and that is not coincidence. A grep sees
only what you named; a write-observer sees **every** write in the process tree, including
the ones the contract expressly allows. So the first version of the raised check forbade
codex rotating the refresh token inside its own home — a write a correct implementation
necessarily produces (`trident/codex-credential.ts:396-399`) — exactly as the nonce-absence control
had forbidden codex persisting the rollout it must resume from. **A more powerful
instrument observes things the property permits**, so widening the instrument makes
scoping mandatory rather than optional: the new observation surface has to be narrowed to
the property deliberately, and *"everything"* is not a scope. Both checks are now scoped
by **location** rather than by act — no credential material outside the selected home; the
nonce absent everywhere but the thread store — each with a positive control proving the
exclusion is real and not merely asserted. The widening is still right, and still cheaper
than the gap it closes, **provided question 2 runs straight afterwards.**

**Where the tree already validates something, match that validator's coverage.** The
metered-key criterion tested an `auth.json` with a key and no tokens, and missed the
configuration that actually bills: a key present **alongside** valid OAuth tokens, which
codex prefers. `validateCodexSubscriptionAuth` already rejects exactly that, and says why —
*"the codex CLI PREFERS the key over OAuth, so its presence = metered"*
(`trident/codex-auth.ts:108-110`) — plus a bare `sk-…` paste (`:85`). Three cases in the
tree, one in the criterion.

That is the **third** time on this PR that a criterion was narrower than a rule the
repository had already reasoned out, after `auth.ts:24-33`'s "must NOT inherit" variant
list and `codex-credential.ts:396-399`'s seat-never-copied comment. The pattern is now
unmistakable and the rule follows from it: when a validator exists, the criterion's job is
to **match its coverage case for case**, not to re-derive coverage from the cases one
happens to construct — because the validator was written by someone who had already met
the boundary.

### The third audit question

Two questions had been extracted from this PR's failures: *what is the weakest
implementation that passes this?* (criteria that permit too much) and *what would the
correct implementation necessarily do that this forbids?* (criteria that permit too
little). The three rounds above were neither. Those criteria were the right strictness
and encoded **a wrong model of the environment** — that a refresh mutates in place, then
that it replaces only the canonical path. So:

**What does this criterion assume about how the system behaves, and have I measured it?**

"Atomic rename does not follow a symlink" is exactly the kind of fact that decides a
design and reads as too obvious to check. The three questions divide cleanly: too
permissive, too strict, and **true only in an environment that does not exist**. The
third is the one that took three rounds, because a criterion resting on a wrong
environmental premise looks rigorous — it has a mechanism, a discriminator and a passing
test — right up to the moment someone runs the operation it never modelled.

### The spike never asked what already existed

Neither the brief nor this record checked for a codex adapter before specifying one.
There is one: `runtime/adapters/codex-cli/`, registered as the
`'openai-codex-cli'` provider and constructed in production at
`gateway/wiring/build-llm-call-substrate.ts:1353`. Two measurements settled what to
do about it rather than a judgement call:

- **Its resume is dead on the CLI measured here (0.149.1; nothing pins it — see below).** It builds `codex exec --resume <id>`
  (`exec.ts:68`); on 0.149.1 that is `error: unexpected argument '--resume' found`,
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
adapter builds `codex exec --resume <id>` (`exec.ts:68`) and 0.149.1 answers
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
| approvals (found) | never escalating at all, satisfying the "not requested" branch — *fix later reversed: the escalation requirement was deleted outright, see below* |
| startup probe (found) | a stub that accepts `resume` but rejects `sandbox_mode`, failing mid-turn |
| startup probe, again | **no negative case for a missing `resume` subcommand** — the one capability with a measured in-tree breakage was the one the negatives skipped |

Fixes, respectively: a decoy thread created *after* the recorded one so newest ≠
recorded; a behavioural half beside the grep; the bypass-flag exclusion moved to where
sandbox is asserted; an assertion that codex is exec'd directly, not through a login
shell; a rotation through both paths with `islink` re-checked; a different-thread-ids
half asserting overlap; driving a real escalation to completion; and per-key negative
cases proving no turn spawned.

### The one criterion that could not be satisfied at all

Nine of the corrections on this PR made a criterion stricter. One was the opposite
failure and is worth separating: the durable-recall control required the nonce to be
absent from **every file the run can read**, while the nonce must be *persisted* to be
recalled. codex appends each session to a rollout at
`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` — measured in this tree, and written
even for an unauthenticated run (`trident/codex-rotation-io.ts:6-19`) — and that file is
exactly what `resume` rehydrates from, as this spike observed directly when an
app-server was SIGTERM'd and a new one resumed the thread from disk. So the criterion
demanded the nonce be simultaneously persisted and absent from anything readable.
**Nothing could have passed it.**

The substance of the control was right; its *shape* was wrong. "Absent from every file"
is not the claim worth making. The claim is **recall arrives through codex's own
persistence and through no other path** — which means the thread store must be excluded
as the mechanism under test, and the nonce must be asserted *present* there, while
absent from the worktree, the spec items, any adapter-owned state file, and the prompt.
Excluding the store and requiring presence in it is stronger than a blanket ban, because
it pins which mechanism was exercised instead of merely forbidding one alternative.

Worth separating from the other nine because the failure mode is different and less
visible: an over-strict criterion cannot be discovered by asking *what is the weakest
implementation that passes this?* — the answer is "none", and the question does not flag
that as wrong. It needs the companion question, **what would the correct implementation
necessarily do that this criterion forbids?**

Run over the remaining nine, that question caught one more, unprompted. The credential
criterion said the adapter must exec `codex` directly "rather than through a login
shell" — sound for the adapter's own spawn, and impossible if read as a property of the
run, because **codex executes the model's commands through `/bin/bash -lc` itself**,
observed repeatedly in this spike's approval tests. An implementation cannot avoid that
and should not try. Now scoped explicitly to the adapter's own spawn, with the reason
recorded so nobody tightens it back. The two questions are a pair: one finds criteria
that permit too much, the other finds criteria that permit too little, and a section
audited with only the first can still contain a rule no one can obey.

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
- **It is ORDER-DEPENDENT, and the first write-up of this technique did not say so.**
  Measured afterwards, in both directions: **codex names only the FIRST unrecognised
  field, not all of them.** Sentinel **last** → a misspelled real key is named instead of
  the sentinel and the probe catches it. Sentinel **first** → codex names the sentinel,
  the misspelling passes, and the key check is silently disabled while still looking
  green. So the technique is sound only with the sentinel last, and a probe must have a
  structural test that its argv builder places it there — asserting only that the happy
  path reports the sentinel passes a builder that is blind to every real key.
  **"The tool reports every unknown field" was an assumption, not a measurement**, and it
  was the load-bearing one. Anyone reusing this pattern against another tool must measure
  that tool's reporting cardinality first: one-of-N reporting makes a batched sentinel
  probe order-sensitive, and all-of-N makes it order-free. The technique survives the
  correction; the version that did not state the ordering did not.
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
