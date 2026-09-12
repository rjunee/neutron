---
title: Keep denylisted identities out of merge commit messages
group: security
status: open
priority: P1
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**Every squash-merge writes owner PII into the public repo's history, and the gate that
should catch it only sometimes looks far enough back** (measured 2026-08-14 while landing
#259). The agent's configured git identity in the code checkout is an address on the OWNER
PII DENYLIST. GitHub's squash-merge composes the merged commit message and appends a
`Co-authored-by:` trailer built from the authors of the squashed commits — so that address
lands in `main`'s commit messages on merge. **12 of the last 40 commits on `main` carry it.**
Nothing in the tree is wrong; the leak is in the MESSAGES, which no tree scan inspects.
**The gate is non-deterministic, which is the worse half.** `purity` failed on one CI run for
PR #259 with `[pii-denylist-msg]` and PASSED on a re-run of the same head — the commit-message
window is `LEAK_GATE_BASE_SHA..HEAD` (`ci.yml`), and that base resolves differently per event
(`pull_request.base.sha` vs the `github.event.before` fallback, which is all-zeros on a
branch's first push). So the same commits are in scope or out of scope depending on how the
run was triggered. A gate whose verdict depends on how far back it happened to look does not
tell you the tree is clean — and it trains the reader to re-run until green, which is the
exact reflex that lets a real finding through.
Acceptance, in two independent parts:
(a) A merge cannot introduce a denylisted address into a commit message. Fix the SOURCE —
    the identity the agent commits under — rather than teaching the gate to ignore the
    trailer; an allowlist here would suppress the true positives too.
(b) The commit-message window is DETERMINISTIC for a given head: the same commits are scanned
    whatever event triggered the run, and an unresolvable base FAILS rather than silently
    scanning a different range. Assert a re-run of an identical head cannot change the verdict.
NOTE the existing history is NOT in scope here and must not be quietly rewritten: `main` is
protected, the commits are merged, and rewriting shared history is an owner decision with
consequences for every open branch. Decide it explicitly; do not let a fix for (a) grow into
a history rewrite.

## Acceptance

- [ ] A merge cannot introduce a denylisted address into a commit message, fixed at the
      SOURCE — the identity the agent commits under. An allowlist for the trailer fails
      this criterion, because it would suppress the true positives too.
- [ ] The commit-message scan window is DETERMINISTIC for a given head: the same commits
      are scanned whatever event triggered the run. Assert that a re-run of an identical
      head cannot change the verdict.
- [ ] An unresolvable base FAILS the gate rather than silently scanning a different range.
      A mutant that falls back to a narrower range must go red, not green.
      verify: `bash scripts/ci/leak-gate.sh` against a fixture with an unresolvable base
- [ ] Existing merged history is NOT rewritten by this change. Assert the diff touches no
      commit already on `main`.
