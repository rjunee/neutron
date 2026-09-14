## 2026-09-14 — Pool cleanup uses publication-time map identity

### What changed

Boot-adoption cleanup now reads the promise the session was published under and deletes only when the pool still contains that exact promise (`runtime/adapters/claude-code/persistent/boot-adoption.ts:1284-1286`). The promise is attached to the session immediately before adoption publishes it (`runtime/adapters/claude-code/persistent/boot-adoption.ts:2816-2818`); cold spawn records the same identity when its promise resolves (`runtime/adapters/claude-code/persistent/spawn.ts:1524-1533`). This binding is publication-time state, not a map read inside a later cleanup callback, so a replacement cannot turn the ownership check into a tautology.

The focused boot-adoption cases cover both directions for both settlements: current fulfilled and rejected entries are deleted, while fulfilled and rejected replacements survive (`runtime/adapters/claude-code/persistent/__tests__/boot-adoption-pool-identity.test.ts:16-62`). The child-exit suite already present on the base exercises a replacement landing while the old promise is awaited and the complementary current-entry delete (`runtime/adapters/claude-code/persistent/__tests__/child-exit-pool-identity.test.ts:196-253`); it also covers rejected current and stale entries (`runtime/adapters/claude-code/persistent/__tests__/child-exit-pool-identity.test.ts:96-167`).

### Enumeration and decision

Every production occurrence was enumerated with `rg -n 'pool\\.delete\\(' runtime/adapters/claude-code/persistent --glob '*.ts' --glob '!__tests__/**'`. A second alternation searched value comparisons and supplied map-identity positive controls: `rg -n '(Bun\\.peek\\([^)]*\\).*===.*pool\\.delete|pool\\.get\\([^)]*\\) === .*pool\\.delete)' runtime/adapters/claude-code/persistent --glob '*.ts' --glob '!__tests__/**'`. It found the map-identity controls in child-exit, boot adoption, and spawn (`runtime/adapters/claude-code/persistent/child-exit-wiring.ts:170`; `runtime/adapters/claude-code/persistent/boot-adoption.ts:1286`; `runtime/adapters/claude-code/persistent/spawn.ts:986`, `runtime/adapters/claude-code/persistent/spawn.ts:1458`, `runtime/adapters/claude-code/persistent/spawn.ts:1472`, `runtime/adapters/claude-code/persistent/spawn.ts:1539`) and no remaining value-comparison delete.

The two unconditional production deletions are different operations rather than copies of the awaited cleanup idiom: supervision requests immediate eviction through its `evictPool` operation (`runtime/adapters/claude-code/persistent/supervision.ts:158-160`), while shutdown deliberately drains every entry by iterating the map (`runtime/adapters/claude-code/persistent/pool.ts:1048-1055`). Test-only deletes are fixture cleanup and were excluded by the production glob.

This creates no new error, verdict, state, or refusal, so no outcome vocabulary changes. The continuously maintained invariant is that a session's `pooledAs` identity is assigned at publication and later cleanup compares the live map against it (`runtime/adapters/claude-code/persistent/boot-adoption.ts:2816-2818`; `runtime/adapters/claude-code/persistent/spawn.ts:1524-1539`; `runtime/adapters/claude-code/persistent/boot-adoption.ts:1284-1286`). Cleanup therefore does not depend on the exiting child or failed adoption pass still owning the current map entry.

### Mutation evidence

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Boot-adoption map identity at `runtime/adapters/claude-code/persistent/boot-adoption.ts:1286` | Replaced `pool.get(sessionKey) === ownEntry` with resolved-session identity; the printed landed line was `if (ownEntry !== undefined && (Bun.peek(ownEntry) as ReplSession) === session) pool.delete(sessionKey)` and the diff was shown before the run. | Focused boot-adoption suite: 2 pass, 2 fail; the fulfilled replacement was evicted and the current rejected entry remained. | 4 pass, 0 fail. |
| Child-exit map identity at `runtime/adapters/claude-code/persistent/child-exit-wiring.ts:170` | Restored value identity as `if ((await ownEntry) === session) pool.delete(sessionKey)`; the landed line and diff were printed before the run. | Child-exit identity suite: 3 pass, 5 fail, including stale fulfilled replacement eviction. | 8 pass, 0 fail. |
| Child-exit current-delete arm at `runtime/adapters/claude-code/persistent/child-exit-wiring.ts:170` | Replaced deletion with `return`; the landed line and diff were printed before the run. | Child-exit identity suite: 6 pass, 2 fail; current fulfilled and rejected entries remained. | 8 pass, 0 fail. |

### Verification

- `bun test runtime/adapters/claude-code/persistent/__tests__/boot-adoption-pool-identity.test.ts runtime/adapters/claude-code/persistent/__tests__/child-exit-pool-identity.test.ts` — 12 pass, 0 fail.
- `bash scripts/ci/typecheck-all.sh` — all 51 TypeScript configurations passed. The requested `bun run typecheck` is not defined, so the repository's documented matrix was used (`CONTRIBUTING.md:77`).
- `bash scripts/ci/lint.sh` — all lint guards passed.

### Deliberately not changed

The already-correct child-exit implementation was not rewritten (`runtime/adapters/claude-code/persistent/child-exit-wiring.ts:161-170`). Supervision eviction and whole-pool shutdown draining were not identity-guarded because their contracts intentionally select the current key or every key (`runtime/adapters/claude-code/persistent/supervision.ts:158-160`; `runtime/adapters/claude-code/persistent/pool.ts:1048-1055`). No product decision in `SPEC.md` or a spec item changed.
