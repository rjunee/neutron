# Working in this repository

Entry point for any agent — Codex, Claude Code, or anything else Neutron
orchestrates. It points at the rules; it does not restate them. Module-specific
rules live in the per-directory `AGENTS.md` files (`app/`, `auth/`, `cores/…`) and
sit on top of this, never instead of it.

## Work tracking

**[`docs/process/work-tracking.md`](docs/process/work-tracking.md) is binding.**
Read it before starting work and before writing an as-built record. The
`work-tracking` skill (`skills/work-tracking/`) is the invocable entry point.

The short version, which is not a substitute for reading it:

- **One queue: [`docs/spec-items/`](docs/spec-items/README.md)**, indexed by a
  generated rollup. GitHub Issues is the **inbox**, not a second queue. No ad-hoc
  tracking files — no `TODO.md`, no wave boards, no scratchpad that becomes a
  parallel list.
- **Never build from a bare title.** Specifying is the agent's job, not the
  owner's: investigate the repo first, interview the owner in one batch for what
  the repo cannot answer, then rewrite the issue. `needs-spec` is never removed by
  guessing — a fluent invention is worse than a blank body, because the blank one
  is visibly unfinished.
- **Acceptance criteria live in the repo, never in an issue.** An issue body can
  be edited with no PR, no review and no diff, so a criterion there can be
  weakened without a trace.
- **One as-built record per change**, in the PR that earns it.
  `docs/AS_BUILT.md` is FROZEN and a CI guard hard-fails any diff touching it —
  stage yours at `.trident/as-built/<branch>.md`, and see
  [`docs/as-built/README.md`](docs/as-built/README.md).

## Governance

`SPEC.md` is the present-tense current target. Its **Decisions Log is immutable**:
entries are never removed or rewritten, and a superseded decision stays with a
superseding entry above it. Add a dated entry at the top when a decision changes
what the product is; edit the body in place to describe the result. Other docs
reference a decision by date rather than restating it.

`docs/INVARIANTS.md` carries load-bearing invariants. `CONTRIBUTING.md` carries
the contribution rules. `docs/SYSTEM-OVERVIEW.md` describes how it works now.

## Hard rules for this tree

**It is public.** The leak gate (`scripts/ci/leak-gate.sh`, run by CI's `purity`
job) scans files *and commit messages*, and it is fail-closed. Never commit
hostnames, usernames, absolute home paths, private repository names, or owner PII
— in code, prose, comments, or a commit message. A commit message cannot be
redacted once it is mirrored. The gate also reserves three root paths as carve
tripwires against a private sibling repository's root docs entering this tree:
`STATUS.md`, `ISSUES.md`, `CLAUDE.md`.

**No feature flags and no dual code paths — unless a Decisions Log entry records a
deliberate alternative.** A new path replaces the old one and the old one is
deleted. The exception is narrow and has exactly one instance today: the REPL
substrate (Decisions Log 2026-09-12), where herdr is the default container and the
in-process PTY host is RETAINED as a selectable backend. The rule is scoped rather
than dropped because a standing absolute the tree contradicts teaches the next
reader to ignore it — and the exception costs something real: two supported
backends means the shared interface must stay honest about both, which is a sweep,
not a file.

**Every change is a PR from a worktree**, never a direct push to `main`, and CI
must be green before merge.

**Evidence, not assertion.** Every claim about what the code does carries a
`file:line` read in the current session. An absence claim needs a search with a
positive control — a grep that finds nothing proves nothing until you have shown
the same grep finding something.

**A guard must be delivered, not published.** A rule that lives only in prose is
advice to an agent that has never read it; the mechanism that works is a
machine-checked refusal arriving at the moment of the mistake. If you narrow or
remove a guard, grep for every document asserting the old rule and fix them in the
same change — see `docs/agent-legible-architecture.md` § 1.
