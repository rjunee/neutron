## 2026-09-12 — work tracking becomes a shipped standard, not a per-repo habit

Every Neutron coding repository had been inventing its own answer to "where does
work live", and the answers disagreed. This repository's `SPEC.md` was 1,292 lines
of which **817 were `Phases → Steps`** — a task queue living inside a
specification — leaving 147 lines (11%) that were actually spec. A sibling repo
independently hit the same wall from the other direction and measured the cost:
one document doing four jobs, 94% of it queue-and-log.

The fix is not a better document. It is **one owner per fact**, split into three
layers with different lifetimes: issues own work *state*, `docs/spec-items/` owns
*normative content*, as-built records own *what shipped*. That split is adopted
from the sibling repo's design, which in turn adopts Kubernetes' KEP machinery —
a directory per item, validated frontmatter, ratcheting CI validation, rendered
indexes. It is not invented here, and the provenance is recorded in the standard.

One clause IS ours, and it is §4. An as-built log kept as a single
append-at-the-top monolith makes any two open PRs conflict *by construction*:
every branch prepends at the same byte offset, and GitHub never runs merge drivers
server-side, so no local driver repairs the mergeability check. The sibling repo
paid for this in bookkeeping commits — **386 of 1,367 touched only the log**, each
firing a full suite. This tree had already solved it before the standard existed,
by staging one entry per branch and bundling it into the commit that earned it:
measured over the last 400 non-merge commits, **5** touched only the log and
**164** carried the record alongside its own code. That result, and the rule that
produces it, is now written down where other repositories can adopt it.

The standard ships three ways because three kinds of reader need it.
`docs/process/work-tracking.md` is normative and harness-agnostic — Codex and
Claude Code read the same rules. `skills/work-tracking/SKILL.md` is the invocable
entry point, deliberately a pointer rather than a second copy, with the standard
named as the winner if they ever disagree. `CONTRIBUTING.md` carries the
human-facing pointer.

The obvious fourth place — a root `AGENTS.md` — was attempted and is correctly
impossible. `FORBIDDEN_EXACT` in `scripts/ci/leak-gate.sh` reserves
`STATUS.md ISSUES.md CLAUDE.md AGENTS.md` at the root as carve tripwires against
a private sibling repository's root docs re-entering this public tree, and the
gate refused the commit. The per-directory `AGENTS.md` convention this tree
already uses (`app/`, `auth/`, `cores/…`) is the sanctioned shape, and module
rules sit on top of the standard rather than restating it.

The same change corrects a false statement in `CONTRIBUTING.md`, which claimed
"CI fails any PR whose diff touches the file". It does not: the guard was written
as a hard failure and deliberately downgraded to advisory on 2026-08-19, after
measuring that of 45 open PRs, 31 touched the log and 34 had conflicts but zero
were blocked solely by it. Prose asserting a guard the code does not implement is
the precise failure this repository's own architecture notes warn about, and it
had been standing since the downgrade.

One ambiguity in the source design was resolved rather than inherited. It advised
against bulk-seeding an existing queue, which reads as licence to run two queues
until the old one drains — directly contradicting its own "one queue, not two"
rule. The distinction that actually matters is the act, not the timing:
**migrating a backlog between repository files is safe and required**, because it
relocates text in one reviewable diff and asserts nothing new; **bulk-creating
issues is forbidden**, because creating an issue asserts "this is open" and
closing one asserts "this shipped", and a wrong seed launders guesswork into
machine truth permanently. Issues are the inbox; `docs/spec-items/` is the queue;
an item is in exactly one of them at a time.

Graded honestly, per the standard's own instruction to grade: rules 1–3 and 5 of
§4 are proven at the numbers above. Rule 4 — permanent shards with the old
monolith frozen verbatim rather than converted — is new and unproven here, and is
marked as such in the text. The adoption itself is deliberately staged: this
change lands the standard only. Splitting `Phases → Steps` into spec items, and
retiring the monolith, are separate changes on separate lanes, because both edit
files this one does not touch and two lanes on one file is what produced four
mutually conflicting PRs on 2026-08-18.
