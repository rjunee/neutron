---
title: Work tracking — the Neutron standard
status: standard
version: 1.0.0
applies_to: every Neutron coding repository
last_updated: 2026-09-12
---

# Work tracking — the Neutron standard

This file ships with Neutron and is **identical in every Neutron coding
repository**. It is the single description of how work is captured, specified,
built and recorded. A repository adopts it by copying this file to
`docs/process/work-tracking.md` and pointing its agent entry point at it — a root
`AGENTS.md` where the repo allows one, otherwise `CONTRIBUTING.md` plus the
per-directory `AGENTS.md` convention. (This repository reserves the root
`AGENTS.md` path as a leak-gate tripwire, so it uses the latter shape.)

It is harness-agnostic on purpose: Claude Code, Codex and anything else Neutron
orchestrates all read the same rules. The `work-tracking` skill invokes it.

If you are an agent working in any Neutron repo: this document binds you. Read §2
and §3 before starting work, and §4 before writing an as-built record.

---

## 1. The principle

**One owner per fact.** Every rule below follows from it.

One document doing several jobs — architecture spec, decision log, task queue,
status board — makes all of them worse, because they have different lifetimes and
different readers. Split by owner, not by topic.

## 2. The three layers

| Layer | Owns | Lives in | Cost to add |
|---|---|---|---|
| **GitHub Issues** | Work *state* — open, prioritised, blocked, done | github.com | Seconds. No PR, no CI. |
| **`docs/spec-items/<slug>.md`** | *Normative content* — the detail and the acceptance criteria | the repo | A PR. Deliberately. |
| **`docs/as-built/<slug>.md`** | *What shipped* — root cause, evidence, built vs planned | the repo | Written by the PR that earns it |

And one prohibition, as important as the three layers:

> **No ad-hoc tracking files.** No `TODO.md`, no `POST_DEMO.md`, no wave boards, no
> `RESUME-STATE.md`. Every one starts as a convenient scratchpad and becomes a
> second queue that disagrees with the first. If work is being tracked, it is
> tracked above.

Most issues never become spec-item files. That is the point: the file count grows
only with work that earns full specification.

### Lifecycle

```
thought → GitHub issue (label: needs-spec)        seconds, no PR, no CI
        → agent investigates repo, interviews owner, rewrites issue body
        → label removed                            ← buildable from here
        → docs/spec-items/<slug>.md  ONLY IF "done" must be enforceable
        → branch → PR ("Closes #N") → merge
        → docs/as-built/<slug>.md, written by that PR
```

## 3. The four rules

**3.1 Work never starts from a bare title.** A title keeps a thought from being
lost; it is not a work order. An issue must say what the change is, where it
lands, and how anyone would know it worked, before a branch is cut. This prevents
building from an invented specification, and retrofitting a spec to the diff.

**3.2 Specifying is the agent's job, not the owner's.** The owner captures
one-line thoughts. Turning them into something buildable is always agent work:
investigate the repo first (most questions are answerable from the code), then
interview the owner in a batch for what the repo cannot answer, then rewrite the
issue body with what you found *and the owner's answers*, then remove
`needs-spec`.

> **Never remove `needs-spec` by guessing.** If a question could not be answered
> from the repo and was not put to the owner, the issue is still unspecified no
> matter how much confident prose the body now contains. A fluent invention is
> worse than a blank body, because the blank one is visibly unfinished. Blocked on
> an unavailable owner is a legitimate resting state — leave the label on and put
> the open question at the top.

**3.3 Acceptance criteria live in the repo, never in the issue.** An issue body
can be edited by anyone with no PR, no review, no CI and no diff. A criterion that
can change without a trace is worthless. In-repo criteria make weakening *visible*
in a reviewed diff. Write them bidirectionally — **a criterion that a broken
implementation would also satisfy is not a criterion** — and name the check where
one exists:

```markdown
## Acceptance
- [ ] The citation renders the served `source_ref`, never the SHA-256.
      verify: pytest packages/ne-console -k citation_source_ref
```

**3.4 One queue, not two.** There is exactly one queue: `docs/spec-items/`.
GitHub Issues is not a second queue — it is the **inbox**. A thought lands there
in seconds; if it earns specification it is *promoted into* a spec item, never
copied into one. If you are maintaining a list of work anywhere else, that is the
bug.

The two layers answer different questions and never disagree, because an item
exists in exactly one of them at a time:

| | GitHub Issues (inbox) | `docs/spec-items/` (the queue) |
|---|---|---|
| Holds | unspecified thoughts | specified, buildable work |
| Answers | "what has been raised?" | "what are we building, and what is done?" |
| Leaves by | being promoted, or closed as won't-do | being built and recorded in as-built |

## 4. The as-built record — one writer, permanent shards

This section is the part that is **not** inherited from general practice. It is
Neutron's own, and it is the answer to a failure every agent-written repo hits.

### The failure

An as-built log kept as one append-at-the-top monolith has two compounding costs.
Every branch prepends at the same offset, so any two open PRs conflict *by
construction* rather than by subject. And because GitHub never runs merge drivers
server-side, no local driver fixes the mergeability check. Teams work around this
by landing bookkeeping-only commits, each firing a full CI suite.

Measured in a sibling Neutron repository that kept a monolith (2026-08-01 → 08-26): **386 of 1,367 commits
touched only the as-built log**, at roughly 36 minutes of runner time each.

### The rule

1. **One file per record.** `docs/as-built/<slug>.md`, matching the spec-item slug
   where one exists. Never a shared monolith.
