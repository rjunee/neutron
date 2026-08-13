---
name: skillify
description: |
  Turn an ad-hoc capability into a durable, tested, discoverable SKILL PACK via a
  ten-artifact checklist. Also decides the prior question — whether the thing should
  be a skill at all, or a CONVENTION instead.
  ALWAYS use this skill whenever the owner says ANY of these or anything similar:
  "skillify <X>", "skillify this/it", "turn this into a skill", "make a skill for X",
  "make this a permanent skill", "create a skill pack", "lock this in as a skill",
  "we keep re-doing this, make it a skill", "this should be a skill".
  ALSO use it when the owner asks whether something SHOULD be a skill, or asks the
  difference between a skill and a convention.
  The ONLY sanctioned path to a new skill pack — never hand-author a SKILL.md
  without walking this checklist, because a pack that skips steps is code that
  happens to work today rather than a skill.
  NOT for: invoking an existing skill (just invoke it); writing a one-off script
  (write the script); recording a decision or house style (that is a CONVENTION —
  see § Convention or skill, below).
license: MIT
compatibility: claude-code
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# Skillify — turn a capability into a durable skill pack

Adapted from the "Skillify Manifesto" ten-step checklist. The value is not the
checklist's length; it is that each step closes a specific way a skill silently
fails. Skipping one does not make the pack 90% good — it makes it a script with a
markdown hat.

## Convention or skill — answer this FIRST

This instance has **two** places a durable capability can land, and choosing wrong is
the most common mistake:

| | **Convention** | **Skill pack** |
|---|---|---|
| Is | prose, injected into every LLM call | code + tests + trigger phrases |
| Lives in | `<owner_home>/skills/conventions/<name>.md` | `skills/<name>/SKILL.md` in this repo |
| Created by | Skill Forge proposes it, the owner approves | this checklist |
| Right for | a decision rule, a house style, "prefer X over Y", a fact the model must not re-derive wrongly | deterministic work the model keeps re-deriving in latent space |

**A capability earns a SKILL when:** it has been used at least twice · it has a
recurring failure mode (the same mistake keeps happening) · it does DETERMINISTIC
work — time math, parsing, an API call with a deterministic result, a DB lookup —
that the model keeps attempting in latent space · or it encapsulates a non-obvious
decision rule *that needs code to enforce*.

**It is a CONVENTION when** the whole content is a rule a competent reader would
follow correctly if simply told it. Wrapping a sentence in nine artifacts is waste;
leaving deterministic work as prose leaves the model re-deriving it every call and
getting the tail wrong.

**And if it is genuinely one-off: write the script. Do not skillify.**

## The ten artifacts

Each step has a deliverable and a "done when". Mark a deferred step `TODO` with a
reason — never silently.

### 1 — `SKILL.md`, the contract

Path: `skills/<name>/SKILL.md`. Discovery is DIRECTORY-BASED — `agent-skills.ts`
mirrors every pack in this repo's root `skills/` into the live agent's project skills
dir, so a new directory is discovered with no registration step and no manifest to
update.

The `description` block **is the resolver.** The model matches on it at runtime, so a
coverage gap is a silent skill-miss — the skill simply never fires and nobody sees an
error.

