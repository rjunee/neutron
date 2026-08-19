## 2026-08-18 — The as-built log gets ONE writer: branches stage entries; the outer loop folds them onto main

`docs/AS_BUILT.md` is a newest-first append-only log, so every build prepended
its entry at the same offset and any two open PRs conflicted by construction.
The tracked `merge=union` floor could not help where it mattered: GitHub never
runs merge drivers server-side, so the file merged cleanly locally while the
mergeability check reported CONFLICTING (measured 2026-08-17: 26 of 33 open
PRs, re-reddening after every landing).

Builds no longer touch `docs/AS_BUILT.md`. A branch stages exactly one entry as
`.trident/as-built/<branch>.md` — a unique path per branch, so concurrent PRs
cannot collide — and after the merge lands, the outer loop (the one owner of
GitHub operations, already serialised by merging) folds every staged entry into
the log directly on main, oldest-landed first, deleting the consumed staging
file in the same commit. A bounded per-tick catch-up folds anything the
post-merge pass missed, so a restart or credential blink self-heals. Heading
uniqueness survives via the first free ` (n)` retitle; the parser and fold live
in `trident/as-built-log.ts`, and `scripts/git/as-built-heading-uniqueness.ts`
remains the shape contract on the file.

A CI guard (`scripts/ci/as-built-write-guard.sh`) fails any PR whose diff names
`docs/AS_BUILT.md`, and the machinery that existed only to survive branch-side
writes — the union attribute, the entry-aware merge driver and its installer,
and the governed-attributes gate — is retired. `docs/AS_BUILT.md` remains the
one canonical place to READ the log; the staging directory is a consumed queue,
never a second log.

(Note: this entry describes the card's full end state including tasks 5–7, which land on this same branch before merge; task 7's checklist includes re-verifying this text still matches reality.)
