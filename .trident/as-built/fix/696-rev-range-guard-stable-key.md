## 2026-09-14 — rev-range survivor identity is stable across unrelated line movement

### What changed

`OUT_OF_REACH` now identifies each prompt or shell-wrapper survivor with its file and a
distinctive fragment of its command text (`trident/diff-base-option-shaped.test.ts:955-970`).
`stableSite` resolves scanned hits to those identities, and `rangeGuardFailures` combines the
existing unshielded-command verdict with an exact sorted multiset comparison
(`trident/diff-base-option-shaped.test.ts:1056-1083`). The current inventory was enumerated by
the existing `MODULES` scan and re-pinned one-for-one; production command files were not edited.

The command-text choice survives insertions elsewhere in a file. It cannot distinguish two
identical fragments in the same file, but duplicates are retained in the comparison rather
than deduplicated, so adding or removing one still changes the multiset
(`trident/diff-base-option-shaped.test.ts:1063-1081`). Diagnostics retain `file:line`; only
identity changed (`trident/diff-base-option-shaped.test.ts:1056-1060`).

### Decisions and continuous enforcement

Command text was chosen over enclosing function names because several survivors live inside
prompt templates rather than named functions. The maintained invariant is that every scanned,
non-prose survivor corresponds to exactly one argued inventory member, while every unshielded
or unattributable range remains an offender. `rangeGuardFailures` maintains both halves on every
test run without relying on the changed shell or prompt command to report itself
(`trident/diff-base-option-shaped.test.ts:1068-1083`). This adds no runtime outcome, so there is
no production error taxonomy or default behavior to extend.

The normative item now describes the stable identity and its deliberate limitation
(`docs/spec-items/resolve-the-review-diff-base.md:93-104`,
`docs/spec-items/resolve-the-review-diff-base.md:367-374`).

### Tests and mutation evidence

The three acceptance properties are separate cases
(`trident/diff-base-option-shaped.test.ts:1205-1227`). Each mutation was printed with `nl`,
diffed before execution, run against only its named case, then restored:

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| New unshielded range | Replaced offender collection at line 1076 with an empty array | 0 pass, 1 fail | focused acceptance run: pass |
| Shielded site disappears | Inverted the set inequality at line 1079 | 0 pass, 1 fail | focused acceptance run: pass |
| Shielded site moves | Added `hit.line` to the identity at line 1071 | 0 pass, 1 fail | focused acceptance run: pass |

Verification after restoration: `bun test trident/diff-base-option-shaped.test.ts` passed
42/42; `bunx tsc -p trident/tsconfig.json --noEmit` passed; `bash scripts/ci/lint.sh` passed
all reported gates, including its diff-base scan of 130 files.

### Deliberately not changed

No rev-range command, shield marker, scan surface, exception reason, feature flag, or alternate
code path changed. The worktree diff was enumerated with `git diff --name-only` before this
record and contained only the test and its existing normative spec item; this record is the
required staging addition. The historical measurement at
`docs/spec-items/resolve-the-review-diff-base.md:495-500` remains a dated diagnostic citation,
not a site identity, so it stays unchanged.