**Routing safety beats brevity. Never trade trigger COVERAGE for tokens.** A skill
that stops firing costs far more than the tokens it saved. Compress by
CHARACTERISING the trigger space ("ANY request to be reminded at a future or
recurring time") rather than enumerating thirty phrases; enumerate explicitly only
where a characterisation would plausibly miss. Include a `NOT for:` clause naming the
neighbours — that is what stops two packs fighting.

**Done when:** the file exists, the frontmatter parses, and the pack directory is
committed.

### 2 — Deterministic code

Path: inside the owning workspace package (`<package>/<name>.ts`), exported through
its `index.ts`. Not a shell script — this is a TypeScript workspace, and code that
lives in a package gets the typechecker, the test runner and the lint gates for free.

This is the part the model should NOT be doing in latent space: time math, parsing,
deterministic API calls, DB reads, diffing.

- One responsibility. Multiple operations get explicit modes, not overloaded
  behaviour.
- Deterministic in, deterministic out. Stderr for diagnostics.
- No silent network calls — document every external service touched.
- Credentials come from the secrets/API-key store, resolved in the calling process
  and passed to a child's environment. **Never into a prompt, never into argv.**

**Done when:** it runs against real input and returns the expected output.

### 3 — Unit tests

Path: co-located `<name>.test.ts` or `__tests__/<name>.test.ts`, picked up by the
repo's sharded runner.

Every pure entry point gets one. The bug shape to aim at is small and boring: a
parser that silently drops a field, an off-by-one on a window boundary. Assert the
RESULT, not that a function was called.

**Done when:** green, and every entry point is covered. Check the test COUNT went up —
an `await` inside a `describe` body silently drops the whole block while still
reporting zero failures.

### 4 — Integration test against something real

Hits the live surface with real data, catching what clean fixtures hide. Run on
demand rather than on every commit when it costs money or time; tag it with the cost
so the operator knows what verifying costs.

**Done when:** it passes against the real system, and its cost is written down.

### 5 — Behavioural evals

Path: `skills/<name>/evals.md`. Sample inputs plus the expected agent behaviour,
including at least one BAD case where the right answer is to refuse or ask.

**Done when:** at least one good and one bad case are documented with expected
behaviour.

### 6 — Resolver-coverage check

Re-read the description and ask how else a person would phrase this.

**The empirical heuristic, which beats introspection: search the transcript history
for the moments the owner swore.** Those are the turns where a request did not route.
Also scan for failed ATTEMPTS at the capability — the phrasings that produced
flailing instead of an invocation.

**Done when:** at least five trigger variants are covered, by characterisation or
explicit phrase.

### 7 — Trigger eval, WITH negative cases

Path: `skills/<name>/triggers.eval.md`.

```markdown
## Should fire
- "skillify this thing we keep redoing" → skillify

## Should NOT fire
- "what skills do I have?" → conversational, no skill
- "remind me to skillify that later" → remind, NOT skillify
```

The negatives are the half people skip, and they are what stops a greedy description
swallowing a neighbour's traffic.

**Done when:** at least three positive and two negative cases exist.

### 8 — DRY audit

Run `grep -rl "ALWAYS use" skills/` and compare trigger surfaces against every
existing pack, plus the owner's approved conventions in
`<owner_home>/skills/conventions/`. Resolve every overlap explicitly: merge
duplicates, add a disambiguating `NOT for:` clause, or extract a shared helper.

**Done when:** no ambiguous overlap remains, and each resolution is justified in the
body.

### 9 — End-to-end, through a REAL invocation

**Use the repo's PTY end-to-end runner, not a one-shot headless invocation.** The
persistent-REPL substrate is how this product actually runs an agent turn, so a
one-shot process proves a different code path than the one owners use. Drive a real
turn with a fixture message that should fire the skill, and assert the SIDE EFFECT —
the file written, the row inserted, the message delivered — not that the transcript
mentions the skill.

**This is the step that makes the other eight mean something**, and the one a rushed
port drops. A pack that has never fired in a real session is untested no matter how
green its unit tests are.

**Done when:** a real turn fires the skill and the side effect is observed.

### 10 — Memory-filing rules

State what the skill reads and writes in this instance's memory layer:

- **GBrain / entity pages** — does it create or update memory?
- **`<owner_home>/skills/conventions/`** — does it add or amend a convention?
- **`project.db`** — does it mutate project state, tasks, reminders, work items?
- **The transcript** — what does it leave behind for a later session to find?

If it writes nowhere, say so explicitly. **Default to "writes nothing"** — an
unstated write is how a capability quietly becomes a second writer of a fact that
already has one.

**Done when:** the section exists and reads/writes are enumerated.

## Public-repo constraints

This repo is PUBLIC and permanent.

- No owner PII anywhere in a pack — not in prose, examples, fixtures, or commit
  messages. Use `owner`, and `*.example.com` for hosts.
- No real hostnames, no filesystem-absolute paths containing a username.
- The leak gate enforces this on every push; a pack that trips it does not ship.

## Worked example — is this a skill?

*"We keep re-deriving which reminder window a timestamp falls into and getting the
timezone wrong."* → Deterministic (date math), recurring failure mode, used
constantly. **Skill.** Steps 2 and 3 are the whole point; the code makes the error
impossible rather than discouraged.

*"Always prefer the fast model for background classification."* → A decision rule a
reader would follow correctly if told. **Convention.** Nine artifacts around one
sentence would be pure ceremony.

*"Export this one deck to a slide deck for tomorrow's meeting."* → One-off. **Write
the script.**
