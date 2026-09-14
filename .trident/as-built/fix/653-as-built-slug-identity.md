## 2026-09-14 — as-built slug identity is documented as a convention

### What changed

The as-built directory guide and binding work-tracking standard now describe reuse of a spec-item slug as a naming convention, not an identity guarantee. The guide states the write guard's actual boundary: it validates a shard's path and record shape but does not infer which spec item belongs to a change.

### Evidence and decision

`docs/as-built/README.md:11-15` previously promised a shared identity, while `scripts/ci/as-built-write-guard.sh:229-276` only validates added paths and headings. The removed promoter surface is moot: an `rg` file enumeration over all TypeScript and MJS files outside dependencies found no file containing any of the four deleted names from the issue, while the same enumeration found the surviving guard references at `scripts/ci/check-governed-repo-attributes.ts:75`, `scripts/ci/as-built-write-guard.test.ts:25`, and `scripts/ci/ci-workflow.test.ts:521` as positive controls.

Existing records were enumerated with direct `find` listings of `docs/as-built/*.md` and `docs/spec-items/*.md`, excluding each directory README, then compared as sorted filename sets. There are 32 records, 30 spec items, nine exact filename pairs, and 23 records with no same-named current spec item. A fixed-string cross-product search of every current spec slug through every current record found seven explicit same-slug references and zero cross-slug references; those seven matches were the positive control. The corpus therefore contains no observed mismatch to justify introducing a new machine-readable relationship, and the current guard has no reliable input from which to enforce one.

The existing outcome vocabulary is unchanged: the guard still returns pass for valid additions, failure for detected violations, and refusal for indeterminate input as documented at `scripts/ci/as-built-write-guard.sh:31-33`. No new outcome requires classification. The continuously maintained invariant remains merged-record immutability and new-record shape, enforced independently in CI through `scripts/ci/check-governed-repo-attributes.ts:100` invoking the guard.

### Verification and mutation table

No executable guard or test was added or changed, so there is no guard mutation to perform. The documentation correction is checked by the repository's prose and leak gates; their commands and results are recorded after the final run.

| Guard | Mutation | Mutated result | Restored result |
|---|---|---|---|
| None added or changed | Not applicable | Not applicable | Not applicable |

`bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript configurations. `bash scripts/ci/lint.sh` passed every reported lint gate. The focused `bun test scripts/ci/as-built-write-guard.test.ts` run passed 17 tests with zero failures. `git diff --check` passed. `bash scripts/ci/leak-gate.sh` found zero findings in the rules it could run, but exited 3 because the local environment has no out-of-band PII denylist; the gate explicitly reports that result as incomplete rather than clean.

### Deliberately not done

Historical records were not rewritten: `docs/as-built/README.md:33-35` says merged shards are immutable. The deleted staging promoter was not recreated, and no spec-item relationship metadata or dual path was introduced. `SPEC.md` was not changed because it names the sharded record location at `SPEC.md:45` but makes no slug-identity promise.
