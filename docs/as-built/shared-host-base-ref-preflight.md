## 2026-09-25 — Refuse stale host-suite base refs before expensive checks

The shared-host wrapper previously acquired admission and immediately started
typecheck and the full suite (`scripts/check-shared-host.sh:23-34`). The
stale-prose guard later diffs `origin/main...HEAD` through a bounded
`spawnSync` reader (`scripts/ci/stale-prose-guard.ts:98-107`). In the #1321
isolated worktree, the local tracking ref was `84a38af` while the upstream main
was `916bdf86`. Against the branch head `46dc57c`, the stale-base diff was
3,350,611 bytes across 555 matching source and Markdown files; using the
upstream base yielded 6,353 bytes. The large diff exceeded the default child
process output buffer, so the guard failed after the host checks had begun.

The wrapper now verifies its exact `refs/remotes/origin/main` commit against
the upstream `refs/heads/main` tip before typecheck or suite execution. It
follows one local source clone to its upstream, because that clone's `main` can
lag behind its own `origin/main`. The remote lookup has a 20-second limit. It
also sizes the exact diff that the stale-prose guard will read and refuses a
branch whose output reaches 1,000,000 bytes, below the guard's 1 MiB reader
limit. A missing, stale, unreachable, malformed, or oversized base exits with
refusal status 2 and an operator-facing instruction. Verification does not move
refs, and the admitted typecheck and full-suite commands are unchanged.
`file://localhost/` origins resolve to the same local repository as Git itself.
The wrapper also clears inherited `STALE_PROSE_BASE_SHA` and
`STALE_PROSE_HEAD_SHA` before admission, so the consuming guard reads the same
verified `origin/main...HEAD` range as the preflight.

Focused real-Git tests cover a valid base running both gates, missing and stale
tracking refs refusing before either gate, an oversized legitimate branch, a
fetch restoring admission, and the two-hop local-clone topology that exposed
the incident. Tests also check both directions of a `file://localhost/` origin
and run the real stale-prose guard with poisoned inherited range overrides.
Two isolated semantic mutations were killed by the same wrapper tests: restoring
the `file://localhost/` parsing error made its valid-base sibling fail (10 pass,
1 fail), and allowing the inherited guard overrides through made the real
guard sibling fail (10 pass, 1 fail). The existing admission,
selector-clearing, and gate-exit tests still pass: `bun test
scripts/check-shared-host.test.ts` reported 11 pass, 0 fail. `bash
scripts/ci/typecheck-all.sh` passed all 51 TypeScript projects. `bash -n
scripts/check-shared-host.sh` and `git diff --check` passed. The leak gate
reported zero findings when scoped to the three changed files plus the required
license. Its full-tree run found 452 unrelated findings in this worktree and
was not a passing receipt. The GitHub remote was unreachable in this sandbox,
so no real host full-suite result is claimed for this change.