2. **The record ships in the PR that earns it**, not in a follow-up commit.
3. **Nothing else writes it.** A CI guard fails a PR whose diff edits a frozen
   monolith or another branch's record.
4. **Freeze, never convert, an existing monolith.** Leave it verbatim at its old
   path so every existing citation still resolves, and start the directory beside
   it. Converting rewrites history that other documents cite.
5. If a monolith must survive for a transition, give it
   `<path> merge=union` in `.gitattributes`. `union` takes both sides of a
   conflicting hunk instead of raising. It is correct **only** for append-only
   files: union never reports a conflict, so a change that rewrites existing lines
   is silently doubled. Never apply it to a file that gets restructured.

### The evidence

This repository adopted rules 1–3 and 5 (staging entries per-branch and bundling
them into the code commit) before this standard existed. Measured over its last
400 non-merge commits:

| | monolithic log | one-writer log |
|---|---|---|
| Commits touching only the as-built log | 386 of 1,367 | **5 of 400** |
| As-built bundled into the commit that earned it | — | **164 of 400** |

That is the whole result: bookkeeping commits stop existing, because the record
rides the change it describes.

**Graded honestly.** Rules 1–3 and 5 are PROVEN at the numbers
above. Rule 4 (permanent shards, frozen monolith) is **NEW and unproven** — it is
the natural completion of the pattern and it removes the remaining monolith, but
no repository has yet run a full quarter on it. Grade it as adopted-not-proven in
your repo's status table until it has.

### Why a monolith looks fine until it isn't

It grows without bound (both Neutron logs reached ~2 MB before sharding), and nothing about
it fails loudly. The cost lands on CI minutes, on rebases, and on the token budget
of every agent that has to read it to answer "where are we". Shard before the open
PR count is high: **every in-flight PR writes to the as-built record**, so moving
it mid-flight means rebasing all of them. Do it at a low-water mark.

## 5. Adoption order

Each step is independently valuable and reversible. There is no flag day.

1. **One file per work item.** Split the monolithic queue into
   `docs/spec-items/<slug>.md`. Frontmatter carries `title`, `group`, and any
   frozen legacy number. **A slug is immutable once merged** — identity is the
   filename, so renaming destroys one item and creates another while every
   external reference still points at the old name. Retitle via `title:`.
   **Build the rollup index in the same change** (see §6).
2. **As-built sharding** (§4). Do this at a low open-PR count.
3. **GitHub Issues as the inbox.** Create the `needs-spec` label and route new
   one-line thoughts there.

   **Migrate the backlog as FILES; never bulk-create ISSUES.** These are
   different acts and only one is safe:

   - *Migrating the backlog into `docs/spec-items/` is required* — it is step 1,
     it is a text relocation, it lands in one reviewable diff, and it asserts
     nothing new. Do the whole backlog. Leaving half of it behind is what
     produces two queues.
   - *Bulk-creating issues from that backlog is forbidden.* Creating an issue
     asserts "this is open"; closing one asserts "this shipped". Those facts are
     usually smeared across contradictory prose, and a wrong seed launders
     guesswork into machine truth — permanently and invisibly.

   Nothing is ever closed without a corresponding as-built record and a merge
   SHA; anything unprovable stays open.
4. **`## Acceptance` sections** on items whose "done" will be disputed. Not all of
   them — the ones that will be argued about.
5. **The spec diet.** Once the queue has moved out, the spec shrinks to what it
   should have been: architecture, constraints, decision log.

**CI change classes are OPTIONAL and repo-specific.** Skipping heavy jobs on a
docs-only diff is worth it only where bookkeeping commits are frequent. A repo
that has adopted §4 has few of them, so the benefit is small — and where a repo
runs a **prose-scanning gate** (secret/PII/leak detection that reads documents and
commit messages), a docs-only diff is *precisely* when that gate matters most.
Never let a change class skip such a gate. See the §6 trap.

## 6. Traps

**CI path filters deadlock required checks.** A workflow filtered out by `paths:`
leaves its required checks Pending forever, blocking the merge. Use a **job-level
`if:`** instead — a skipped job registers a check run whose conclusion satisfies
the required context.

**That same property is a loaded gun.** A skipped required check is
indistinguishable from a passed one at the merge button. A classifier must **fail
open in every direction**: a crash, an unknown event type, a missing base ref, or
a force-push with no computable range must all run the full suite. Only an
affirmative, fully-parsed docs-only diff may skip anything. Exclude `.github/**`,
tooling paths and lockfiles.

**A guard living inside a job makes that job unskippable.** Put always-on guards
in their own small job from the start, or docs PRs get cheaper but never faster.

**Don't promise an index you haven't built.** Splitting a monolith into dozens of
files without a rendered index gives you all the cost and none of the benefit.
Either build the rollup in the same change, or make it a query against something
that already exists.

**Beware the second queue arriving as a "temporary scratchpad."** It never is.

**Two people can read the same ruling opposite ways.** Write rulings down with
their scope stated explicitly, and name what they do **not** overturn.

## 7. Provenance

§2, §3, §5 and most of §6 are adopted from a sibling Neutron repository's consolidated work-tracking design (2026-09-12), which in turn adopts
Kubernetes' KEP machinery — a directory per item, validated frontmatter, ratcheting
CI validation, rendered indexes.

§4 is Neutron's own and is the part with no established
practice elsewhere: the industry default is "the PR is the record."

Changes to this standard are made once and propagated to every repo. Do not fork
it per-repo; a per-repo exception belongs in that repo's `AGENTS.md`, naming this
file and the clause it departs from.
